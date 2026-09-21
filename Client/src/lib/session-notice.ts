/**
 * session-notice — tell the user about a sign-in they have not reviewed yet
 * (B7-14).
 *
 * The server flags every new session `unseen`, and listing the sessions from
 * one device acknowledges every row but that device's own. So the list is
 * the transport — there is no WebSocket frame — and a flagged row is visible
 * in exactly one listing: the notice must fire from that response, with no
 * state that waits for a later poll to see the flag again.
 *
 * The caller's own row stays `unseen` on its own listings until another
 * device lists, so it is ignored — otherwise every device would announce its
 * own sign-in. A listing from another device may already have acknowledged
 * a sign-in, and this device may be told about an older one, which is why
 * the wording is "not yet reviewed", not "new".
 *
 * Polls once on start (the connect) and then on window focus / the document
 * becoming visible; the returned function polls again (a reconnect). No timer.
 */

import type { SessionInfo } from "@lib/api";
import { createLogger } from "@lib/logger";
import { formatMessageTimestamp } from "@components/message-list/formatting";

const log = createLogger("session-notice");

/**
 * Every desktop sign-in records one of two identical User-Agent strings — the
 * saved-password path's `OwnCord-Client/<version>` and tauri-plugin-http's
 * default — so they carry no per-device detail. Name them plainly; IP and
 * last-used are what tell two desktops apart. Anything else is shown as sent.
 */
const DESKTOP_USER_AGENT = /^(OwnCord-Client|tauri-plugin-http)\//;

export function sessionDeviceLabel(device: string): string {
  if (device === "") return "Unknown device";
  if (DESKTOP_USER_AGENT.test(device)) return "OwnCord desktop";
  return device;
}

/** "OwnCord desktop from 203.0.113.5, Today at 2:34 PM" */
export function describeSession(s: SessionInfo): string {
  const where = s.ip === "" ? "" : ` from ${s.ip}`;
  return `${sessionDeviceLabel(s.device)}${where}, ${formatMessageTimestamp(s.created_at)}`;
}

/** The toast text for one listing's unreviewed sign-ins (newest first). */
export function sessionNoticeMessage(unseen: readonly SessionInfo[]): string {
  const [newest] = unseen;
  if (newest === undefined) return "";
  const more = unseen.length > 1 ? ` and ${unseen.length - 1} more` : "";
  return (
    `A sign-in to your account you have not reviewed: ${describeSession(newest)}${more}. ` +
    "Review your devices in Settings > Account."
  );
}

export interface SessionNoticeOptions {
  readonly fetchSessions: (signal: AbortSignal) => Promise<readonly SessionInfo[]>;
  /** Called with the unreviewed sign-ins of one listing, newest first. */
  readonly notify: (unseen: readonly SessionInfo[]) => void;
  /** Aborting it removes the listeners and cancels an in-flight listing. */
  readonly signal: AbortSignal;
}

export function startSessionNotice({
  fetchSessions,
  notify,
  signal,
}: SessionNoticeOptions): () => void {
  let inFlight = false;

  const poll = (): void => {
    // focus and visibilitychange usually fire together; one listing is enough.
    if (inFlight || signal.aborted) return;
    inFlight = true;
    fetchSessions(signal)
      .then((sessions) => {
        if (signal.aborted) return;
        const unseen = sessions.filter((s) => s.unseen && !s.is_current);
        if (unseen.length > 0) notify(unseen);
      })
      .catch((err: unknown) => {
        if (!signal.aborted) log.warn("Sessions listing failed", err);
      })
      .finally(() => {
        inFlight = false;
      });
  };

  window.addEventListener("focus", poll, { signal });
  document.addEventListener(
    "visibilitychange",
    () => {
      if (!document.hidden) poll();
    },
    { signal },
  );
  poll();
  return poll;
}
