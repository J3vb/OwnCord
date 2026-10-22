// The browser platform's identity store (6.13c): the client's own identity
// key blob and peers' pinned public keys, in IndexedDB. Two object stores in
// one database: `keys` by host (the app folds the user id into that string),
// and `pins` by host and user id.
//
// The contract's outcomes hold as on desktop. A key read that fails rejects,
// so the app never takes an unreadable store for "no key". A pin read that
// fails — including a database that will not open, or a stored value that is
// not a pin — answers "unavailable", never "unpinned" (DC-08, `lib/identity.ts`).
// Only a page with no IndexedDB at all answers as a host with no store
// ("no-store" / "unpinned").
import type {
  IdentityPinLookup,
  IdentityStore,
  StoreIdentityPinResult,
} from "../contracts/identityStore";

const DB_NAME = "owncord-identity";
const DB_VERSION = 1;
const KEYS = "keys";
const PINS = "pins";
type StoreName = typeof KEYS | typeof PINS;

/** The page's IndexedDB, or null when it has none. */
function factory(): IDBFactory | null {
  try {
    const found: IDBFactory | undefined = globalThis.indexedDB;
    return found ?? null;
  } catch {
    return null;
  }
}

let opening: Promise<IDBDatabase> | null = null;

/** The open database, shared by every call until it closes or fails. */
function database(idb: IDBFactory): Promise<IDBDatabase> {
  if (opening !== null) return opening;
  const attempt = new Promise<IDBDatabase>((resolve, reject) => {
    const request = idb.open(DB_NAME, DB_VERSION);
    // oxlint-disable-next-line prefer-add-event-listener -- IDBRequest does not support addEventListener
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of [KEYS, PINS]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    // oxlint-disable-next-line prefer-add-event-listener -- IDBRequest does not support addEventListener
    request.onsuccess = () => {
      const db = request.result;
      // oxlint-disable-next-line prefer-add-event-listener -- IDBDatabase does not support addEventListener
      db.onversionchange = () => {
        if (opening === attempt) opening = null;
        db.close();
      };
      // oxlint-disable-next-line prefer-add-event-listener -- IDBDatabase does not support addEventListener
      db.onclose = () => {
        if (opening === attempt) opening = null;
      };
      resolve(db);
    };
    // oxlint-disable-next-line prefer-add-event-listener -- IDBRequest does not support addEventListener
    request.onerror = () => reject(request.error ?? new Error("identity database did not open")); // i18n-exempt: diagnostic
  });
  opening = attempt;
  // A failed open is not cached: the next call tries again.
  attempt.catch(() => {
    if (opening === attempt) opening = null;
  });
  return attempt;
}

/** Run one request in its own transaction; resolves with its result once the
 *  transaction commits, rejects on any request or transaction failure. */
async function run(
  idb: IDBFactory,
  storeName: StoreName,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest,
): Promise<unknown> {
  const db = await database(idb);
  return new Promise<unknown>((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = operation(tx.objectStore(storeName));
    const fail = (): void =>
      reject(tx.error ?? request.error ?? new Error("identity store request failed")); // i18n-exempt: diagnostic
    // oxlint-disable-next-line prefer-add-event-listener -- matches the IDBRequest handlers above
    tx.oncomplete = () => resolve(request.result);
    // oxlint-disable-next-line prefer-add-event-listener -- matches the IDBRequest handlers above
    tx.onerror = fail;
    // oxlint-disable-next-line prefer-add-event-listener -- matches the IDBRequest handlers above
    tx.onabort = fail;
  });
}

function pinKey(host: string, userId: string): string {
  return JSON.stringify([host, userId]);
}

export const identity: IdentityStore = {
  async saveKey(host, key): Promise<boolean> {
    const idb = factory();
    if (idb === null) return false;
    try {
      await run(idb, KEYS, "readwrite", (store) => store.put(key, host));
      return true;
    } catch {
      return false;
    }
  },

  async loadKey(host): Promise<string | null> {
    const idb = factory();
    if (idb === null) return null;
    // A failure propagates: the caller must not mint a key over one it
    // could not read.
    const value = await run(idb, KEYS, "readonly", (store) => store.get(host));
    return typeof value === "string" ? value : null;
  },

  async deleteKey(host): Promise<boolean> {
    const idb = factory();
    if (idb === null) return false;
    try {
      await run(idb, KEYS, "readwrite", (store) => store.delete(host));
      return true;
    } catch {
      return false;
    }
  },

  async storePin(host, userId, pin): Promise<StoreIdentityPinResult> {
    const idb = factory();
    if (idb === null) return "no-store";
    try {
      await run(idb, PINS, "readwrite", (store) => store.put(pin, pinKey(host, userId)));
      return "stored";
    } catch {
      return "failed";
    }
  },

  async getPin(host, userId): Promise<IdentityPinLookup> {
    const idb = factory();
    if (idb === null) return { status: "unpinned" };
    let value: unknown;
    try {
      value = await run(idb, PINS, "readonly", (store) => store.get(pinKey(host, userId)));
    } catch {
      return { status: "unavailable" };
    }
    if (value === undefined) return { status: "unpinned" };
    return typeof value === "string" ? { status: "pinned", pin: value } : { status: "unavailable" };
  },
};
