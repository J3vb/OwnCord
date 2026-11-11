/**
 * The main page's own presence: restoring the saved status on connect and
 * applying a status change.
 */
import type { UserStatus } from "@lib/types";
import { authStore } from "@stores/auth.store";
import { onUserStatusChange } from "@lib/presence/userStatus";
import { createStatusAgreement } from "@lib/presence/statusAgreement";
import { getChannelMutesHost } from "@lib/prefs/channelMutes";
import { uiStore } from "@stores/ui.store";
import type { PageState, PageApi } from "./pageState";

export function createPagePresence(st: PageState, _pg: PageApi) {
  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const agreement = createStatusAgreement(
    () => uiStore.getState().connectionStatus === "connected",
  );
  st.unsubscribers.push(onUserStatusChange((status) => agreement.saved(status)));

  /**
   * Bring the saved status and the server's into line on connect: adopt a
   * status another device chose, or send the one chosen here (the rules are in
   * lib/presence/statusAgreement).
   */
  function restoreSavedPresence(): void {
    const user = authStore.getState().user;
    const account = `${getChannelMutesHost() ?? ""}#${user?.id ?? 0}`;
    const toSend = agreement.settle(account, user?.status);
    if (toSend !== null) applyPresence(toSend);
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
