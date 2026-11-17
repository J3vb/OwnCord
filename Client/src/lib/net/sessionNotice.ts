/**
 * session-notice — tell the user about a sign-in they have not reviewed yet.
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
 *
 * A listing costs a fresh REST call (and its own TLS handshake through the
 * desktop tunnel), and listing IS the acknowledgement, so there is nothing to
 * gain from repeating it within minutes. A minimum interval collapses the
 * focus+visibility pair, a rapid alt-tab and a quick reconnect into one
 * request; the next event past the interval lists again.
 */

import type { SessionInfo } from "@lib/api";
import { createLogger } from "@lib/logger";

const log = createLogger("session-notice");

/**
 * Minimum time between listings. The window is short enough that a genuine
 * return still refreshes the notice, and long enough that the focus +
 * visibility pair, a quick alt-tab and a reconnect make one request.
 */
export const MIN_POLL_INTERVAL_MS = 30_000;

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
  let lastPolledAt = Number.NEGATIVE_INFINITY;

  const poll = (): void => {
    // focus and visibilitychange usually fire together; one listing is enough.
    if (inFlight || signal.aborted) return;
    if (Date.now() - lastPolledAt < MIN_POLL_INTERVAL_MS) return;
    inFlight = true;
    fetchSessions(signal)
      .then((sessions) => {
        lastPolledAt = Date.now();
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
