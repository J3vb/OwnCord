/**
 * Buddies' groups: the role model's members regrouped by what they are doing.
 * Pure. The role model already sorts each bucket by name, so this merges the
 * online buckets with the same order and splits them by status and game;
 * the OFFLINE group is the model's own. Only `activity` decides IN GAME, so
 * a member who only listens to music never lands there. A folded group keeps
 * its header and leaves out its rows, except during a search.
 */

import type { Member } from "@stores/members.store";
import { shellText } from "../../../i18n/shell";
import { buddiesText } from "../../../i18n/buddies";
import {
  compareEntries,
  isAwayStatus,
  memberMatcher,
  type Entry,
  type ListItem,
  type MemberModel,
} from "../memberModel";

type GroupKey = "a:game" | "a:online" | "a:away" | "a:dnd" | "a:offline";
type GroupLabel = "groupGame" | "groupOnline" | "groupAway" | "groupDnd" | "groupOffline";

/** The groups in display order, each with its catalog label. */
const GROUPS: ReadonlyArray<readonly [GroupKey, GroupLabel]> = [
  ["a:game", "groupGame"],
  ["a:online", "groupOnline"],
  ["a:away", "groupAway"],
  ["a:dnd", "groupDnd"],
  ["a:offline", "groupOffline"],
];

/** Every group's header key, in display order. */
export const ACTIVITY_GROUP_KEYS: readonly string[] = GROUPS.map(([key]) => key);

/** The group of a member whose status is online, idle or dnd. */
function presentGroupOf(member: Member): GroupKey {
  if (member.activity != null) return "a:game";
  if (member.status === "idle") return "a:away";
  if (member.status === "dnd") return "a:dnd";
  return "a:online";
}

/** The header key of the group `member` belongs in. */
export function groupKeyOf(member: Member): string {
  return isAwayStatus(member.status) ? "a:offline" : presentGroupOf(member);
}

/** Every group's entries, sorted, before the search filter. */
function groupEntries(model: MemberModel): ReadonlyMap<GroupKey, readonly Entry[]> {
  const groups = new Map<GroupKey, Entry[]>(GROUPS.map(([key]) => [key, []]));
  // Each bucket is sorted by compareEntries; one sort merges them.
  const present = [...model.buckets.values(), model.online].flat().toSorted(compareEntries);
  for (const entry of present) groups.get(presentGroupOf(entry.member))!.push(entry);
  return new Map<GroupKey, readonly Entry[]>([...groups, ["a:offline", model.offline]]);
}

/**
 * The Buddies list items: IN GAME, ONLINE, AWAY, DO NOT DISTURB, then
 * OFFLINE, each a header and its rows, with empty groups left out. `query`
 * filters within the groups, and a header counts its matches. `collapsed`
 * names the folded groups. With no search every header can fold; during a
 * search none can, so every match is shown.
 */
export function activityItems(
  model: MemberModel,
  query: string,
  collapsed: ReadonlySet<string>,
): ListItem[] {
  if (model.members.size === 0) {
    return [{ kind: "empty", key: "empty", text: shellText("members.empty") }];
  }
  const matches = memberMatcher(query);
  const groups = groupEntries(model);
  const collapsible = query.trim() === "";
  const items: ListItem[] = [];
  for (const [key, label] of GROUPS) {
    const entries = (groups.get(key) ?? []).filter((e) => matches(e.member));
    if (entries.length === 0) continue;
    const folded = collapsible && collapsed.has(key);
    items.push({
      kind: "header",
      key,
      text: shellText("members.groupHeader", { role: buddiesText(label), count: entries.length }),
      offline: key === "a:offline",
      collapsible,
      collapsed: folded,
    });
    if (folded) continue;
    for (const { member, colorVar } of entries) {
      items.push({ kind: "row", key: `u:${member.id}`, member, colorVar });
    }
  }
  if (items.length === 0) {
    return [{ kind: "empty", key: "empty", text: shellText("members.searchEmpty") }];
  }
  return items;
}
