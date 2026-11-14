/**
 * The server icons shown in the server rail: one `{hash, dataUrl}` per host,
 * persisted so the rail has a picture before any connection. The hash is the
 * one `server-info` reports; a different one means the owner changed the icon.
 * The store is bounded (entry count and size), and the rail prunes it to the
 * servers that are still saved, so a long-lived install or a hostile server
 * cannot fill localStorage and a saved server is not evicted by churn.
 */

import { loadStoredJson, saveStoredJson } from "./preferences";

export const SERVER_ICONS_KEY = "owncord:server-icons";
/** The window event fired when an entry is stored or dropped. */
export const SERVER_ICON_CHANGED = "owncord:server-icon-changed";
/** A backstop for a very long server list; the rail also prunes to the saved servers. */
export const SERVER_ICONS_MAX = 32;
/** The server caps an icon at 64 KiB; base64 of that is about 88k characters. */
export const SERVER_ICON_DATA_URL_MAX = 90_000;
const DATA_URL_PREFIX = "data:image/png;base64,";
const HASH_PATTERN = /^[0-9a-f]{16}$/;

export interface CachedServerIcon {
  readonly hash: string;
  readonly dataUrl: string;
}

interface Entry extends CachedServerIcon {
  readonly host: string;
}

function parseEntry(value: unknown): Entry | null {
  if (typeof value !== "object" || value === null) return null;
  const { host, hash, dataUrl } = value as Record<string, unknown>;
  if (typeof host !== "string" || typeof hash !== "string" || typeof dataUrl !== "string") {
    return null;
  }
  if (!HASH_PATTERN.test(hash) || !isIconDataUrl(dataUrl)) return null;
  return { host, hash, dataUrl };
}

function isIconDataUrl(dataUrl: string): boolean {
  return dataUrl.startsWith(DATA_URL_PREFIX) && dataUrl.length <= SERVER_ICON_DATA_URL_MAX;
}

function loadEntries(): Entry[] {
  return loadStoredJson<Entry[]>(
    SERVER_ICONS_KEY,
    (value) => {
      if (!Array.isArray(value)) throw new Error(SERVER_ICONS_KEY); // i18n-exempt: never shown
      const out: Entry[] = [];
      for (const raw of value) {
        const entry = parseEntry(raw);
        if (entry !== null && !out.some((e) => e.host === entry.host)) out.push(entry);
      }
      return out.slice(-SERVER_ICONS_MAX);
    },
    [],
  );
}

function announce(): void {
  window.dispatchEvent(new Event(SERVER_ICON_CHANGED));
}

/** Every cached icon by host, read once so a render does one parse. */
export function loadServerIcons(): ReadonlyMap<string, CachedServerIcon> {
  return new Map(loadEntries().map((e) => [e.host, { hash: e.hash, dataUrl: e.dataUrl }]));
}

/** The cached icon for `host`, if any. */
export function cachedServerIcon(host: string): CachedServerIcon | undefined {
  return loadServerIcons().get(host);
}

/** Keep `icon` for `host` as the newest entry; false when it is refused or storage is unusable. */
export function storeServerIcon(host: string, icon: CachedServerIcon): boolean {
  if (!HASH_PATTERN.test(icon.hash) || !isIconDataUrl(icon.dataUrl)) return false;
  const kept = loadEntries().filter((e) => e.host !== host);
  kept.push({ host, hash: icon.hash, dataUrl: icon.dataUrl });
  const saved = saveStoredJson(SERVER_ICONS_KEY, kept.slice(-SERVER_ICONS_MAX));
  if (saved) announce();
  return saved;
}

/** Forget the icon for `host`. */
export function dropServerIcon(host: string): void {
  const all = loadEntries();
  const kept = all.filter((e) => e.host !== host);
  if (kept.length === all.length) return;
  if (saveStoredJson(SERVER_ICONS_KEY, kept)) announce();
}

/** Forget the icons of every host not in `keep`, so a removed server leaves nothing behind. */
export function pruneServerIcons(keep: Iterable<string>): void {
  const hosts = new Set(keep);
  const all = loadEntries();
  const kept = all.filter((e) => hosts.has(e.host));
  if (kept.length === all.length) return;
  if (saveStoredJson(SERVER_ICONS_KEY, kept)) announce();
}

/**
 * Bring `host`'s cached icon in line with the hash its `server-info` reported.
 * An empty hash means the owner removed the icon: the entry goes and the rail
 * falls back to initials. A hash the cache already holds needs nothing. A
 * different one is fetched through `fetchDataUrl` (the client's pinned HTTP
 * path) and replaces the entry. An absent hash (an older server) and a failed
 * fetch change nothing.
 */
export async function syncServerIcon(
  host: string,
  hash: string | undefined,
  fetchDataUrl: () => Promise<string | null>,
): Promise<void> {
  if (hash === undefined) return;
  if (hash === "") {
    dropServerIcon(host);
    return;
  }
  if (!HASH_PATTERN.test(hash) || cachedServerIcon(host)?.hash === hash) return;
  const dataUrl = await fetchDataUrl();
  if (dataUrl !== null) storeServerIcon(host, { hash, dataUrl });
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
/** The server's icon limit; a longer body is not an icon. */
export const SERVER_ICON_MAX_BYTES = 64 * 1024;

/** A `data:` URL for PNG `bytes`, or null when they are not a PNG within the server's icon limit. */
export function pngDataUrl(bytes: Uint8Array): string | null {
  if (bytes.length === 0 || bytes.length > SERVER_ICON_MAX_BYTES) return null;
  if (!PNG_MAGIC.every((b, i) => bytes[i] === b)) return null;
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `${DATA_URL_PREFIX}${btoa(binary)}`;
}
