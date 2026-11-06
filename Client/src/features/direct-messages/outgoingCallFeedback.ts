/** What the caller is told when their ring ends without a call. */

import { showToast } from "@lib/ui/toast";
import type { OutgoingCallState } from "@lib/voice/callRing";
import { channelsStore } from "@stores/channels.store";
import { uiStore } from "@stores/ui.store";
import { dmStore, dmDisplayName, type DmChannel } from "@stores/dm.store";
import { membersStore, memberDisplayName } from "@stores/members.store";
import { dmCallText } from "../../i18n/dmCall";

const OUTCOME_TOAST_MS = 6000;

/** Whether the DM's call panel, the caller's feedback, is what is on screen. */
function panelShows(channelId: number): boolean {
  const ui = uiStore.getState();
  return (
    ui.activeView === null &&
    !ui.settingsOpen &&
    channelsStore.getState().activeChannelId === channelId
  );
}

/**
 * The same name the call panel would show: a 1:1 DM resolves the recipient
 * through the members store (the nickname every other identity surface uses),
 * a group uses the DM's own name.
 */
function calleeName(dm: DmChannel | undefined): string {
  const name = dm !== undefined ? dmDisplayName(dm) : "";
  if (dm === undefined || dm.isGroup) return name;
  const member = membersStore.getState().members.get(dm.recipient.id);
  return (
    (member !== undefined ? memberDisplayName(member) : "") ||
    (dm.recipient.displayName ?? "") ||
    dm.recipient.username ||
    name
  );
}

function outcomeText(phase: OutgoingCallState["phase"], name: string): string {
  if (phase === "declined") return dmCallText("declinedStatus", { name });
  if (phase === "offline") return dmCallText("offline", { name });
  return dmCallText("noAnswerStatus");
}

/**
 * The panel is the caller's feedback only while their DM is on screen;
 * elsewhere the ringback and a toast are all they get.
 */
export function toastOutgoingCallOutcome(state: OutgoingCallState | null): void {
  if (state === null || state.phase === "ringing") return;
  if (panelShows(state.channelId)) return;
  const dm = dmStore.getState().channels.find((c) => c.channelId === state.channelId);
  showToast(outcomeText(state.phase, calleeName(dm)), "info", OUTCOME_TOAST_MS);
}
