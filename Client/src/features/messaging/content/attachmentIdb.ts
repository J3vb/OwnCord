/**
 * The durable half of the server-image cache: an IndexedDB store of image
 * Blobs scoped to the signed-in account, with a byte budget that evicts the
 * least recently read entries.
 */

/** What the durable image store may hold, so it persists across restarts
 *  without growing forever. */
export const IMAGE_DB_MAX_BYTES = 256 * 1024 * 1024;

/** `host#userId` of the account whose server content these caches hold.
 *  null while signed out: the durable store is neither read nor
 *  written, so nothing crosses from one profile or account to the next. */
let cacheScope: string | null = null;

export function getCacheScope(): string | null {
  return cacheScope;
}

export function assignCacheScope(scope: string | null): void {
  cacheScope = scope;
}

/** Durable-store key: the scope, then the URL. */
export function idbKey(scope: string, url: string): string {
  return `${scope}|${url}`;
}

/** IndexedDB database name and store. */
const IDB_NAME = "owncord-image-cache";
const IDB_STORE = "images";
const IDB_VERSION = 2;
/** Index on an entry's last-read time, so eviction walks oldest first. */
const IDB_USED_INDEX = "used";

/** The one shared connection. It is dropped, and the next call reopens, when
 *  the browser closes it or another tab upgrades the database. */
let cacheDbOpen: Promise<IDBDatabase | null> | null = null;
let cacheDbHandle: IDBDatabase | null = null;
/** Bytes held by the store, counted once per connection by `seedCacheTotal`
 *  and kept by each write. A prune or a failed transaction drops the seed so
 *  the next write counts again. */
let cacheTotal = 0;
let cacheSeed: Promise<boolean> | null = null;

function dropCacheDb(db: IDBDatabase): void {
  db.close();
  if (cacheDbHandle !== db) return;
  cacheDbOpen = null;
  cacheDbHandle = null;
  cacheSeed = null;
}

/** Open (or create) the IndexedDB database, once; later calls share it. */
export function openCacheDb(): Promise<IDBDatabase | null> {
  if (cacheDbOpen !== null) return cacheDbOpen;
  const opening = new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        const store = db.objectStoreNames.contains(IDB_STORE)
          ? req.transaction!.objectStore(IDB_STORE)
          : db.createObjectStore(IDB_STORE);
        if (!store.indexNames.contains(IDB_USED_INDEX)) {
          store.createIndex(IDB_USED_INDEX, "used");
        }
      };
      // oxlint-disable-next-line prefer-add-event-listener -- IDBRequest does not support addEventListener
      req.onsuccess = () => {
        const db = req.result;
        cacheDbHandle = db;
        // oxlint-disable-next-line prefer-add-event-listener -- IDBDatabase does not support addEventListener
        db.onversionchange = () => dropCacheDb(db);
        // oxlint-disable-next-line prefer-add-event-listener -- IDBDatabase does not support addEventListener
        db.onclose = () => dropCacheDb(db);
        resolve(db);
      };
      // oxlint-disable-next-line prefer-add-event-listener -- IDBRequest does not support addEventListener
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  cacheDbOpen = opening;
  void opening.then((db) => {
    if (db === null && cacheDbOpen === opening) cacheDbOpen = null;
  });
  return opening;
}

/** Resolves when `tx` ends: true if it completed, false if it aborted. Never rejects. */
function transactionEnded(tx: IDBTransaction): Promise<boolean> {
  return new Promise((resolve) => {
    // oxlint-disable-next-line prefer-add-event-listener -- IDBTransaction does not support addEventListener
    tx.oncomplete = () => resolve(true);
    // oxlint-disable-next-line prefer-add-event-listener -- IDBTransaction does not support addEventListener
    tx.onabort = () => resolve(false);
    // oxlint-disable-next-line prefer-add-event-listener -- IDBTransaction does not support addEventListener
    tx.onerror = () => resolve(false);
  });
}

/** Count the stored bytes with one cursor pass, dropping any pre-Blob entry on
 *  the way. Resolves false when the pass failed; the next write counts again. */
function seedCacheTotal(db: IDBDatabase): Promise<boolean> {
  const seed = new Promise<boolean>((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const req = tx.objectStore(IDB_STORE).openCursor();
      let sum = 0;
      // oxlint-disable-next-line prefer-add-event-listener -- IDBRequest does not support addEventListener
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor === null) return;
        const value: unknown = cursor.value;
        if (isStoredImage(value)) sum += value.bytes;
        else cursor.delete();
        cursor.continue();
      };
      void transactionEnded(tx).then((ok) => {
        if (cacheSeed === seed) {
          if (ok) cacheTotal = sum;
          else cacheSeed = null;
        }
        resolve(ok);
      });
    } catch {
      dropCacheDb(db);
      resolve(false);
    }
  });
  if (cacheDbHandle === db) cacheSeed = seed;
  return seed;
}

/** Delete every durable entry outside `scope` (including keys from before entries were scoped) when
 *  `keep` is true, or every entry inside it when false. */
export async function idbPrune(scope: string, keep: boolean): Promise<void> {
  const db = await openCacheDb();
  if (db === null) return;
  cacheSeed = null;
  try {
    const tx = db.transaction(IDB_STORE, "readwrite");
    const ended = transactionEnded(tx);
    const store = tx.objectStore(IDB_STORE);
    const req = store.getAllKeys();
    const prefix = idbKey(scope, "");
    // oxlint-disable-next-line prefer-add-event-listener -- IDBRequest does not support addEventListener
    req.onsuccess = () => {
      for (const key of req.result) {
        const inside = typeof key === "string" && key.startsWith(prefix);
        if (inside !== keep) store.delete(key);
      }
    };
    await ended;
  } catch {
    dropCacheDb(db);
  }
}

/** A durable entry: the image, its size, and when it was last read. */
interface StoredImage {
  blob: Blob;
  bytes: number;
  used: number;
}

/** False for an entry written before images were stored as Blobs (a data:
 *  URI string): a read treats it as a miss and the next write drops it. */
function isStoredImage(value: unknown): value is StoredImage {
  const entry = value as Partial<StoredImage> | null;
  return (
    typeof entry === "object" &&
    entry !== null &&
    entry.blob instanceof Blob &&
    typeof entry.bytes === "number"
  );
}

/** How stale an entry's read time gets before a read refreshes it. The
 *  refresh rewrites the whole record, Blob included, so the eviction order
 *  is only approximately least recently read. */
const IDB_TOUCH_AFTER_MS = 24 * 60 * 60 * 1000;

/** Refresh an entry's read time, unless it went away since it was read. */
function idbTouch(db: IDBDatabase, key: string): void {
  const store = db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE);
  const req = store.get(key);
  // oxlint-disable-next-line prefer-add-event-listener -- IDBRequest does not support addEventListener
  req.onsuccess = () => {
    const entry: unknown = req.result;
    if (isStoredImage(entry)) store.put({ ...entry, used: Date.now() }, key);
  };
}

/** Read a cached image from IndexedDB by its scoped key, marking it read
 *  when its read time is stale. */
export async function idbGet(key: string): Promise<Blob | null> {
  const db = await openCacheDb();
  if (db === null) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(key);
      // oxlint-disable-next-line prefer-add-event-listener -- IDBRequest does not support addEventListener
      req.onsuccess = () => {
        const entry: unknown = req.result;
        if (!isStoredImage(entry)) {
          resolve(null);
          return;
        }
        if (Date.now() - entry.used >= IDB_TOUCH_AFTER_MS) {
          try {
            idbTouch(db, key);
          } catch {
            // The database closed first — the read time stays stale
          }
        }
        resolve(entry.blob);
      };
      // oxlint-disable-next-line prefer-add-event-listener -- IDBRequest does not support addEventListener
      req.onerror = () => resolve(null);
    } catch {
      dropCacheDb(db);
      resolve(null);
    }
  });
}

/** Walk the entries oldest-read first, deleting until the store fits
 *  IMAGE_DB_MAX_BYTES again. Stops if the count was dropped meanwhile. */
function evictOldest(store: IDBObjectStore, seed: Promise<boolean>): void {
  if (cacheTotal <= IMAGE_DB_MAX_BYTES) return;
  const req = store.index(IDB_USED_INDEX).openCursor();
  // oxlint-disable-next-line prefer-add-event-listener -- IDBRequest does not support addEventListener
  req.onsuccess = () => {
    const cursor = req.result;
    if (cursor === null || cacheSeed !== seed || cacheTotal <= IMAGE_DB_MAX_BYTES) return;
    const value: unknown = cursor.value;
    cursor.delete();
    if (isStoredImage(value)) cacheTotal -= value.bytes;
    cursor.continue();
  };
}

/** Write an image to IndexedDB under `scope`, unless the scope moved on
 *  while the database opened — a late write would outlive the prune. The
 *  same transaction then drops the least recently read entries until the
 *  store fits IMAGE_DB_MAX_BYTES. */
export async function idbPut(scope: string, url: string, blob: Blob): Promise<void> {
  const db = await openCacheDb();
  if (db === null) return;
  const seed = cacheSeed ?? seedCacheTotal(db);
  if (!(await seed)) return;
  if (scope !== cacheScope) return;
  try {
    const tx = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    const entry: StoredImage = { blob, bytes: blob.size, used: Date.now() };
    store.put(entry, idbKey(scope, url));
    if (cacheSeed === seed) {
      cacheTotal += entry.bytes;
      evictOldest(store, seed);
    }
    void transactionEnded(tx).then((ok) => {
      if (!ok && cacheSeed === seed) cacheSeed = null;
    });
  } catch {
    dropCacheDb(db);
    // IndexedDB full or unavailable — ignore
  }
}
