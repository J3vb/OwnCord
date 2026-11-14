// Keeps the rail's cached server icon for a host in step with the hash its
// `server-info` reports. Loaded lazily by serverHealth.ts.

import type { ApiClient } from "@lib/api";
import { createLogger } from "@lib/logger";
import { ensureHttpProxy } from "@lib/net/httpProxy";
import { SessionScope } from "@lib/net/sessionScope";
import {
  SERVER_ICON_MAX_BYTES,
  pngDataUrl,
  syncServerIcon,
} from "../features/server-rail/serverIcons";
import type { ServerInfoResponse } from "@lib/types";
import { desktop } from "../platform/desktop";

const log = createLogger("main");
const FETCH_TIMEOUT_MS = 5000;

/**
 * The body of `res`, or null when it passes `max` bytes. A declared
 * Content-Length over the cap is refused before reading; the body is read as a
 * stream and abandoned at the cap, so a server that lies about its length, or
 * sends it chunked, cannot make the client buffer more than `max` bytes. A
 * response without a readable stream (no `body`) is read whole and checked
 * after, the only option such a response leaves.
 */
export async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  const reader = res.body?.getReader();
  if (reader === undefined) {
    const whole = new Uint8Array(await res.arrayBuffer());
    return whole.length <= max ? whole : null;
  }
  const chunks = await drain(reader, max, [], 0);
  if (chunks === null) return null;
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** Reads `reader` to its end, or cancels it and returns null once `total` would pass `max`. */
async function drain(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  max: number,
  chunks: Uint8Array[],
  total: number,
): Promise<Uint8Array[] | null> {
  const { done, value } = await reader.read();
  if (done) return chunks;
  if (total + value.length > max) {
    await reader.cancel();
    return null;
  }
  chunks.push(value);
  return drain(reader, max, chunks, total + value.length);
}

/**
 * The icon of `host` through the client's pinned HTTP path (the one
 * `getServerInfo` uses), never an `<img src>` to the remote origin.
 */
async function fetchIconBytes(api: ApiClient, host: string): Promise<Uint8Array | null> {
  const owner = new SessionScope({ host, generation: api.getSession().identity.generation });
  const timer = setTimeout(() => owner.dispose(), FETCH_TIMEOUT_MS);
  try {
    const origin = await owner.run(ensureHttpProxy(host));
    const res = await owner.run(
      desktop.http.fetch(`${origin}/api/v1/server-icon`, { signal: owner.signal }),
    );
    if (!res.ok) return null;
    return await owner.run(readCapped(res, SERVER_ICON_MAX_BYTES));
  } finally {
    clearTimeout(timer);
    owner.dispose();
  }
}

/**
 * A changed hash is refetched, an empty one drops the entry. Best effort: the
 * rail shows initials until a picture is cached. The fetch has its own lifetime,
 * bounded by its timeout, so signing in before it answers (which disposes the
 * connect page that started it) does not cancel it.
 */
export async function refreshServerIcon(
  api: ApiClient,
  host: string,
  info: ServerInfoResponse,
): Promise<void> {
  try {
    await syncServerIcon(host, info.icon, async () => {
      const bytes = await fetchIconBytes(api, host);
      return bytes === null ? null : pngDataUrl(bytes);
    });
  } catch (err) {
    log.debug("server icon refresh failed", { host, error: String(err) });
  }
}
