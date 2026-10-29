/**
 * The member list's sorted, grouped model. Pure: it reads members and roles
 * through its parameters and never touches a store or the DOM. `updateModel`
 * repositions only the members whose objects changed (the store keeps object
 * identity for untouched ones); `flattenModel` applies the search filter while
 * walking the already-sorted groups, so a query never sorts.
 */

import { memberDisplayName, type Member } from "../../stores/members.store";
import type { ReadyRole, UserStatus } from "../../lib/types";
import { shellText } from "../../i18n/shell";

export interface RoleGroup {
  readonly role: string;
  readonly label: string;
  readonly colorVar: string;
}

/** One child of `.member-list`, in display order. */
export type ListItem =
  | {
      readonly kind: "header";
      readonly key: string;
      readonly text: string;
      readonly offline: boolean;
    }
  | {
      readonly kind: "row";
      readonly key: string;
      readonly member: Member;
      readonly colorVar: string;
    }
  | { readonly kind: "empty"; readonly key: string; readonly text: string };

export interface Entry {
  readonly member: Member;
  readonly colorVar: string;
}

export type EntryComparator = (a: Entry, b: Entry) => number;

/** Most changed members `updateModel` repositions one by one; more rebuilds. */
export const MAX_DELTA = 64;

/** Theme-variable fallbacks for the seeded roles (used when the server sends no color). */
const FALLBACK_ROLE_COLORS: Record<string, string> = {
  owner: "var(--role-owner, #e74c3c)",
  admin: "var(--role-admin, #f39c12)",
  moderator: "var(--role-mod, #2ecc71)",
};

const MEMBER_COLOR = "var(--role-member, #949ba4)";

/** Ordered role groups used when the server hasn't sent a role list. */
function fallbackRoleGroups(): readonly RoleGroup[] {
  return [
    {
      role: "owner",
      label: shellText("members.role.owner"),
      colorVar: FALLBACK_ROLE_COLORS["owner"]!,
    },
    {
      role: "admin",
      label: shellText("members.role.admin"),
      colorVar: FALLBACK_ROLE_COLORS["admin"]!,
    },
    {
      role: "moderator",
      label: shellText("members.role.moderator"),
      colorVar: FALLBACK_ROLE_COLORS["moderator"]!,
    },
    { role: "member", label: shellText("members.role.member"), colorVar: MEMBER_COLOR },
  ];
}

/**
 * Role groups from the server's `ready` role list (already ordered by position,
 * highest first), colored by the server's role color when set. A hardcoded
 * list rendered custom roles nowhere and ignored `roles.color` entirely.
 */
export function roleGroupsFor(roles: readonly ReadyRole[]): readonly RoleGroup[] {
  if (roles.length === 0) return fallbackRoleGroups();
  return roles.map((r) => {
    const key = r.name.toLowerCase();
    return {
      role: key,
      label: r.name.toUpperCase(),
      colorVar: r.color ?? FALLBACK_ROLE_COLORS[key] ?? MEMBER_COLOR,
    };
  });
}

/** True for the statuses that render a member as "not here". */
export function isAwayStatus(status: UserStatus): boolean {
  return status === "offline" || status === "invisible";
}

const nameCollator = new Intl.Collator(undefined, { sensitivity: "base" });

export function compareEntries(a: Entry, b: Entry): number {
  return (
    nameCollator.compare(memberDisplayName(a.member), memberDisplayName(b.member)) ||
    a.member.id - b.member.id
  );
}

/** Case-, accent- and `@`-insensitive form of a name, for the search box. */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

// Folded "username\ndisplayName" per Member object; a new object (every
// snapshot makes them) is folded once, an unchanged one never again.
const foldCache = new WeakMap<Member, string>();

function searchText(member: Member): string {
  let text = foldCache.get(member);
  if (text === undefined) {
    text = `${fold(member.username)}\n${fold(member.displayName ?? "")}`;
    foldCache.set(member, text);
  }
  return text;
}

/** Bucket keys of the OFFLINE and ONLINE groups; role buckets are keyed by
 *  lowercased role name. ONLINE holds online members whose roles are all
 *  un-hoisted. */
const OFFLINE = Symbol("offline");
const ONLINE = Symbol("online");
type BucketKey = string | typeof OFFLINE | typeof ONLINE;

/** What the grouping needs of one role, read once per `roles` reference. */
interface RoleFacts {
  /** Higher outranks lower; the server's position, else the list order. */
  readonly rank: number;
  readonly hoist: boolean;
  /** Lowercased name: the bucket key and the colour-map key. */
  readonly key: string;
  readonly color: string | null;
}

// One id->facts map per `roles` array: a 2,000-member build then costs
// O(held roles) per member and never scans the role list.
const factsCache = new WeakMap<readonly ReadyRole[], ReadonlyMap<number, RoleFacts>>();

function roleFacts(roles: readonly ReadyRole[]): ReadonlyMap<number, RoleFacts> {
  let facts = factsCache.get(roles);
  if (facts === undefined) {
    const built = new Map<number, RoleFacts>();
    roles.forEach((r, index) => {
      built.set(r.id, {
        rank: r.position ?? roles.length - index,
        // No hoist field is an older server: every role is its own group.
        hoist: r.hoist !== false,
        key: r.name.toLowerCase(),
        color: r.color,
      });
    });
    facts = built;
    factsCache.set(roles, facts);
  }
  return facts;
}

/** The member's held roles that the roster knows, or null when the member
 *  carries no `roleIds` (an older server) or none resolve: the single role
 *  name then decides, exactly as before multi-role. */
function heldFacts(member: Member, facts: ReadonlyMap<number, RoleFacts>): RoleFacts[] | null {
  const ids = member.roleIds;
  if (ids === undefined || ids.length === 0) return null;
  const held: RoleFacts[] = [];
  for (const id of ids) {
    const f = facts.get(id);
    if (f !== undefined) held.push(f);
  }
  return held.length > 0 ? held : null;
}

/** Members sorted per group, with no search filter applied. Immutable: an
 *  update returns a new model and never writes into a previous one. */
export interface MemberModel {
  readonly members: ReadonlyMap<number, Member>;
  readonly roles: readonly ReadyRole[];
  readonly groups: readonly RoleGroup[];
  readonly buckets: ReadonlyMap<string, readonly Entry[]>;
  /** Online members with no hoisted role; empty on an older server. */
  readonly online: readonly Entry[];
  readonly offline: readonly Entry[];
}

function bucketKeyOf(member: Member, facts: ReadonlyMap<number, RoleFacts>): BucketKey {
  if (isAwayStatus(member.status)) return OFFLINE;
  const held = heldFacts(member, facts);
  if (held === null) return member.role.toLowerCase();
  let top: RoleFacts | undefined;
  for (const f of held) if (f.hoist && (top === undefined || f.rank > top.rank)) top = f;
  return top === undefined ? ONLINE : top.key;
}

function knownColors(groups: readonly RoleGroup[]): ReadonlyMap<string, string> {
  const colors = new Map<string, string>();
  for (const group of groups) if (!colors.has(group.role)) colors.set(group.role, group.colorVar);
  return colors;
}

function entryFor(
  member: Member,
  colors: ReadonlyMap<string, string>,
  facts: ReadonlyMap<number, RoleFacts>,
): Entry {
  const held = heldFacts(member, facts);
  if (held === null) {
    return { member, colorVar: colors.get(member.role.toLowerCase()) ?? MEMBER_COLOR };
  }
  // The name colour is the highest-ranked held role that has one; with none,
  // the top held role's seeded fallback (today's behaviour for a plain role).
  let coloured: RoleFacts | undefined;
  let top = held[0]!;
  for (const f of held) {
    if (f.rank > top.rank) top = f;
    if (f.color !== null && (coloured === undefined || f.rank > coloured.rank)) coloured = f;
  }
  return {
    member,
    colorVar: coloured?.color ?? FALLBACK_ROLE_COLORS[top.key] ?? MEMBER_COLOR,
  };
}

/** Sort every member into its group from scratch (one sort per group). */
export function buildModel(
  members: ReadonlyMap<number, Member>,
  roles: readonly ReadyRole[],
  compare: EntryComparator = compareEntries,
): MemberModel {
  const groups = roleGroupsFor(roles);
  const colors = knownColors(groups);
  const facts = roleFacts(roles);
  const buckets = new Map<string, Entry[]>();
  const offline: Entry[] = [];
  const online: Entry[] = [];
  for (const member of members.values()) {
    const entry = entryFor(member, colors, facts);
    const key = bucketKeyOf(member, facts);
    if (key === OFFLINE) {
      offline.push(entry);
      continue;
    }
    if (key === ONLINE) {
      online.push(entry);
      continue;
    }
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [entry]);
    else bucket.push(entry);
  }
  for (const bucket of buckets.values()) bucket.sort(compare);
  online.sort(compare);
  offline.sort(compare);
  return { members, roles, groups, buckets, online, offline };
}

/** Index of the first entry not ordered before `target`. */
function lowerBound(entries: readonly Entry[], target: Entry, compare: EntryComparator): number {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compare(entries[mid]!, target) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The members that differ between two snapshots, or null past `MAX_DELTA`. */
function changedBetween(
  prev: ReadonlyMap<number, Member>,
  next: ReadonlyMap<number, Member>,
): { readonly removed: Member[]; readonly added: Member[] } | null {
  const removed: Member[] = [];
  const added: Member[] = [];
  let count = 0;
  for (const [id, member] of next) {
    const before = prev.get(id);
    if (before === member) continue;
    if (++count > MAX_DELTA) return null;
    if (before !== undefined) removed.push(before);
    added.push(member);
  }
  for (const [id, member] of prev) {
    if (next.has(id)) continue;
    if (++count > MAX_DELTA) return null;
    removed.push(member);
  }
  return { removed, added };
}

/**
 * The model for `members`, reusing `prev` where it can. An unchanged pair of
 * references returns `prev`. A new `roles` reference (group order, labels and
 * colours may all differ) or more than `MAX_DELTA` changed members rebuilds
 * fully; otherwise each changed member is taken out of its old group and put
 * into its new one by binary search. Either way the result equals
 * `buildModel(members, roles)`.
 */
export function updateModel(
  prev: MemberModel,
  members: ReadonlyMap<number, Member>,
  roles: readonly ReadyRole[],
  compare: EntryComparator = compareEntries,
): MemberModel {
  if (prev.roles !== roles) return buildModel(members, roles, compare);
  if (prev.members === members) return prev;
  const delta = changedBetween(prev.members, members);
  if (delta === null) return buildModel(members, roles, compare);

  const colors = knownColors(prev.groups);
  const facts = roleFacts(roles);
  const buckets = new Map(prev.buckets);
  let online = prev.online;
  let offline = prev.offline;
  // Each touched array is copied once; the previous model keeps its own.
  const copied = new Set<readonly Entry[]>();
  const writable = (entries: readonly Entry[]): Entry[] => {
    if (copied.has(entries)) return entries as Entry[];
    const copy = entries.slice();
    copied.add(copy);
    return copy;
  };

  for (const member of delta.removed) {
    const key = bucketKeyOf(member, facts);
    const entries = key === OFFLINE ? offline : key === ONLINE ? online : buckets.get(key);
    if (entries === undefined) continue;
    const target: Entry = { member, colorVar: "" };
    let at = lowerBound(entries, target, compare);
    if (entries[at]?.member !== member) at = entries.findIndex((e) => e.member === member);
    if (at < 0) continue;
    const next = writable(entries);
    next.splice(at, 1);
    if (key === OFFLINE) offline = next;
    else if (key === ONLINE) online = next;
    else if (next.length === 0) buckets.delete(key);
    else buckets.set(key, next);
  }
  for (const member of delta.added) {
    const key = bucketKeyOf(member, facts);
    const entry = entryFor(member, colors, facts);
    const entries = key === OFFLINE ? offline : key === ONLINE ? online : (buckets.get(key) ?? []);
    const next = writable(entries);
    next.splice(lowerBound(next, entry, compare), 0, entry);
    if (key === OFFLINE) offline = next;
    else if (key === ONLINE) online = next;
    else buckets.set(key, next);
  }
  return { members, roles, groups: prev.groups, buckets, online, offline };
}

/**
 * The wanted children, in order: one group per (hoisted) role holding its
 * online members, then an ONLINE group for online members with no hoisted role
 * (only a multi-role server produces one), then one OFFLINE group (offline and invisible members, A-Z across
 * roles) that keeps each member's role colour. The OFFLINE header's key is
 * "offline" and role keys carry a "g:" prefix, so a role named "Offline"
 * cannot collide with it. `query` filters while walking; nothing is sorted.
 */
export function flattenModel(model: MemberModel, query: string): ListItem[] {
  if (model.members.size === 0) {
    return [{ kind: "empty", key: "empty", text: shellText("members.empty") }];
  }
  const needle = fold(query.trim().replace(/^@\s*/, ""));
  const matching = (entries: readonly Entry[]): readonly Entry[] =>
    needle === "" ? entries : entries.filter((e) => searchText(e.member).includes(needle));

  // A role missing from the server's list (deleted mid-session) still renders,
  // in a gray group, after the listed ones.
  const known = new Set<string>();
  const order: RoleGroup[] = [];
  for (const group of model.groups) {
    if (known.has(group.role)) continue;
    known.add(group.role);
    order.push(group);
  }
  const extra = [...model.buckets.keys()].filter((r) => !known.has(r)).toSorted();
  for (const role of extra) {
    order.push({ role, label: role.toUpperCase(), colorVar: MEMBER_COLOR });
  }

  const items: ListItem[] = [];
  const push = (key: string, label: string, offlineGroup: boolean, all: readonly Entry[]): void => {
    const entries = matching(all);
    if (entries.length === 0) return;
    items.push({
      kind: "header",
      key,
      text: shellText("members.groupHeader", { role: label, count: entries.length }),
      offline: offlineGroup,
    });
    for (const { member, colorVar } of entries) {
      items.push({ kind: "row", key: `u:${member.id}`, member, colorVar });
    }
  };
  for (const group of order) {
    push(`g:${group.role}`, group.label, false, model.buckets.get(group.role) ?? []);
  }
  push("online", shellText("members.onlineGroup"), false, model.online);
  push("offline", shellText("members.offlineGroup"), true, model.offline);
  if (items.length === 0) {
    return [{ kind: "empty", key: "empty", text: shellText("members.searchEmpty") }];
  }
  return items;
}

/** `flattenModel(buildModel(...))`: the from-scratch reference the incremental
 *  path must equal. */
export function buildItems(
  members: ReadonlyMap<number, Member>,
  roles: readonly ReadyRole[],
  query: string,
  compare: EntryComparator = compareEntries,
): ListItem[] {
  return flattenModel(buildModel(members, roles, compare), query);
}
