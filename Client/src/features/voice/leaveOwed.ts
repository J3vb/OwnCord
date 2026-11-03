/**
 * A voice leave the server may not have seen. A leave made while the chat
 * socket is down (or half-open) never reaches the server, and a resume can
 * then hand this device back a membership it already gave up: the user stays
 * listed in the channel for everyone. So every leave is owed until the
 * server's own voice_leave for it comes back, a new join goes out, or the
 * next handshake sends it again. A voice_leave only ends the membership held
 * by the socket that sends it, so a repeated one never touches another
 * device's call. Its own leaf module: the leave paths sit in both the startup
 * chunk and the lazy LiveKit chunk.
 */

import { registerSessionReset } from "@lib/net/sessionRegistry";
import { voiceStore } from "@stores/voice.store";

interface VoiceLeaveSender {
  send(msg: { type: "voice_leave"; payload: Record<string, never> }): string;
}

let owed = false;
let owedChannelId: number | null = null;

/** This device is leaving its call. Call before the store's leave clears the
 *  current channel. */
export function noteVoiceLeave(): void {
  owed = true;
  owedChannelId = voiceStore.getState().currentChannelId;
}

/** The server announced this user's leave of `channelId`. */
export function settleVoiceLeave(channelId: number): void {
  if (owed && owedChannelId === channelId) clearOwedLeave();
}

/** A new join supersedes any owed leave. */
export function clearOwedLeave(): void {
  owed = false;
  owedChannelId = null;
}

/** Whether a leave is owed (tests and diagnostics). */
export function isVoiceLeaveOwed(): boolean {
  return owed;
}

/**
 * On a handshake: send the owed leave once while this device holds no call.
 * A device back in a call has joined since, so the leave is dropped.
 */
export function sendOwedVoiceLeave(ws: VoiceLeaveSender): boolean {
  if (!owed) return false;
  clearOwedLeave();
  if (voiceStore.getState().voiceStatus !== "idle") return false;
  ws.send({ type: "voice_leave", payload: {} });
  return true;
}

void registerSessionReset("voice:leave-owed", clearOwedLeave, { phase: "cache" }); // app-lifetime
