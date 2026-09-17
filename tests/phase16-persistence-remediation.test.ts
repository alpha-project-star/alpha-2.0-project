import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getStorage, writeLS, PersistenceError } from "../src/lib/alpha-store";

describe("Phase 16 - AL-01 LocalStorage Persistence Truthfulness Regression Tests", () => {
  let originalWindow: any;

  beforeEach(() => {
    originalWindow = (globalThis as any).window;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalWindow !== undefined) {
      (globalThis as any).window = originalWindow;
    } else {
      delete (globalThis as any).window;
    }
  });

  it("1. When window is undefined (SSR safety), getStorage and writeLS handle it gracefully", () => {
    if ((globalThis as any).window !== undefined) {
      // Force window to be undefined
      (globalThis as any).window = undefined;
    }

    expect(getStorage()).toBeUndefined();
    const result = writeLS("ssr_key", { a: 1 });
    expect(result.status).toBe("unavailable");
  });

  it("2. Normal browser-like storage success works", () => {
    const storeMap = new Map<string, string>();
    const mockLocalStorage = {
      getItem: vi.fn((key: string) => storeMap.get(key) || null),
      setItem: vi.fn((key: string, value: string) => {
        storeMap.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        storeMap.delete(key);
      }),
    };

    (globalThis as any).window = {
      localStorage: mockLocalStorage,
    };

    const key = "test_write_success_key";
    const data = { foo: "bar" };

    const result = writeLS(key, data);
    expect(result.status).toBe("success");
    expect(mockLocalStorage.setItem).toHaveBeenCalledWith(key, JSON.stringify(data));
    expect(getStorage()).toBe(mockLocalStorage);
  });

  it("3. Genuine storage failure is observed and throws PersistenceError (no false success)", () => {
    const mockLocalStorage = {
      getItem: vi.fn(),
      setItem: vi.fn(() => {
        throw new Error("QuotaExceededError: Storage limit reached");
      }),
      removeItem: vi.fn(),
    };

    (globalThis as any).window = {
      localStorage: mockLocalStorage,
    };

    expect(() => {
      writeLS("failed_key", { a: 1 });
    }).toThrow(PersistenceError);
  });

  it("4. When localStorage throws on access, writeLS returns unavailable cleanly", () => {
    (globalThis as any).window = {};
    Object.defineProperty((globalThis as any).window, "localStorage", {
      get: () => {
        throw new Error("SecurityError: Access is denied for this document");
      },
      configurable: true,
    });

    const result = writeLS("unavailable_key", { hello: "world" });
    expect(result.status).toBe("unavailable");
  });
});
