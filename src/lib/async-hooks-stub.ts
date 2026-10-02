/**
 * Browser-safe stub and polyfill for node:async_hooks / async_hooks.
 * In Node.js environments, delegates to native AsyncLocalStorage.
 * In browser environments, provides an in-memory AsyncLocalStorage implementation.
 */

const nativeAsyncLocalStorage = (function () {
  try {
    if (typeof process !== "undefined" && typeof (process as any).getBuiltinModule === "function") {
      return (process as any).getBuiltinModule("node:async_hooks")?.AsyncLocalStorage || null;
    }
  } catch {}
  return null;
})();

export class AsyncLocalStorage<T = any> {
  private _native: any;
  private _store: T | undefined = undefined;

  constructor() {
    if (nativeAsyncLocalStorage) {
      this._native = new nativeAsyncLocalStorage();
    }
  }

  disable(): void {
    if (this._native) {
      this._native.disable();
    } else {
      this._store = undefined;
    }
  }

  getStore(): T | undefined {
    if (this._native) {
      return this._native.getStore();
    }
    return this._store;
  }

  run<R>(store: T, callback: (...args: any[]) => R, ...args: any[]): R {
    if (this._native) {
      return this._native.run(store, callback, ...args);
    }
    const prev = this._store;
    this._store = store;
    try {
      return callback(...args);
    } finally {
      this._store = prev;
    }
  }

  exit<R>(callback: (...args: any[]) => R, ...args: any[]): R {
    if (this._native) {
      return this._native.exit(callback, ...args);
    }
    const prev = this._store;
    this._store = undefined;
    try {
      return callback(...args);
    } finally {
      this._store = prev;
    }
  }

  enterWith(store: T): void {
    if (this._native) {
      this._native.enterWith(store);
    } else {
      this._store = store;
    }
  }
}

export class AsyncResource {
  type: string;
  constructor(type: string) {
    this.type = type;
  }
  runInAsyncScope<R>(fn: (...args: any[]) => R, thisArg?: any, ...args: any[]): R {
    return fn.apply(thisArg, args);
  }
  emitDestroy(): this {
    return this;
  }
  asyncId(): number {
    return 0;
  }
  triggerAsyncId(): number {
    return 0;
  }
}

export function executionAsyncId(): number {
  return 0;
}

export function triggerAsyncId(): number {
  return 0;
}

export default {
  AsyncLocalStorage,
  AsyncResource,
  executionAsyncId,
  triggerAsyncId,
};
