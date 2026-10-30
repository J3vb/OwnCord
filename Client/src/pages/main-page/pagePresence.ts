/**
 * The main page's own presence: restoring the saved status on connect and
 * applying a status change.
 */
import type { UserStatus } from "@lib/types";
import { authStore } from "@stores/auth.store";
import { loadUserStatus } from "@lib/presence/userStatus";
import type { PageState, PageApi } from "./pageState";

export function createPagePresence(st: PageState, _pg: PageApi) {
  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Re-assert the status the user picked, if the server disagrees.
   *
   * This used to fire on every connect, because the server stamped everyone
   * online at handshake and the client had to race to correct it — which is
   * what made a chosen Do Not Disturb (and "appear offline") flash online on
   * every reconnect. The server now reads the saved status and announces
   * *that*, so this is a no-op in the normal case and only speaks up when the
   * two genuinely differ (an older server, or a status changed while the
   * socket was down).
   */
  function restoreSavedPresence(): void {
    const status = loadUserStatus();
    const serverStatus = authStore.getState().user?.status;
    if (serverStatus === status) return;
    applyPresence(status);
  }

  /** Send a presence change and reflect it locally. Shared by the settings
   *  tab, the user bar and the auto-idle timer so all three agree.
   *
   *  The presence limiter is 1 token per 10s, and auto-idle's return-to-
   *  online fires unthrottled milliseconds after its own idle transition
   *  (autoIdle.ts) — routinely losing the token race. Dropping that frame
   *  silently would leave the server, and everyone else's member list,
   *  stuck on "idle" with nothing left to correct it. `presenceSender`
   *  retries once the window reopens instead, re-reading the status at that
   *  time so a burst of calls in between coalesces onto one retry carrying
   *  the latest value — see @lib/presence/presence. */
  function applyPresence(status: UserStatus): void {
    st.presenceSender.send(status);
  }

  return { restoreSavedPresence, applyPresence };
}
