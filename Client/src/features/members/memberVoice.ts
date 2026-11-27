/**
 * Which server voice room each member is in, for the member list. Pure: it
 * reads the voice roster and the channels through its parameters.
 */

import type { Channel } from "@stores/channels.store";
import type { VoiceUser } from "@stores/voice.store";

/** A server voice room as a member row needs it. */
export interface VoiceRoom {
  readonly channelId: number;
  readonly name: string;
  /** The server's AFK room. */
  readonly afk: boolean;
}

/**
 * Member id to the server voice room they are in. DM calls are not server
 * voice rooms and are left out; a member listed in two rooms keeps the first.
 */
export function voiceRoomsByUser(
  voiceUsers: ReadonlyMap<number, ReadonlyMap<number, VoiceUser>>,
  channels: ReadonlyMap<number, Channel>,
): ReadonlyMap<number, VoiceRoom> {
  const rooms = new Map<number, VoiceRoom>();
  for (const [channelId, users] of voiceUsers) {
    const channel = channels.get(channelId);
    if (channel?.type !== "voice") continue;
    const room: VoiceRoom = { channelId, name: channel.name, afk: channel.afk === true };
    for (const userId of users.keys()) {
      if (!rooms.has(userId)) rooms.set(userId, room);
    }
  }
  return rooms;
}

/** The user-to-room pairs with each room's name and AFK flag, in a fixed order,
 *  so two maps with the same pairs give the same key. Speaking, mute, camera
 *  and screen share are not in it. */
export function roomsKey(rooms: ReadonlyMap<number, VoiceRoom>): string {
  return [...rooms]
    .map(([userId, room]) => JSON.stringify([userId, room.channelId, room.name, room.afk]))
    .toSorted()
    .join("\n");
}
