/**
 * What the Join rule reads, taken from the stores at the moment of the call.
 * Nothing subscribes: the row menu calls this when it opens and again on the
 * click.
 */

import { authStore } from "@stores/auth.store";
import { channelsStore, type Channel } from "@stores/channels.store";
import { uiStore } from "@stores/ui.store";
import { voiceStore, type VoiceUser } from "@stores/voice.store";
import { safetyStore } from "../../safety/store";
import { switchWaiting } from "../../voice/joinClick";
import { voiceRoomsByUser } from "../memberVoice";
import type { JoinInputs, RoomCapacity } from "./joinTarget";

/** One entry per server voice room with a user limit; `connected` is the
 *  room's roster count, the number the tree's "n/max" shows. */
function roomCapacity(
  voiceUsers: ReadonlyMap<number, ReadonlyMap<number, VoiceUser>>,
  channels: ReadonlyMap<number, Channel>,
): ReadonlyMap<number, RoomCapacity> {
  const capacity = new Map<number, RoomCapacity>();
  for (const channel of channels.values()) {
    if (channel.type !== "voice" || channel.voiceMaxUsers <= 0) continue;
    capacity.set(channel.id, {
      connected: voiceUsers.get(channel.id)?.size ?? 0,
      max: channel.voiceMaxUsers,
      canModerateVoice: channel.canModerateVoice,
    });
  }
  return capacity;
}

/** The Join rule's inputs as the stores hold them now. */
export function currentJoinInputs(): JoinInputs {
  const { voiceUsers, currentChannelId } = voiceStore.getState();
  const channels = channelsStore.getState().channels;
  return {
    selfId: authStore.getState().user?.id ?? null,
    rooms: voiceRoomsByUser(voiceUsers, channels),
    capacity: roomCapacity(voiceUsers, channels),
    currentChannelId,
    switching: switchWaiting(),
    connected: uiStore.getState().connectionStatus === "connected",
    timedOut: safetyStore.getState().timeout !== null,
  };
}
