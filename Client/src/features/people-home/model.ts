/**
 * What the People view draws, from the stores' plain data. Pure: the view
 * passes the state in, so the rules here are tested without a DOM.
 */

import type { IconName } from "@lib/icons";
import type { UserStatus } from "@lib/types";
import { statusIndicatorLabel } from "@lib/ui/statusIndicator";
import type { Channel } from "@stores/channels.store";
import { memberDisplayName, type Member } from "@stores/members.store";
import type { VoiceUser } from "@stores/voice.store";
import { nameCollator } from "../members/memberModel";
import { playingLine } from "../members/gameActivityLine";
import { rowActivity } from "../members/listeningLine";

export type PeopleTab = "online" | "all";

/** One person, as a row or an Active now card shows them. */
export interface PersonModel {
  readonly id: number;
  readonly name: string;
  readonly username: string;
  readonly avatar: string | null;
  readonly status: UserStatus;
  readonly mobile: boolean;
  /** The line under the name: custom status, else game or music, else the status. */
  readonly line: string;
  /** The icon in front of `line`; null for a custom status or a plain status. */
  readonly lineIcon: IconName | null;
}

/** An Active now card: someone playing a game, in voice, or both. */
export interface ActiveModel extends PersonModel {
  /** "Playing <game>", or null. */
  readonly game: string | null;
  /** "In <voice channel>" as the channel's name, or null. */
  readonly voiceChannel: string | null;
}

/** Who the lists leave out: you, and anyone you blocked. */
export interface PeopleScope {
  readonly selfId: number | null;
  readonly blocked: ReadonlySet<number>;
}

/** Shown as online to everyone; invisible reads as offline, as in the member list. */
export function isOnline(status: UserStatus): boolean {
  return status !== "offline" && status !== "invisible";
}

function personOf(member: Member): PersonModel {
  const custom = member.customStatus;
  const mobile = member.mobile === true;
  const base = {
    id: member.id,
    name: memberDisplayName(member),
    username: member.username,
    avatar: member.avatar,
    status: member.status,
    mobile,
  };
  if (typeof custom === "string" && custom.length > 0) {
    return { ...base, line: custom, lineIcon: null };
  }
  const shown = rowActivity(member.activity, member.listening);
  if (shown !== null) return { ...base, line: shown.text, lineIcon: shown.icon };
  return { ...base, line: statusIndicatorLabel(member.status, mobile), lineIcon: null };
}

const byName = (a: PersonModel, b: PersonModel): number =>
  nameCollator.compare(a.name, b.name) || a.id - b.id;

function inScope(member: Member, scope: PeopleScope): boolean {
  return member.id !== scope.selfId && !scope.blocked.has(member.id);
}

/** Matches the shown name or the username, ignoring case. */
export function matchesQuery(
  person: Pick<PersonModel, "name" | "username">,
  query: string,
): boolean {
  const q = query.trim().toLocaleLowerCase();
  if (q === "") return true;
  return (
    person.name.toLocaleLowerCase().includes(q) || person.username.toLocaleLowerCase().includes(q)
  );
}

/**
 * The list for a tab: everyone but you and the people you blocked, online
 * only on the Online tab, filtered by the search, sorted by name.
 */
export function peopleRows(
  members: Iterable<Member>,
  scope: PeopleScope,
  tab: PeopleTab,
  query: string,
): PersonModel[] {
  const rows: PersonModel[] = [];
  for (const member of members) {
    if (!inScope(member, scope)) continue;
    if (tab === "online" && !isOnline(member.status)) continue;
    const person = personOf(member);
    if (matchesQuery(person, query)) rows.push(person);
  }
  return rows.toSorted(byName);
}

/**
 * Active now: online people playing a game or in one of the server's voice
 * channels. A DM call is private to its members, so only server channels
 * count, and only ones this client can see.
 */
export function activeNow(
  members: ReadonlyMap<number, Member>,
  voiceUsers: ReadonlyMap<number, ReadonlyMap<number, VoiceUser>>,
  channels: ReadonlyMap<number, Channel>,
  scope: PeopleScope,
): ActiveModel[] {
  const voiceOf = new Map<number, string>();
  for (const [channelId, users] of voiceUsers) {
    const channel = channels.get(channelId);
    if (channel === undefined || channel.type === "dm") continue;
    for (const userId of users.keys()) {
      if (!voiceOf.has(userId)) voiceOf.set(userId, channel.name);
    }
  }
  const cards: ActiveModel[] = [];
  for (const member of members.values()) {
    if (!inScope(member, scope) || !isOnline(member.status)) continue;
    const game = member.activity != null ? playingLine(member.activity) : null;
    const voiceChannel = voiceOf.get(member.id) ?? null;
    if (game === null && voiceChannel === null) continue;
    cards.push({ ...personOf(member), game, voiceChannel });
  }
  return cards.toSorted(byName);
}
