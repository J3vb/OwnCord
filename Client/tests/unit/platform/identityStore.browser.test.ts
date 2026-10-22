// Browser binding for the IdentityStore suite (6.13c): the browser platform's
// identity key and pin store over IndexedDB. "The native store" is a small
// in-test IndexedDB: it answers, fails every request, or is missing. The same
// suite runs against the desktop store in `identityStore.desktop.test.ts`.
//
// The adapter keeps its open database across calls, so each test takes a fresh
// module instance.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IdentityStore } from "../../../src/platform/contracts/identityStore";
import { describeIdentityStoreSuite } from "./identityStore.suite";

type Handler = (() => void) | null;

/** What the in-test database does. `answer`, when not undefined, is what every
 *  read returns whatever was written (the suite's "the store holds X"); left
 *  undefined, reads see what was written. */
const control: {
  answer: unknown;
  failure: unknown;
  openFailure: unknown;
  data: Map<string, Map<IDBValidKey, unknown>>;
} = { answer: undefined, failure: null, openFailure: null, data: new Map() };

class FakeRequest {
  result: unknown = undefined;
  error: unknown = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  onupgradeneeded: Handler = null;
  onblocked: Handler = null;
}

class FakeTransaction {
  error: unknown = null;
  oncomplete: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;

  constructor(private readonly storeName: string) {}

  objectStore(name: string) {
    expect(name).toBe(this.storeName);
    const rows = control.data.get(name)!;
    const run = (apply: () => unknown): FakeRequest => {
      const request = new FakeRequest();
      setTimeout(() => {
        if (control.failure !== null) {
          request.error = control.failure;
          this.error = control.failure;
          request.onerror?.();
          this.onerror?.();
          this.onabort?.();
          return;
        }
        request.result = apply();
        request.onsuccess?.();
        this.oncomplete?.();
      }, 0);
      return request;
    };
    return {
      get: (key: IDBValidKey) =>
        run(() => (control.answer !== undefined ? (control.answer ?? undefined) : rows.get(key))),
      put: (value: unknown, key: IDBValidKey) => run(() => rows.set(key, value) && key),
      delete: (key: IDBValidKey) => run(() => rows.delete(key) && undefined),
    };
  }
}

const fakeIndexedDB = {
  open(_name: string, _version?: number): FakeRequest {
    const request = new FakeRequest();
    setTimeout(() => {
      if (control.openFailure !== null) {
        request.error = control.openFailure;
        request.onerror?.();
        return;
      }
      const db = {
        objectStoreNames: { contains: (name: string) => control.data.has(name) },
        createObjectStore: (name: string) => {
          control.data.set(name, new Map());
        },
        transaction: (name: string, _mode?: IDBTransactionMode) => new FakeTransaction(name),
        close: () => undefined,
        onversionchange: null,
        onclose: null,
      };
      request.result = db;
      request.onupgradeneeded?.();
      request.onsuccess?.();
    }, 0);
    return request;
  },
};

async function freshStore(): Promise<IdentityStore> {
  vi.resetModules();
  const mod = await import("../../../src/platform/browser/identity");
  return mod.identity;
}

function resetControl(): void {
  control.answer = undefined;
  control.failure = null;
  control.openFailure = null;
  control.data = new Map();
  vi.stubGlobal("indexedDB", fakeIndexedDB);
}

afterAll(() => {
  vi.unstubAllGlobals();
});

describeIdentityStoreSuite(async () => {
  resetControl();
  const browserBinding = await freshStore();
  return {
    subject: browserBinding,
    native: {
      succeedWith(value: unknown) {
        control.answer = value;
      },
      failWith(error: unknown) {
        control.failure = error;
      },
      unavailable() {
        vi.stubGlobal("indexedDB", undefined);
      },
    },
  };
});

describe("browser identity store", () => {
  let store: IdentityStore;
  beforeEach(async () => {
    resetControl();
    store = await freshStore();
  });

  it("reads back the key it saved, per host, and forgets it on delete", async () => {
    await expect(store.saveKey("1@a.example", "blob-a")).resolves.toBe(true);
    await expect(store.saveKey("1@b.example", "blob-b")).resolves.toBe(true);
    await expect(store.loadKey("1@a.example")).resolves.toBe("blob-a");
    await expect(store.deleteKey("1@a.example")).resolves.toBe(true);
    await expect(store.loadKey("1@a.example")).resolves.toBeNull();
    await expect(store.loadKey("1@b.example")).resolves.toBe("blob-b");
  });

  it("reads back a stored pin, per host and user", async () => {
    await expect(store.storePin("a.example", "7", "pin-a")).resolves.toBe("stored");
    await expect(store.getPin("a.example", "7")).resolves.toEqual({
      status: "pinned",
      pin: "pin-a",
    });
    await expect(store.getPin("a.example", "8")).resolves.toEqual({ status: "unpinned" });
    await expect(store.getPin("b.example", "7")).resolves.toEqual({ status: "unpinned" });
  });

  it("read error is unavailable, not unpinned", async () => {
    await store.storePin("a.example", "7", "pin-a");
    control.failure = new Error("read failed");
    await expect(store.getPin("a.example", "7")).resolves.toEqual({ status: "unavailable" });
    await expect(store.getPin("a.example", "8")).resolves.toEqual({ status: "unavailable" });
  });

  it("a database that will not open is unavailable for pins, and an error for the key", async () => {
    control.openFailure = new Error("open failed");
    await expect(store.getPin("a.example", "7")).resolves.toEqual({ status: "unavailable" });
    await expect(store.storePin("a.example", "7", "pin")).resolves.toBe("failed");
    await expect(store.loadKey("1@a.example")).rejects.toThrow();
    await expect(store.saveKey("1@a.example", "blob")).resolves.toBe(false);
  });

  it("opens the database again after a failed open", async () => {
    control.openFailure = new Error("open failed");
    await expect(store.loadKey("1@a.example")).rejects.toThrow();
    control.openFailure = null;
    await expect(store.saveKey("1@a.example", "blob")).resolves.toBe(true);
    await expect(store.loadKey("1@a.example")).resolves.toBe("blob");
  });

  it("treats a stored key that is not a string as no key", async () => {
    control.answer = { not: "a string" };
    await expect(store.loadKey("1@a.example")).resolves.toBeNull();
  });

  it("answers unavailable, not unpinned, for a stored pin that is not a string", async () => {
    control.answer = { not: "a string" };
    await expect(store.getPin("a.example", "7")).resolves.toEqual({ status: "unavailable" });
  });
});
