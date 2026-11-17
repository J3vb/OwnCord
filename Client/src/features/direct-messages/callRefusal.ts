/**
 * A call_ring the server refused because the other person has not accepted
 * this user's message request. Reached from the dispatcher's `error` chain
 * only (through handleVoiceError).
 */
import { voiceStore, leaveVoiceChannel } from "../../stores/voice.store";
import { authStore } from "../../stores/auth.store";
import { channelsStore } from "../../stores/channels.store";
import { dmStore, dmDisplayName } from "../../stores/dm.store";
import { uiStore } from "../../stores/ui.store";
import { showToast } from "../../lib/ui/toast";
import { requestsText } from "../../i18n/requests";
import { WsErrorCode } from "@lib/protocolTypes";
import { livekitSession } from "../connection/dispatchContext";
import type { Payload } from "../connection/dispatchContext";
import { joinSequence } from "../voice/joinRequest";
import { markRequestPending, takeRingChannel } from "./pendingRequests";

/**
 * Mark the DM as waiting, end the call this user joined to ring them, and say
 * why: the notice above that DM's composer says it when the DM is on screen,
 * a toast naming the person when it is not. Returns true when the frame was that refusal of one of this client's
 * rings, so no generic toast follows.
 */
export function handleCallRefusal(payload: Payload<"error">, id: string | undefined): boolean {
  if (payload.code !== WsErrorCode.CALL_REQUIRES_ACCEPTANCE) return false;
  const channelId = takeRingChannel(id);
  if (channelId === null) return false;
  markRequestPending(channelId);
  leaveRefusedCall(channelId);
  if (!dmOnScreen(channelId)) {
    showToast(requestsText("dm.callNeedsAcceptance", { name: otherName(channelId) }), "error");
  }
  return true;
}

function dmOnScreen(channelId: number): boolean {
  const ui = uiStore.getState();
  return (
    channelsStore.getState().activeChannelId === channelId &&
    ui.activeView === null &&
    !ui.settingsOpen
  );
}

function otherName(channelId: number): string {
  const dm = dmStore.getState().channels.find((c) => c.channelId === channelId);
  return dm === undefined ? requestsText("dm.callNeedsAcceptanceFallback") : dmDisplayName(dm);
}

/**
 * Leave the DM's call the caller sits in alone, and only that one: a switch
 * in flight or a join sent since owns the session, and a call someone else is
 * already in is a real call.
 */
function leaveRefusedCall(channelId: number): void {
  const voice = voiceStore.getState();
  if (voice.currentChannelId !== channelId || (voice.switchingTo ?? null) !== null) return;
  const self = authStore.getState().user?.id;
  const roster = voice.voiceUsers.get(channelId);
  if (roster !== undefined && [...roster.keys()].some((uid) => uid !== self)) return;
  const refusedJoin = joinSequence();
  void livekitSession().then(({ leaveVoice }) => {
    if (joinSequence() === refusedJoin) void leaveVoice(true);
  });
  leaveVoiceChannel();
}
