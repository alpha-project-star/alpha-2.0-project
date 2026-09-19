import { toast } from "sonner";
import { z } from "zod";
import { auth } from "./firebase";
import {
  K,
  ChatMessageSchema,
  NoteSchema,
  BillSchema,
  MemorySchema,
  ProfileSchema,
  SettingsSchema,
  uid,
} from "./alpha-store";
import { interpretReminderDate } from "./reminder-date-utils";
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
  const currentUid = auth.currentUser?.uid || "local-user";
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
  if (!data || (data.version !== 1 && data.version !== 2)) {
    throw new Error("Unrecognized Alpha backup format.");
  }

  // =========================================================================
  // PHASE 1: STAGE AND VALIDATE COMPLETE IMPORT (Pure / Non-destructive)
  // =========================================================================
  const stagedLocalStorage: Record<string, string> = {};
  const restored: string[] = [];

  // Stage localStorage keys
  for (const key of Object.values(K)) {
    const value = data.localStorage?.[key];
    if (value !== undefined && value !== null) {
      if (STORE_SCHEMAS[key]) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(value);
        } catch {
          throw new Error(`Corrupted JSON in backup for ${key}.`);
        }
        const result = STORE_SCHEMAS[key].safeParse(parsed);
        if (!result.success) {
          throw new Error(`Schema validation failed for ${key} during import: ${result.error.message}`);
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
        stagedLocalStorage[key] = JSON.stringify(sanitizedData);
      } else {
        stagedLocalStorage[key] = value;
      }
      restored.push(key);
    }
  }

  // Stage reminders (canonical LocalReminderRepository records)
  const currentUid = auth.currentUser?.uid || "local-user";
  const stagedReminders: FirestoreReminder[] = [];
  const seenReminderIds = new Set<string>();

  if (Array.isArray(data.reminders) && data.reminders.length > 0) {
    for (const r of data.reminders) {
      if (!r || typeof r !== "object" || Array.isArray(r)) {
        throw new Error("Invalid reminder in backup: expected an object.");
      }
      if (typeof r.id !== "string" || !r.id.trim()) {
        throw new Error("Invalid reminder in backup: missing or empty id.");
      }
      if (seenReminderIds.has(r.id)) {
        throw new Error(`Invalid reminder in backup: duplicate reminder ID "${r.id}".`);
      }
      seenReminderIds.add(r.id);
      if (typeof r.userId !== "string" || !r.userId.trim()) {
        throw new Error(`Invalid reminder in backup: reminder ID "${r.id}" is missing or has an empty userId.`);
      }
      if (r.userId !== currentUid) {
        throw new Error(`Invalid reminder in backup: reminder ID "${r.id}" has userId "${r.userId}" which does not match authenticated user "${currentUid}".`);
      }
      if (typeof r.title !== "string") {
        throw new Error(`Invalid reminder in backup: reminder ID "${r.id}" is missing a string title.`);
      }
      if (typeof r.notes !== "string") {
        throw new Error(`Invalid reminder in backup: reminder ID "${r.id}" is missing a string notes field.`);
      }
      if (typeof r.dueAt !== "number" || isNaN(r.dueAt) || !isFinite(r.dueAt)) {
        throw new Error(`Invalid reminder in backup: "${r.title}" is missing a valid numeric due date.`);
      }
      if (typeof r.createdAt !== "number" || isNaN(r.createdAt) || !isFinite(r.createdAt)) {
        throw new Error(`Invalid reminder in backup: "${r.title}" is missing a valid numeric createdAt.`);
      }
      if (typeof r.updatedAt !== "number" || isNaN(r.updatedAt) || !isFinite(r.updatedAt)) {
        throw new Error(`Invalid reminder in backup: "${r.title}" is missing a valid numeric updatedAt.`);
      }
      if (r.reminderState !== "active" && r.reminderState !== "completed" && r.reminderState !== "cancelled") {
        throw new Error(`Invalid reminder in backup: "${r.title}" has an invalid reminderState "${String(r.reminderState)}".`);
      }
      if (r.notificationState !== "pending" && r.notificationState !== "claimed" && r.notificationState !== "accepted" && r.notificationState !== "failed") {
        throw new Error(`Invalid reminder in backup: "${r.title}" has an invalid notificationState "${String(r.notificationState)}".`);
      }
      if (r.legacyFiredAt !== undefined && (typeof r.legacyFiredAt !== "number" || !isFinite(r.legacyFiredAt))) {
        throw new Error(`Invalid reminder in backup: "${r.title}" has an invalid legacyFiredAt.`);
      }
      if (r.proactiveState !== undefined && !["pending", "generating", "generated", "failed"].includes(r.proactiveState)) {
        throw new Error(`Invalid reminder in backup: "${r.title}" has an invalid proactiveState.`);
      }
      if (r.proactiveEventId !== undefined && typeof r.proactiveEventId !== "string") {
        throw new Error(`Invalid reminder in backup: "${r.title}" has an invalid proactiveEventId.`);
      }
      if (r.proactiveHandledAt !== undefined && (typeof r.proactiveHandledAt !== "number" || !isFinite(r.proactiveHandledAt))) {
        throw new Error(`Invalid reminder in backup: "${r.title}" has an invalid proactiveHandledAt.`);
      }
      if (r.proactiveMessageId !== undefined && typeof r.proactiveMessageId !== "string") {
        throw new Error(`Invalid reminder in backup: "${r.title}" has an invalid proactiveMessageId.`);
      }

      stagedReminders.push({
        id: r.id,
        userId: r.userId,
        title: r.title,
        notes: r.notes,
        dueAt: r.dueAt,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        reminderState: r.reminderState,
        notificationState: r.notificationState,
        legacyFiredAt: r.legacyFiredAt,
        proactiveState: r.proactiveState,
        proactiveEventId: r.proactiveEventId,
        proactiveHandledAt: r.proactiveHandledAt,
        proactiveMessageId: r.proactiveMessageId,
      });
    }
    restored.push(`reminders:${stagedReminders.length}`);
  } else if (data.localStorage?.["alpha.reminders.v1"]) {
    // Backward-compatible v1 migration
    let legacyReminders: unknown;
    try {
      legacyReminders = JSON.parse(data.localStorage["alpha.reminders.v1"]);
    } catch {
      throw new Error("Invalid legacy reminders JSON in backup.");
    }
    if (Array.isArray(legacyReminders)) {
      for (const lr of legacyReminders) {
        if (!lr || typeof lr !== "object") continue;
        if (!lr.title || typeof lr.title !== "string" || !lr.title.trim()) {
          throw new Error("Invalid legacy reminder in backup: record is missing a title.");
        }
        let dueAt: number | null = null;
        if (typeof lr.dueAt === "number" && !isNaN(lr.dueAt) && isFinite(lr.dueAt)) {
          dueAt = lr.dueAt;
        } else if (lr.when && typeof lr.when === "string" && lr.when.trim()) {
          dueAt = interpretReminderDate(lr.when, new Date());
        }
        if (dueAt === null || isNaN(dueAt)) {
          throw new Error(`Invalid legacy reminder in backup: "${lr.title}" is missing a valid or parseable due date.`);
        }
        stagedReminders.push({
          id: lr.id || uid(),
          userId: currentUid,
          title: lr.title.trim(),
          notes: lr.notes || "",
          dueAt,
          createdAt: lr.createdAt || Date.now(),
          updatedAt: lr.updatedAt || Date.now(),
          reminderState: lr.done === "yes" ? "completed" : "active",
          notificationState: "pending",
        });
      }
      restored.push(`reminders:${stagedReminders.length}`);
    }
  }

  // Stage music tracks
  const shouldReplaceMusic = Array.isArray(data.music);
  const stagedMusic: Array<{
    id: string;
    name: string;
    size: number;
    type: string;
    addedAt: number;
    blob: Blob;
  }> = [];

  if (shouldReplaceMusic && data.music) {
    for (const track of data.music) {
      if (!track.id || !track.dataUrl) {
        throw new Error(`Invalid music track in backup: "${track.name || "unnamed"}" is missing data.`);
      }
      try {
        const blob = dataUrlToBlob(track.dataUrl);
        stagedMusic.push({
          id: track.id,
          name: track.name,
          size: track.size,
          type: track.type,
          addedAt: track.addedAt,
          blob,
        });
      } catch (err) {
        throw new Error(`Failed to decode music track "${track.name}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    restored.push(`music:${stagedMusic.length}`);
  }

  // =========================================================================
  // PHASE 2: CAPTURE PREVIOUS STATE FOR ATOMIC ROLLBACK
  // =========================================================================
  const previousLocalStorage: Record<string, string> = {};
  if (typeof window !== "undefined" && window.localStorage) {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && (key.startsWith("alpha.") || key.startsWith("alpha_"))) {
        const val = window.localStorage.getItem(key);
        if (val !== null) previousLocalStorage[key] = val;
      }
    }
  }

  const reminderRepo = new LocalReminderRepository();
  let previousReminders: FirestoreReminder[];
  try {
    previousReminders = await reminderRepo.listReminders(currentUid);
  } catch (snapshotErr) {
    throw new Error(
      `Import aborted: failed to snapshot existing reminders (${snapshotErr instanceof Error ? snapshotErr.message : String(snapshotErr)}). Existing data was not modified.`
    );
  }

  let previousMusic: any[] = [];
  if (shouldReplaceMusic) {
    try {
      const db = await openDb();
      previousMusic = await new Promise<any[]>((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const store = tx.objectStore(STORE);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error || new Error("Could not read existing music tracks."));
        tx.oncomplete = () => db.close();
      });
    } catch (musicSnapshotErr) {
      throw new Error(
        `Import aborted: failed to snapshot existing music storage (${musicSnapshotErr instanceof Error ? musicSnapshotErr.message : String(musicSnapshotErr)}). Existing data was not modified.`
      );
    }
  }

  // =========================================================================
  // PHASE 3: EXECUTE TRANSACTIONAL REPLACEMENT WITH ROLLBACK GUARD
  // =========================================================================
  try {
    // 1. Clear existing local state for exact replacement
    if (typeof window !== "undefined" && window.localStorage) {
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (key && (key.startsWith("alpha.") || key.startsWith("alpha_"))) {
          window.localStorage.removeItem(key);
          i--;
        }
      }
      // 2. Write staged localStorage entries
      for (const [key, val] of Object.entries(stagedLocalStorage)) {
        window.localStorage.setItem(key, val);
      }
    }

    // 3. Replace reminders in canonical LocalReminderRepository
    reminderRepo.clear();
    for (const r of stagedReminders) {
      await reminderRepo.createReminder(currentUid, r);
    }

    // 4. Replace music tracks in IndexedDB (including empty music collection replacement)
    if (shouldReplaceMusic) {
      const db = await openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        store.clear();
        for (const track of stagedMusic) {
          store.put(track);
        }
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error || new Error("Could not replace music store."));
        };
      });
    }
  } catch (writeError) {
    // ROLLBACK ON FAILURE
    console.error("Import replacement failed, rolling back to previous state:", writeError);
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        for (let i = 0; i < window.localStorage.length; i++) {
          const key = window.localStorage.key(i);
          if (key && (key.startsWith("alpha.") || key.startsWith("alpha_"))) {
            window.localStorage.removeItem(key);
            i--;
          }
        }
        for (const [key, val] of Object.entries(previousLocalStorage)) {
          window.localStorage.setItem(key, val);
        }
      }
      reminderRepo.clear();
      for (const pr of previousReminders) {
        await reminderRepo.createReminder(currentUid, pr);
      }
      if (shouldReplaceMusic) {
        const db = await openDb();
        await new Promise<void>((resolve) => {
          const tx = db.transaction(STORE, "readwrite");
          const store = tx.objectStore(STORE);
          store.clear();
          for (const item of previousMusic) store.put(item);
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => { db.close(); resolve(); };
        });
      }
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("alpha:reminders-changed"));
      }
    } catch (rollbackError) {
      console.error("Rollback execution error:", rollbackError);
    }
    throw new Error(`Import failed and previous state was restored: ${writeError instanceof Error ? writeError.message : String(writeError)}`);
  }

  // =========================================================================
  // PHASE 4: SUCCESS NOTIFICATION AND REFRESH
  // =========================================================================
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
  const errors: string[] = [];

  // 1. Clear localStorage keys
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && (key.startsWith("alpha.") || key.startsWith("alpha_"))) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      window.localStorage.removeItem(key);
    }
  } catch (err: unknown) {
    errors.push(`Failed to clear local storage: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Clear canonical reminders
  try {
    const reminderRepo = new LocalReminderRepository();
    const currentUid = auth.currentUser?.uid || "local-user";
    const existing = await reminderRepo.listReminders(currentUid);
    for (const r of existing) {
      await reminderRepo.deleteReminder(currentUid, r.id);
    }
  } catch (err: unknown) {
    errors.push(`Failed to clear canonical reminders: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Clear IndexedDB music
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
  } catch (err: unknown) {
    errors.push(`Failed to clear music store: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (errors.length > 0) {
    throw new Error(`Wipe operation failed:\n${errors.join("\n")}`);
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("alpha:reminders-changed"));
    if (typeof window.location?.reload === "function") {
      window.location.reload();
    }
  }
}
