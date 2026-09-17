import { MusicManager } from "./audio-subsystem/music-manager";

export interface MusicTrackMeta {
  id: string;
  name: string;
  size: number;
  type: string;
  addedAt: number;
}

const DB_NAME = "alpha.music.v1";
const STORE = "tracks";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("Music storage is not available in this browser."));
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

function tx<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const store = transaction.objectStore(STORE);
        const req = run(store);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error("Music storage request failed."));
        transaction.oncomplete = () => db.close();
        transaction.onerror = () => {
          db.close();
          reject(transaction.error || new Error("Music transaction failed."));
        };
      }),
  );
}

export async function addMusicFiles(files: FileList | File[]): Promise<MusicTrackMeta[]> {
  const arr = Array.from(files).filter((f) => /audio\//i.test(f.type) || /\.mp3$/i.test(f.name));
  const saved: MusicTrackMeta[] = [];
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      for (const file of arr) {
        const meta: MusicTrackMeta = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: file.name.replace(/\.[^.]+$/, ""),
          size: file.size,
          type: file.type || "audio/mpeg",
          addedAt: Date.now(),
        };
        store.put({ ...meta, blob: file });
        saved.push(meta);
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("Could not save music."));
    });
  } finally {
    db.close();
  }
  return saved;
}

export async function listMusicTracks(): Promise<MusicTrackMeta[]> {
  const rows = await tx<any[]>("readonly", (store) => store.getAll());
  return rows
    .map(({ blob: _blob, ...meta }) => meta as MusicTrackMeta)
    .sort((a, b) => b.addedAt - a.addedAt);
}

export async function deleteMusicTrack(id: string): Promise<void> {
  await tx<undefined>("readwrite", (store) => store.delete(id) as IDBRequest<undefined>);
}

export function stopMusic() {
  MusicManager.getInstance().stop();
}

export async function playMusicByName(query = ""): Promise<string> {
  const rows = await tx<any[]>("readonly", (store) => store.getAll());
  if (!rows.length)
    return "No music is stored yet. Upload MP3 files in Settings → Alpha Data → Music Library.";
  const q = query.trim().toLowerCase();
  const row = q
    ? rows.find((r) =>
        String(r.name || "")
          .toLowerCase()
          .includes(q),
      )
    : rows.sort((a, b) => Number(b.addedAt || 0) - Number(a.addedAt || 0))[0];
  if (!row) return `I couldn't find a track matching "${query}".`;
  
  await MusicManager.getInstance().play(row.blob as Blob, row.name);
  return `Playing ${row.name}.`;
}
