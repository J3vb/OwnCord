import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A Blob read from the durable image cache must not stay tied to its record:
// WebKitGTK fails every later read of one once the record is rewritten (the
// daily read-time refresh) or deleted, which showed as a broken picture.

type Handler = (() => void) | null;

interface FakeRequest<T> {
  result: T;
  onsuccess: Handler;
  onerror: Handler;
}

function settled<T>(result: T): FakeRequest<T> {
  const req: FakeRequest<T> = { result, onsuccess: null, onerror: null };
  queueMicrotask(() => req.onsuccess?.());
  return req;
}

/** One object store over `records`, enough for a read, a rewrite and a delete. */
function stubIndexedDb(records: Map<string, unknown>): void {
  const store = {
    get: (key: string) => settled(records.get(key)),
    put: (value: unknown, key: string) => {
      records.set(key, value);
      return settled(key);
    },
    delete: (key: string) => {
      records.delete(key);
      return settled(undefined);
    },
  };
  const db = {
    objectStoreNames: { contains: () => true },
    transaction: () => ({ objectStore: () => store }),
    close: vi.fn(),
    onversionchange: null,
    onclose: null,
  };
  vi.stubGlobal("indexedDB", { open: () => settled(db) });
}

async function loadIdbGet(): Promise<(key: string) => Promise<Blob | null>> {
  vi.resetModules();
  const mod = await import("../../src/features/messaging/content/attachmentIdb");
  return mod.idbGet;
}

const KEY = "host#1|https://host/api/v1/files/a";
const DAY_MS = 24 * 60 * 60 * 1000;

function storedGif(): Blob {
  return new Blob([new Uint8Array([71, 73, 70, 56, 57, 97])], { type: "image/gif" });
}

describe("durable image cache reads", () => {
  let records: Map<string, unknown>;

  beforeEach(() => {
    records = new Map();
    stubIndexedDb(records);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hands out a copy that holds its own bytes and type", async () => {
    const stored = storedGif();
    records.set(KEY, { blob: stored, bytes: stored.size, used: Date.now() });
    const idbGet = await loadIdbGet();

    const got = await idbGet(KEY);

    expect(got).not.toBeNull();
    expect(got).not.toBe(stored);
    expect(got?.type).toBe("image/gif");
    expect(new Uint8Array(await got!.arrayBuffer())).toEqual(
      new Uint8Array(await stored.arrayBuffer()),
    );
  });

  it("refreshes a stale entry with the copy, never the stored Blob", async () => {
    const stored = storedGif();
    records.set(KEY, { blob: stored, bytes: stored.size, used: Date.now() - DAY_MS - 1 });
    const idbGet = await loadIdbGet();

    const got = await idbGet(KEY);
    await Promise.resolve();

    const rewritten = records.get(KEY) as { blob: Blob; bytes: number; used: number };
    expect(rewritten.blob).toBe(got);
    expect(rewritten.blob).not.toBe(stored);
    expect(rewritten.bytes).toBe(stored.size);
    expect(Date.now() - rewritten.used).toBeLessThan(DAY_MS);
  });

  it("leaves a fresh entry's record alone", async () => {
    const stored = storedGif();
    const entry = { blob: stored, bytes: stored.size, used: Date.now() };
    records.set(KEY, entry);
    const idbGet = await loadIdbGet();

    await idbGet(KEY);
    await Promise.resolve();

    expect(records.get(KEY)).toBe(entry);
  });

  it("reads an entry whose Blob cannot be read as a miss and drops it", async () => {
    const stored = storedGif();
    vi.spyOn(stored, "arrayBuffer").mockRejectedValue(new DOMException("gone", "NotFoundError"));
    records.set(KEY, { blob: stored, bytes: stored.size, used: Date.now() - DAY_MS - 1 });
    const idbGet = await loadIdbGet();

    expect(await idbGet(KEY)).toBeNull();
    expect(records.has(KEY)).toBe(false);
  });

  it("does not bring back an entry removed while it was being read", async () => {
    const stored = storedGif();
    records.set(KEY, { blob: stored, bytes: stored.size, used: Date.now() - DAY_MS - 1 });
    const realArrayBuffer = stored.arrayBuffer.bind(stored);
    vi.spyOn(stored, "arrayBuffer").mockImplementation(() => {
      records.delete(KEY);
      return realArrayBuffer();
    });
    const idbGet = await loadIdbGet();

    expect(await idbGet(KEY)).not.toBeNull();
    await Promise.resolve();

    expect(records.has(KEY)).toBe(false);
  });

  it("leaves an entry a newer write replaced while it was being read", async () => {
    const stored = storedGif();
    const newer = { blob: storedGif(), bytes: 6, used: Date.now() };
    records.set(KEY, { blob: stored, bytes: stored.size, used: Date.now() - DAY_MS - 1 });
    const realArrayBuffer = stored.arrayBuffer.bind(stored);
    vi.spyOn(stored, "arrayBuffer").mockImplementation(() => {
      records.set(KEY, newer);
      return realArrayBuffer();
    });
    const idbGet = await loadIdbGet();

    await idbGet(KEY);
    await Promise.resolve();

    expect(records.get(KEY)).toBe(newer);
  });

  it("keeps a newer write when the entry it replaced could not be read", async () => {
    const stored = storedGif();
    const newer = { blob: storedGif(), bytes: 6, used: Date.now() };
    records.set(KEY, { blob: stored, bytes: stored.size, used: Date.now() - DAY_MS - 1 });
    vi.spyOn(stored, "arrayBuffer").mockImplementation(() => {
      records.set(KEY, newer);
      return Promise.reject(new DOMException("gone", "NotFoundError"));
    });
    const idbGet = await loadIdbGet();

    expect(await idbGet(KEY)).toBeNull();
    await Promise.resolve();

    expect(records.get(KEY)).toBe(newer);
  });
});
