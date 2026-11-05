import { authStore } from "@stores/auth.store";

/**
 * How long an uploaded, unsent attachment id is trusted when the server does not
 * say. An older server sweeps unlinked attachments about an hour after upload
 * and a send silently skips an id it no longer knows, so this sits a margin under
 * that hour.
 */
export const ATTACHMENT_TTL_MS = 50 * 60 * 1000;

/**
 * How long an uploaded, unsent attachment id is trusted on this server: a sixth
 * under the `staged_lifetime_seconds` auth_ok advertised, or ATTACHMENT_TTL_MS
 * without one. A staged chip past this age is never sent: it re-uploads from its
 * file, or is marked expired when the file is gone (a restored draft), and Send
 * refuses until it is fresh. A queued send checks the same age when its last
 * upload lands (sendQueue.ts).
 */
export function attachmentTtlMs(): number {
  const seconds = authStore.getState().uploadPolicy?.staged_lifetime_seconds;
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return ATTACHMENT_TTL_MS;
  return Math.floor((seconds * 1000 * 5) / 6);
}
