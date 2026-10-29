// The browser platform's identity store: the client's own identity
// key blob and peers' pinned public keys, in IndexedDB. Two object stores in
// one database: `keys` by host (the app folds the user id into that string),
// and `pins` by host and user id.
//
// The contract's outcomes hold as on desktop. A key read that fails rejects,
// so the app never takes an unreadable store for "no key". A pin read that
// fails — including a database that will not open, or a stored value that is
// not a pin — answers "unavailable", never "unpinned" (`lib/identity.ts`).
// A page whose IndexedDB is missing or cannot be reached answers the same way
// as a failing store: this adapter only runs where a store is expected, and
// the inert registry member is the one that answers "no store".
import type {
  IdentityPinLookup,
  IdentityStore,
  StoreIdentityPinResult,
} from "../contracts/identityStore";
import { UnavailableError } from "./unavailable";

const DB_NAME = "owncord-identity";
const DB_VERSION = 1;
const KEYS = "keys";
const PINS = "pins";
type StoreName = typeof KEYS | typeof PINS;

/** The page's IndexedDB. Throws, like any other store failure, when the page
 *  has none or may not use it. */
function factory(): IDBFactory {
  const found: IDBFactory | undefined = globalThis.indexedDB;
  if (found === undefined || found === null) throw new UnavailableError();
  return found;
}

let opening: Promise<IDBDatabase> | null = null;

/** The open database, shared by every call until it closes or fails. */
function database(): Promise<IDBDatabase> {
  if (opening !== null) return opening;
  const idb = factory();
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
    // Another tab holds an older version open: fail this attempt rather than
    // wait, so a later call opens again.
    // oxlint-disable-next-line prefer-add-event-listener -- IDBRequest does not support addEventListener
    request.onblocked = () => reject(new Error("identity database open was blocked")); // i18n-exempt: diagnostic
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
  storeName: StoreName,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest,
): Promise<unknown> {
  const db = await database();
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
    try {
      await run(KEYS, "readwrite", (store) => store.put(key, host));
      return true;
    } catch {
      return false;
    }
  },

  async loadKey(host): Promise<string | null> {
    // A failure propagates: the caller must not mint a key over one it
    // could not read.
    const value = await run(KEYS, "readonly", (store) => store.get(host));
    return typeof value === "string" ? value : null;
  },

  async deleteKey(host): Promise<boolean> {
    try {
      await run(KEYS, "readwrite", (store) => store.delete(host));
      return true;
    } catch {
      return false;
    }
  },

  async storePin(host, userId, pin): Promise<StoreIdentityPinResult> {
    try {
      await run(PINS, "readwrite", (store) => store.put(pin, pinKey(host, userId)));
      return "stored";
    } catch {
      return "failed";
    }
  },

  async getPin(host, userId): Promise<IdentityPinLookup> {
    let value: unknown;
    try {
      value = await run(PINS, "readonly", (store) => store.get(pinKey(host, userId)));
    } catch {
      return { status: "unavailable" };
    }
    if (value === undefined) return { status: "unpinned" };
    return typeof value === "string" ? { status: "pinned", pin: value } : { status: "unavailable" };
  },
};
