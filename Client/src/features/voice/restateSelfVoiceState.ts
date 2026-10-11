// Re-tells the server our own mute/deafen when its row for us can differ from
// the local state: a fresh join or channel switch (the server writes the new
// row unmuted and undeafened, while the client keeps localMuted/localDeafened
// across a leave) and a chat socket that came back after the user toggled
// mute offline (the toggles apply locally and send nothing while it is down).
import { authStore } from "../../stores/auth.store";
import { voiceStore } from "../../stores/voice.store";
import type { WsClient } from "../../lib/ws";

export interface RestateOptions {
  /** The caller knows the local mute is not the member's own (a moderator's). */
  readonly skipMute?: boolean;
  readonly skipDeafen?: boolean;
}

export function restateSelfVoiceState(
  ws: Pick<WsClient, "send">,
  options: RestateOptions = {},
): void {
  const state = voiceStore.getState();
  if (state.currentChannelId === null) return;
  const userId = authStore.getState().user?.id ?? 0;
  if (userId === 0) return;

  const row = state.voiceUsers.get(state.currentChannelId)?.get(userId);
  const serverMuted = row?.muted ?? false;
  const serverDeafened = row?.deafened ?? false;

  // A moderator's mute or deafen is not the member's own state to restate:
  // sending it would turn it into a self-mute that outlives the lift.
  const moderated = state.localServerDeafened === true || state.moderatorDeafened === true;
  const skipMute = options.skipMute === true || state.localServerMuted === true || moderated;
  const skipDeafen = options.skipDeafen === true || moderated;

  if (!skipMute && state.localMuted !== serverMuted) {
    ws.send({ type: "voice_mute", payload: { muted: state.localMuted } });
  }
  if (!skipDeafen && state.localDeafened !== serverDeafened) {
    ws.send({ type: "voice_deafen", payload: { deafened: state.localDeafened } });
  }
}
