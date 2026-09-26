/**
 * Alpha Cloud Memory & Persistence Synchronizer
 * Connects Alpha's local-first state to Firestore with optimistic local updates,
 * background cloud backup, and cross-device sync.
 */

import { doc, setDoc, deleteDoc, onSnapshot, collection } from "firebase/firestore";
import { onAuthStateChanged, User } from "firebase/auth";
import { db, auth, handleFirestoreError, OperationType } from "./firebase";
import { alphaStore, type Memory, type Note, type Task, type Bill, type Goal, type Profile } from "./alpha-store";

let activeUnsubscribers: Array<() => void> = [];
let currentSyncedUid: string | null = null;

export async function syncDocToCloud(
  collectionName: "memories" | "notes" | "tasks" | "bills" | "goals",
  id: string,
  data: any
): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.uid || !id) return;

  const path = `users/${user.uid}/${collectionName}/${id}`;
  try {
    const docRef = doc(db, "users", user.uid, collectionName, id);
    await setDoc(docRef, { ...data, userId: user.uid }, { merge: true });
  } catch (err: any) {
    console.warn(`[CloudSync] Background sync to ${path} failed (offline or unauthenticated):`, err?.message || err);
  }
}

export async function deleteDocFromCloud(
  collectionName: "memories" | "notes" | "tasks" | "bills" | "goals",
  id: string
): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.uid || !id) return;

  const path = `users/${user.uid}/${collectionName}/${id}`;
  try {
    const docRef = doc(db, "users", user.uid, collectionName, id);
    await deleteDoc(docRef);
  } catch (err: any) {
    console.warn(`[CloudSync] Background delete from ${path} failed:`, err?.message || err);
  }
}

export function initCloudSync(): () => void {
  if (typeof window === "undefined") return () => {};

  const unsubscribeAuth = onAuthStateChanged(auth, (user: User | null) => {
    // Teardown previous listeners if user switched or logged out
    activeUnsubscribers.forEach((unsub) => {
      try {
        unsub();
      } catch {}
    });
    activeUnsubscribers = [];

    if (!user || !user.uid) {
      currentSyncedUid = null;
      return;
    }

    currentSyncedUid = user.uid;
    const uid = user.uid;

    // 1. Memories Sync Listener
    try {
      const memoriesPath = `users/${uid}/memories`;
      const unsubMemories = onSnapshot(
        collection(db, "users", uid, "memories"),
        (snapshot) => {
          if (!snapshot.empty) {
            const cloudMemories: Memory[] = snapshot.docs.map((d) => d.data() as Memory);
            const localMemories = alphaStore.get().memories;
            // Merge cloud memories with local memories
            const mergedMap = new Map<string, Memory>();
            localMemories.forEach((m) => mergedMap.set(m.id, m));
            cloudMemories.forEach((m) => mergedMap.set(m.id, m));
            const merged = Array.from(mergedMap.values());
            if (merged.length !== localMemories.length) {
              void alphaStore.replaceAll({ memories: merged });
            }
          } else {
            // Upload existing local memories if cloud is empty
            const local = alphaStore.get().memories;
            local.forEach((m) => void syncDocToCloud("memories", m.id, m));
          }
        },
        (error) => {
          handleFirestoreError(error, OperationType.LIST, memoriesPath);
        }
      );
      activeUnsubscribers.push(unsubMemories);
    } catch (err) {
      console.warn("[CloudSync] Failed to initialize memories listener:", err);
    }

    // 2. Notes Sync Listener
    try {
      const notesPath = `users/${uid}/notes`;
      const unsubNotes = onSnapshot(
        collection(db, "users", uid, "notes"),
        (snapshot) => {
          if (!snapshot.empty) {
            const cloudNotes: Note[] = snapshot.docs.map((d) => d.data() as Note);
            const localNotes = alphaStore.get().notes;
            const mergedMap = new Map<string, Note>();
            localNotes.forEach((n) => mergedMap.set(n.id, n));
            cloudNotes.forEach((n) => mergedMap.set(n.id, n));
            const merged = Array.from(mergedMap.values());
            if (merged.length !== localNotes.length) {
              void alphaStore.replaceAll({ notes: merged });
            }
          } else {
            const local = alphaStore.get().notes;
            local.forEach((n) => void syncDocToCloud("notes", n.id, n));
          }
        },
        (error) => {
          handleFirestoreError(error, OperationType.LIST, notesPath);
        }
      );
      activeUnsubscribers.push(unsubNotes);
    } catch (err) {
      console.warn("[CloudSync] Failed to initialize notes listener:", err);
    }
  });

  return () => {
    unsubscribeAuth();
    activeUnsubscribers.forEach((u) => {
      try {
        u();
      } catch {}
    });
    activeUnsubscribers = [];
  };
}
