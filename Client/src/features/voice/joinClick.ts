// The user's own voice_join: a click on a voice channel, a DM call, or the
// password dialog's submit.
import { joinVoiceChannel, setSwitchingTo, voiceStore } from "../../stores/voice.store";
import type { DispatchWs } from "../connection/dispatchContext";
import { noteJoinSent } from "./joinRequest";

/**
 * Send the user's join of `channelId`, with the password they typed if any.
 *
 * Out of a live call this is a switch, and the server keeps that call until
 * the switch passed every check (a password, a full channel): so does this
 * device. The store keeps naming the call the user is in and only records
 * where they are heading; the voice_leave of the old call or the new
 * voice_token moves it, and a refusal leaves the call as it was. Any other
 * join names its channel at once, so the widget reads "Connecting…" from the
 * click.
 */
export function sendUserJoin(
  ws: Pick<DispatchWs, "send">,
  channelId: number,
  password?: string,
): void {
  const { currentChannelId, voiceStatus } = voiceStore.getState();
  const keepsCall = currentChannelId !== null && voiceStatus === "connected";
  if (keepsCall) setSwitchingTo(channelId);
  else joinVoiceChannel(channelId);
  // The user's own join: the server's rejoin block after a moderator move or
  // kick refuses only automatic rejoins (voice_rejoin_block.go).
  const payload =
    password === undefined
      ? { channel_id: channelId, user_initiated: true }
      : { channel_id: channelId, user_initiated: true, password };
  noteJoinSent(
    ws.send({ type: "voice_join", payload }),
    password !== undefined,
    keepsCall ? channelId : null,
  );
}

/** True while a switch out of a live call waits for the server: its answer
 *  decides where the user is, so another join has to wait for it. */
export function switchWaiting(): boolean {
  return (voiceStore.getState().switchingTo ?? null) !== null;
}
