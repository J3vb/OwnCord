/**
 * What Command Deck adds to the member list: Buddies' activity groups and its
 * rows, bound to their voice room context.
 */

import type { MemberListOptions } from "../memberListOptions";
import { memberRows } from "../memberRowRenderer";
import { activityItems } from "./activityGroups";
import { buddiesRows } from "./buddiesRenderer";
import { createBuddyContext } from "./buddyContext";

export type DeckListOptions = Pick<MemberListOptions, "view" | "flatten">;

/** The list options for one Buddies list; each call has its own context. */
export function buddiesListOptions(): DeckListOptions {
  return { view: memberRows(buddiesRows, createBuddyContext()), flatten: activityItems };
}
