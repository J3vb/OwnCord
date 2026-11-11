/**
 * The main page's own presence: restoring the saved status on connect and
 * applying a status change.
 */
import type { UserStatus } from "@lib/types";
import { authStore } from "@stores/auth.store";
import {
  loadUserStatus,
  loadUserStatusOrigin,
  onUserStatusChange,
  saveUserStatus,
} from "@lib/presence/userStatus";
import { uiStore } from "@stores/ui.store";
import type { PageState, PageApi } from "./pageState";

export function createPagePresence(st: PageState, _pg: PageApi) {
  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** A status was picked by hand on this device while the socket was down (or
   *  before the first connect of this page, such as a timer that ended while
   *  the app was closed), so the server has not heard it and must not overrule
   *  it on reconnect. */
  let pickedUnsent = false;
  let connectedOnce = false;
  st.unsubscribers.push(
    onUserStatusChange(() => {
      const live = connectedOnce && uiStore.getState().connectionStatus === "connected";
      if (!live && loadUserStatusOrigin() === "manual") pickedUnsent = true;
    }),
  );

  /**
   * Re-assert the status the user picked, if the server disagrees.
   *
   * This used to fire on every connect, because the server stamped everyone
   * online at handshake and the client had to race to correct it — which is
   * what made a chosen Do Not Disturb (and "appear offline") flash online on
   * every reconnect. The server now reads the saved status and announces
   * *that*, so this is a no-op in the normal case. When the two differ, the
   * server is the newer one unless the user picked a status on this device
   * while the socket was down: then that pick is sent. Otherwise another
   * device chose it, and it is adopted here, so this device does not put its
   * own old status back over it. An older server that reports no status, or
   * an idle one, is still answered with the saved status.
   */
  function restoreSavedPresence(): void {
    const status = loadUserStatus();
    const serverStatus = authStore.getState().user?.status;
    const pickedWhileOffline = pickedUnsent;
    pickedUnsent = false;
    connectedOnce = true;
    if (serverStatus === status) return;
    const adoptable =
      serverStatus === "online" || serverStatus === "dnd" || serverStatus === "invisible";
    if (adoptable && !pickedWhileOffline) {
      saveUserStatus(serverStatus);
      return;
    }
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
