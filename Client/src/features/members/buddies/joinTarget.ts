/**
 * Join on a member's row: the room it would enter, or none. This is the one
 * full statement of the rule. Pure: it reads everything through `JoinInputs`,
 * which `currentJoinInputs` fills from the stores when the menu opens and
 * again on the click.
 */

import type { VoiceRoom } from "../memberVoice";

/** How full a room with a user limit is, and whether the viewer may pass it. */
export interface RoomCapacity {
  /** The room's entry count in the voice roster, as the tree counts it. */
  readonly connected: number;
  /** `Channel.voiceMaxUsers`; 0 means no limit. */
  readonly max: number;
  /** As stored: undefined is an older server that never sends it. */
  readonly canModerateVoice: boolean | undefined;
}

export interface JoinInputs {
  /** The signed-in user's id, or null before sign-in. */
  readonly selfId: number | null;
  /** Member id to the server voice room they are in. */
  readonly rooms: ReadonlyMap<number, VoiceRoom>;
  /** One entry per room with a user limit. */
  readonly capacity: ReadonlyMap<number, RoomCapacity>;
  /** The room the viewer is in, or null. */
  readonly currentChannelId: number | null;
  /** A switch out of the viewer's call waits for the server. */
  readonly switching: boolean;
  /** The socket is connected. */
  readonly connected: boolean;
  /** The viewer is under a moderation timeout. */
  readonly timedOut: boolean;
}

/** At or over its limit, and the viewer may not bypass it. A flag the server
 *  never sent counts as no bypass. */
function fullForViewer(capacity: RoomCapacity | undefined): boolean {
  if (capacity === undefined || capacity.max <= 0) return false;
  return capacity.connected >= capacity.max && capacity.canModerateVoice !== true;
}

/** The room a Join on member `userId` would enter now, or null. The password
 *  is not checked: the server answers it, as for a click on the room. */
export function joinTarget(userId: number, s: JoinInputs): VoiceRoom | null {
  if (userId === s.selfId) return null;
  const room = s.rooms.get(userId);
  if (room === undefined) return null;
  if (room.channelId === s.currentChannelId) return null;
  // The switch wait would hold the join anyway.
  if (s.switching) return null;
  if (room.afk) return null;
  if (fullForViewer(s.capacity.get(room.channelId))) return null;
  // A frozen room's inputs: the socket is down, or the viewer is timed out.
  if (!s.connected || s.timedOut) return null;
  return room;
}
