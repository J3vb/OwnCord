/**
 * Buddies' row context: the server voice room each member is in. It fires
 * only when a member joins, leaves or moves room, or a room is renamed or
 * changes its AFK flag; speaking, mute, camera and screen share do not.
 */

import { select } from "@lib/ui/select";
import { channelsStore } from "@stores/channels.store";
import { voiceStore } from "@stores/voice.store";
import type { RowContextSource } from "../memberRowRenderer";
import { roomsKey, voiceRoomsByUser, type VoiceRoom } from "../memberVoice";

export type BuddyContext = { readonly rooms: ReadonlyMap<number, VoiceRoom> };

function currentContext(): BuddyContext {
  const { voiceUsers } = voiceStore.getState();
  return { rooms: voiceRoomsByUser(voiceUsers, channelsStore.getState().channels) };
}

/** The context source one Buddies list reads; `subscribe` is owned by the
 *  list's signal. */
export function createBuddyContext(): RowContextSource<BuddyContext> {
  let ctx = currentContext();
  return {
    read: () => ctx,
    subscribe: (signal, onChange) => {
      // The stores may have moved since construction.
      ctx = currentContext();
      select(
        [voiceStore, channelsStore],
        (voice, channels) => voiceRoomsByUser(voice.voiceUsers, channels.channels),
        (rooms) => {
          ctx = { rooms };
          onChange();
        },
        { signal, equals: (a, b) => roomsKey(a) === roomsKey(b) },
      );
    },
  };
}
