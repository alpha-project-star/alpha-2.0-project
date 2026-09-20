// src/lib/cross-context-lock.ts

const inMemoryLocks = new Map<string, Promise<any>>();

/**
 * Checks whether the browser Web Locks API (navigator.locks) is genuinely supported
 * and available in the current execution environment.
 */
export function isCrossContextLockSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.locks && typeof navigator.locks.request === 'function';
}

/**
 * Returns the name of the active synchronization mechanism:
 * - 'web-locks': Browser Web Locks API providing genuine cross-context (cross-tab/worker) exclusion.
 * - 'in-memory-fallback': Process-local in-memory queue providing same-JS-context serialization ONLY.
 */
export function getLockingMechanism(): 'web-locks' | 'in-memory-fallback' {
  return isCrossContextLockSupported() ? 'web-locks' : 'in-memory-fallback';
}

/**
 * Error thrown when an operation explicitly requires true cross-context mutual exclusion
 * (e.g. across tabs), but navigator.locks is unavailable.
 */
export class WebLocksUnavailableError extends Error {
  constructor(lockName: string) {
    super(
      `Cross-context exclusive lock "${lockName}" required Web Locks API (navigator.locks), ` +
      `but it is unavailable in this environment. The in-memory fallback cannot provide cross-tab or cross-process exclusion.`
    );
    this.name = 'WebLocksUnavailableError';
  }
}

export interface CrossContextLockOptions {
  /**
   * If true, requires genuine browser Web Locks cross-context exclusion.
   * If navigator.locks is unavailable, the operation rejects with WebLocksUnavailableError
   * rather than falling back to process-local in-memory serialization.
   */
  requireCrossContextExclusion?: boolean;
}

/**
 * Acquires an exclusive lock to protect a critical section.
 *
 * Concurrency & Durability Boundaries:
 * - Browser-origin cross-context mutual exclusion: When supported, uses browser navigator.locks.request
 *   to provide exclusive mutual exclusion among participating contexts (tabs, workers)
 *   within the current browser origin.
 * - Process-local fallback (HONEST BEHAVIOR NOTICE):
 *   In environments where navigator.locks is unavailable (such as Node.js runtimes and Vitest test harnesses),
 *   this falls back to an in-memory promise queue.
 *   CRITICAL: The in-memory fallback provides serialization ONLY within the current JavaScript process/context.
 *   It DOES NOT and CANNOT provide cross-tab, cross-window, or cross-process mutual exclusion.
 *   Safety-critical operations that strictly require cross-context exclusion may pass
 *   { requireCrossContextExclusion: true } to fail closed with WebLocksUnavailableError.
 * - Critical section: The lock is held across the entire decision-critical
 *   read -> validate -> decide -> modify -> persist sequence.
 * - Storage distinction: Mutual exclusion prevents lost-update race conditions; it does NOT
 *   convert browser localStorage into a transactional or server-durable database.
 */
export function withCrossContextLock<T>(
  lockName: string,
  fn: () => Promise<T> | T,
  options?: CrossContextLockOptions,
): Promise<T> {
  if (isCrossContextLockSupported()) {
    return navigator.locks.request(lockName, { mode: 'exclusive' }, async () => {
      return await fn();
    });
  }

  if (options?.requireCrossContextExclusion) {
    return Promise.reject(new WebLocksUnavailableError(lockName));
  }

  // Same-JS-context in-memory queue fallback.
  // Provides serialization strictly within the same JS execution context.
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
