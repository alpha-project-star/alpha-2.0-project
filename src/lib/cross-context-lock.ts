// src/lib/cross-context-lock.ts

const inMemoryLocks = new Map<string, Promise<any>>();

/**
 * Acquires a cross-context exclusive lock.
 *
 * Guarantees:
 * - Cross-context mutual exclusion: Uses browser navigator.locks.request if available
 *   to provide mutual exclusion among participating contexts within the relevant browser origin.
 * - In-memory fallback: Falls back to an in-memory async mutex queue for Node / Vitest
 *   test environments where navigator.locks is not available.
 * - Single-operation serialization: The lock is held for the duration of the provided async
 *   callback to protect decision-critical read/validate/modify/persist sequences.
 */
export async function withCrossContextLock<T>(lockName: string, fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
    return await navigator.locks.request(lockName, { mode: 'exclusive' }, async () => {
      return await fn();
    });
  } else {
    const currentLock = inMemoryLocks.get(lockName) || Promise.resolve();
    let releaseLock: () => void = () => {};
    const nextLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const queuedLock = currentLock.catch(() => {}).then(async () => {
      try {
        return await fn();
      } finally {
        releaseLock();
      }
    });

    inMemoryLocks.set(lockName, queuedLock);
    return await queuedLock;
  }
}
