/**
 * The main page's own presence: restoring the saved status on connect and
 * applying a status change.
 */
import type { UserStatus } from "@lib/types";
import { authStore } from "@stores/auth.store";
import {
  loadAgreedStatus,
  loadUserStatus,
  loadUserStatusOrigin,
  onUserStatusChange,
  saveAgreedStatus,
  saveUserStatus,
} from "@lib/presence/userStatus";
import { getChannelMutesHost } from "@lib/prefs/channelMutes";
import { uiStore } from "@stores/ui.store";
import type { PageState, PageApi } from "./pageState";

/** The statuses a server keeps for the whole account. Idle is one connection's. */
function isAccountStatus(status: UserStatus | undefined): status is UserStatus {
  return status === "online" || status === "dnd" || status === "invisible";
}

/** What the user chose on this device: an idle the idle watcher set stands for
 *  the Online it goes back to. */
function chosenStatus(status: UserStatus): UserStatus {
  return status === "idle" && loadUserStatusOrigin() === "auto" ? "online" : status;
}

export function createPagePresence(st: PageState, _pg: PageApi) {
  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** The server account this page is connected to, once a connect has said so. */
  let owner: string | null = null;

  // A status saved while the socket is up is one the server hears (a pick
  // here) or already holds (another device's, adopted from a live presence),
  // so it becomes the agreed one. One saved while the socket is down does
  // not: the next connect finds it differs from the agreement and sends it.
  st.unsubscribers.push(
    onUserStatusChange((status) => {
      if (owner === null || uiStore.getState().connectionStatus !== "connected") return;
      saveAgreedStatus(owner, chosenStatus(status));
    }),
  );

  /**
   * Bring the saved status and the server's into line on connect.
   *
   * The server announces the account's stored status at handshake, so the two
   * are equal in the normal case. When they differ, the one that changed since
   * they last agreed wins:
   *  - the saved status still equals the agreement with this server account
   *    (or there is none yet, a first sign-in): another device chose the
   *    server's, and it is adopted here, so this device does not put its own
   *    old status back over it;
   *  - otherwise the user chose here while the socket was down, or was last
   *    connected to another server (the saved status and its timer are one per
   *    device, and follow the user from server to server): the saved status is
   *    sent.
   * A server that reports no status, or an idle one, is answered with the
   * saved status as well.
   */
  function restoreSavedPresence(): void {
    const user = authStore.getState().user;
    const account = `${getChannelMutesHost() ?? ""}#${user?.id ?? 0}`;
    owner = account;
    const status = loadUserStatus();
    const chosen = chosenStatus(status);
    const serverStatus = user?.status;
    const agreed = loadAgreedStatus();
    if (serverStatus !== status && isAccountStatus(serverStatus)) {
      const unchangedHere =
        agreed === null || (agreed.owner === account && agreed.status === chosen);
      if (unchangedHere) {
        saveUserStatus(serverStatus);
        saveAgreedStatus(account, serverStatus);
        return;
      }
    }
    if (serverStatus !== status) applyPresence(status);
    saveAgreedStatus(account, chosen);
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
