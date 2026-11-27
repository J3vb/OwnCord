/**
 * What Command Deck adds to the member list: Buddies' activity groups and its
 * rows, bound to their voice room context, Join in the row menu, and the
 * groups folded on this device.
 */

import { buddiesText } from "../../../i18n/buddies";
import type { MemberListOptions } from "../memberListOptions";
import { memberRows } from "../memberRowRenderer";
import { activityItems } from "./activityGroups";
import { buddiesRows } from "./buddiesRenderer";
import { createBuddyContext } from "./buddyContext";
import { createCollapsedGroups } from "./collapsedGroups";
import { currentJoinInputs } from "./joinInputs";
import { joinTarget } from "./joinTarget";

export type DeckListOptions = Pick<
  MemberListOptions,
  "view" | "flatten" | "joinRoomFor" | "collapse"
>;

/** The list options for one Buddies list; each call has its own context.
 *  With `onJoinVoice`, the row menu offers "Join {room}" by the Join rule. */
export function buddiesListOptions(onJoinVoice?: (channelId: number) => void): DeckListOptions {
  const options = {
    view: memberRows(buddiesRows, createBuddyContext()),
    flatten: activityItems,
    collapse: createCollapsedGroups(),
  };
  if (onJoinVoice === undefined) return options;
  return {
    ...options,
    joinRoomFor: (userId) => {
      const room = joinTarget(userId, currentJoinInputs());
      if (room === null) return null;
      const label = buddiesText("joinRoom", { room: room.name });
      return { label, join: () => onJoinVoice(room.channelId) };
    },
  };
}
