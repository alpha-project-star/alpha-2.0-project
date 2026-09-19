import { toast } from "sonner";
import { z } from "zod";
import { getAuth } from "firebase/auth";
import {
  K,
  ChatMessageSchema,
  NoteSchema,
  BillSchema,
  MemorySchema,
  ProfileSchema,
  SettingsSchema,
} from "./alpha-store";
import {
  GoalSchema,
  TaskSchema,
  RunSchema,
  StepSchema,
  ObservationSchema,
  ResultSchema
} from "./execution";
import { sanitizeUserPersonalization } from "./alpha-identity";
import { LocalReminderRepository, FirestoreReminder } from "./reminder-repo";

const STORE_SCHEMAS: Record<string, z.ZodType<any>> = {
  [K.chat]: z.array(ChatMessageSchema),
  [K.notes]: z.array(NoteSchema),
  [K.bills]: z.array(BillSchema),
  [K.goals]: z.array(GoalSchema),
  [K.tasks]: z.array(TaskSchema),
  [K.runs]: z.array(RunSchema),
  [K.steps]: z.array(StepSchema),
  [K.observations]: z.array(ObservationSchema),
  [K.results]: z.array(ResultSchema),
  [K.memories]: z.array(MemorySchema),
  [K.profile]: ProfileSchema,
  [K.settings]: SettingsSchema,
  // summary is unstructured string, no strict schema beyond string
};

const DB_NAME = "alpha.music.v1";
const STORE = "tracks";

export interface AlphaDataExport {
  version: 1 | 2;
  exportedAt: string;
  localStorage: Record<string, string | null>;
  reminders?: FirestoreReminder[];
  music: Array<{
    id: string;
    name: string;
    size: number;
    type: string;
    addedAt: number;
    dataUrl: string;
  }>;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available in this browser."));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Could not open music storage."));
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error || new Error("Failed to read blob"));
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, base64] = dataUrl.split(",");
  const mime = header.match(/:(.*?);/)?.[1] || "audio/mpeg";
  const bin = atob(base64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

export async function exportAlphaData(): Promise<AlphaDataExport> {
  const localStorage: Record<string, string | null> = {};
  for (const key of Object.values(K)) {
    try {
      let val = window.localStorage.getItem(key);
      if (val && key === K.settings) {
        // Scrub secrets
        const settings = JSON.parse(val);
        delete settings.groqApiKey;
        delete settings.openaiCompatKey;
        delete settings.openRouterKey;
        val = JSON.stringify(settings);
      } else if (val && key === K.chat) {
        // Scrub camera/upload base64 data to keep exports slim and clean
        const chat = JSON.parse(val);
        const scrubbed = chat.map((m: any) => {
          if (m.images && m.images.length > 0) {
            return {
              ...m,
              images: m.images.map((img: string) => img.startsWith("data:") && img.length > 200 ? "[image_transient]" : img)
            };
          }
          return m;
        });
        val = JSON.stringify(scrubbed);
      }
      localStorage[key] = val;
    } catch {
      localStorage[key] = null;
    }
  }

  const music: AlphaDataExport["music"] = [];
  try {
    const db = await openDb();
    const rows: any[] = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("Could not read music storage."));
      tx.oncomplete = () => db.close();
    });
    for (const row of rows) {
      if (!row.blob) continue;
      music.push({
        id: row.id,
        name: row.name,
        size: row.size,
        type: row.type,
        addedAt: row.addedAt,
        dataUrl: await blobToDataUrl(row.blob),
      });
    }
  } catch (e) {
    console.warn("Music export skipped:", e);
  }

  const reminderRepo = new LocalReminderRepository();
  const currentUid = getAuth().currentUser?.uid || "local-user";
  let exportedReminders: FirestoreReminder[] = [];
  try {
    exportedReminders = await reminderRepo.listReminders(currentUid);
  } catch (e) {
    console.warn("Reminders export skipped:", e);
  }

  return { version: 2, exportedAt: new Date().toISOString(), localStorage, reminders: exportedReminders, music };
}

export function downloadAlphaData(data: AlphaDataExport) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `alpha-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function importAlphaData(fileOrJson: File | string): Promise<{ restored: string[] }> {
  const text = typeof fileOrJson === "string" ? fileOrJson : await fileOrJson.text();
  const data: AlphaDataExport = JSON.parse(text);
  if (!data || (data.version !== 1 && data.version !== 2)) throw new Error("Unrecognized Alpha backup format.");

  const restored: string[] = [];

  // Remove existing keys to perform an exact replacement (A-192)
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (key && key.startsWith("alpha.")) {
      window.localStorage.removeItem(key);
      i--; // Adjust index after removal
    }
  }

  // Restore localStorage
  for (const key of Object.values(K)) {
    const value = data.localStorage?.[key];
    if (value !== undefined && value !== null) {
      try {
        if (STORE_SCHEMAS[key]) {
          const parsed = JSON.parse(value);
          const result = STORE_SCHEMAS[key].safeParse(parsed);
          if (!result.success) {
            console.warn(`Schema validation failed for ${key} during import:`, result.error);
            throw new Error(`Invalid data in backup for ${key}.`);
          }
          let sanitizedData = result.data;
          if (key === K.settings && sanitizedData?.personaExtra) {
            sanitizedData = {
              ...sanitizedData,
              personaExtra: sanitizeUserPersonalization(sanitizedData.personaExtra),
            };
          } else if (key === K.profile && sanitizedData) {
            sanitizedData = {
              ...sanitizedData,
              bio: sanitizeUserPersonalization(sanitizedData.bio || ""),
              name: (sanitizedData.name || "").replace(/\[\[[\s\S]*?\]\]/g, "").slice(0, 100).trim() || "Creator",
            };
          } else if (key === K.memories && Array.isArray(sanitizedData)) {
            sanitizedData = sanitizedData.map((m: any) => ({
              ...m,
              topic: sanitizeUserPersonalization(m.topic || ""),
              detail: sanitizeUserPersonalization(m.detail || ""),
              provenance: m.provenance || "imported_user_data",
              confidence: m.confidence || "high",
              status: m.status || "active",
              updatedAt: m.updatedAt || Date.now(),
            }));
          }
          window.localStorage.setItem(key, JSON.stringify(sanitizedData));
        } else {
          window.localStorage.setItem(key, value);
        }
        restored.push(key);
      } catch (e) {
        console.warn("Could not restore key:", key, e);
      }
    }
  }

  // Restore reminders into canonical LocalReminderRepository
  const reminderRepo = new LocalReminderRepository();
  const currentUid = getAuth().currentUser?.uid || "local-user";
  if (Array.isArray(data.reminders) && data.reminders.length > 0) {
    for (const r of data.reminders) {
      try {
        await reminderRepo.saveReminder(currentUid, r);
      } catch (e) {
        console.warn("Could not restore reminder:", r.id, e);
      }
    }
    restored.push(`reminders:${data.reminders.length}`);
  } else if (data.localStorage?.["alpha.reminders.v1"]) {
    // Backward-compatible v1 migration
    try {
      const legacyReminders = JSON.parse(data.localStorage["alpha.reminders.v1"]);
      if (Array.isArray(legacyReminders)) {
        for (const lr of legacyReminders) {
          if (lr.title) {
            await reminderRepo.createReminder(currentUid, {
              title: lr.title,
              dueAt: lr.when ? Date.parse(lr.when) || Date.now() + 3600000 : Date.now() + 3600000,
              notes: lr.notes || undefined,
            });
          }
        }
        restored.push(`reminders:${legacyReminders.length}`);
      }
    } catch (e) {
      console.warn("Could not restore legacy reminders:", e);
    }
  }

  // Restore music
  if (data.music?.length) {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      store.clear(); // A-192: exact replacement
      for (const track of data.music) {
        try {
          const blob = dataUrlToBlob(track.dataUrl);
          store.put({
            id: track.id,
            name: track.name,
            size: track.size,
            type: track.type,
            addedAt: track.addedAt,
            blob,
          });
        } catch (e) {
          console.warn("Could not restore track:", track.name, e);
        }
      }
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error || new Error("Could not restore music."));
      };
    });
    restored.push(`music:${data.music.length}`);
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("alpha:reminders-changed"));
  }

  // Reload from localStorage so the live store reflects the import
  if (typeof window !== "undefined" && typeof window.location?.reload === "function") {
    window.location.reload();
  }

  return { restored };
}

export async function wipeAlphaData() {
  const keysToRemove: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (key && key.startsWith("alpha.")) {
      keysToRemove.push(key);
    }
  }
  
  for (const key of keysToRemove) {
    try {
      window.localStorage.removeItem(key);
    } catch {}
  }

  const reminderRepo = new LocalReminderRepository();
  try {
    const currentUid = getAuth().currentUser?.uid || "local-user";
    const existing = await reminderRepo.listReminders(currentUid);
    for (const r of existing) {
      await reminderRepo.deleteReminder(currentUid, r.id);
    }
  } catch {}
  
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error || new Error("Could not clear music."));
      tx.oncomplete = () => db.close();
    });
  } catch {}
  
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("alpha:reminders-changed"));
  }

  window.location.reload();
}
