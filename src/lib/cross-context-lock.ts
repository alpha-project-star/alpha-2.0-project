// src/lib/cross-context-lock.ts

const inMemoryLocks = new Map<string, Promise<any>>();

/**
 * Acquires a cross-context exclusive lock.
 *
 * Concurrency & Durability Boundaries:
 * - Browser-origin cross-context mutual exclusion: Uses browser navigator.locks.request
 *   to provide exclusive mutual exclusion among participating contexts (tabs, workers)
 *   within the current browser origin.
 * - Process-local fallback: In environments where navigator.locks is unavailable (such as
 *   Node.js runtimes and Vitest test harnesses), falls back to an in-memory queue.
 * - Critical section: The lock is held across the entire decision-critical
 *   read -> validate -> decide -> modify -> persist sequence.
 * - Storage distinction: Mutual exclusion prevents lost-update race conditions; it does NOT
 *   convert browser localStorage into a transactional or server-durable database.
 */
export function withCrossContextLock<T>(lockName: string, fn: () => Promise<T> | T): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
    return navigator.locks.request(lockName, { mode: 'exclusive' }, async () => {
      return await fn();
    });
  }

  const currentLock = inMemoryLocks.get(lockName);
  if (!currentLock) {
    let releaseLock!: () => void;
    const nextLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    inMemoryLocks.set(lockName, nextLock);

    try {
      const result = fn();
      if (result && typeof (result as any).then === 'function') {
        return (result as Promise<T>).then(
          (val) => {
            if (inMemoryLocks.get(lockName) === nextLock) {
              inMemoryLocks.delete(lockName);
            }
            releaseLock();
            return val;
          },
          (err) => {
            if (inMemoryLocks.get(lockName) === nextLock) {
              inMemoryLocks.delete(lockName);
            }
            releaseLock();
            throw err;
          }
        );
      } else {
        if (inMemoryLocks.get(lockName) === nextLock) {
          inMemoryLocks.delete(lockName);
        }
        releaseLock();
        return Promise.resolve(result as T);
      }
    } catch (err) {
      if (inMemoryLocks.get(lockName) === nextLock) {
        inMemoryLocks.delete(lockName);
      }
      releaseLock();
      throw err;
    }
  } else {
    let releaseLock!: () => void;
    const nextLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const queued = currentLock.catch(() => {}).then(async () => {
      try {
        return await fn();
      } finally {
        if (inMemoryLocks.get(lockName) === nextLock) {
          inMemoryLocks.delete(lockName);
        }
        releaseLock();
      }
    });

    inMemoryLocks.set(lockName, nextLock);
    return queued;
  }
}
