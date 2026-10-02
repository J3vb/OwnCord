/**
 * MentionAutocomplete — inline member picker the composer opens on "@".
 * Uses @lib/dom helpers exclusively. Never sets innerHTML with user content.
 */

import { createElement, setText } from "@lib/dom";
import { membersStore, memberDisplayName } from "@stores/members.store";
import { getChannelMessages } from "@stores/messages.store";
import { getCurrentUser } from "@stores/auth.store";
import { currentUserHasPermission } from "@lib/permissions";
import { Permission } from "@lib/types";
import { EVERYONE_TOKEN, HERE_TOKEN } from "@lib/mentions";
import {
  createInlineAutocomplete,
  type InlineAutocompleteComponent,
} from "@components/inline-autocomplete";
import { messagingText } from "../i18n/messaging";

/** Maximum rows shown at once — the popup is a shortcut, not the member list. */
export const MAX_MENTION_SUGGESTIONS = 10;

export interface MentionSuggestion {
  /** Token inserted after the "@", e.g. "alice" or "everyone". */
  readonly token: string;
  /** Row label: the member's display name when set, else the username. */
  readonly label: string;
  /**
   * Secondary line: the role for users (prefixed by @username when the label
   * is a display name), the meaning for @everyone/@here.
   */
  readonly detail: string;
  readonly kind: "user" | "broadcast";
  /** User id, or null for @everyone/@here. */
  readonly userId: number | null;
}

export interface MentionAutocompleteOptions {
  /** Called with the token to insert (without the leading "@"). */
  readonly onSelect: (token: string) => void;
  readonly onClose: () => void;
  /**
   * Channel whose loaded history ranks the suggestions: members who spoke
   * there recently are listed first. Omit to fall back to alphabetical order
   * (no history is then consulted).
   */
  readonly channelId?: number;
  /**
   * Composer textarea the popup completes for; carries combobox semantics and
   * aria-activedescendant while the popup is open (see inline-autocomplete).
   */
  readonly comboboxInput?: HTMLElement;
}

/** Same shape as the shared inline-autocomplete widget. */
export type MentionAutocompleteComponent = InlineAutocompleteComponent;

/**
 * Recency rank per user id for `channelId`: 0 is the most recent author of the
 * loaded history, higher is older. Users with no loaded message are absent, and
 * so is the signed-in user, who keeps their alphabetical place.
 */
function recentChatterRanks(channelId: number | undefined): ReadonlyMap<number, number> {
  const ranks = new Map<number, number>();
  if (channelId === undefined) return ranks;
  // getChannelMessages is oldest-first, so walk it backwards and keep each
  // author's first (most recent) sighting.
  const selfId = getCurrentUser()?.id;
  const messages = getChannelMessages(channelId);
  for (let i = messages.length - 1; i >= 0; i--) {
    const userId = messages[i]!.user.id;
    if (userId !== selfId && !ranks.has(userId)) ranks.set(userId, ranks.size);
  }
  return ranks;
}

/**
 * Suggestions for `query`, in the order the popup lists them: prefix matches
 * before substring matches. Within each group, members who spoke recently in
 * `channelId` come first (most recent first), then the rest alphabetically.
 * Without a channel id the order is purely alphabetical.
 *
 * @everyone / @here are offered only when the signed-in user's role holds
 * MENTION_EVERYONE — offering a token the server will refuse to honour would
 * be a lie. The server still enforces.
 */
export function filterMentionSuggestions(query: string, channelId?: number): MentionSuggestion[] {
  const q = query.toLowerCase();
  const prefix: MentionSuggestion[] = [];
  const substring: MentionSuggestion[] = [];
  const ranks = recentChatterRanks(channelId);

  for (const member of membersStore.getState().members.values()) {
    // Skip usernames the mention grammar cannot express (a space, an "@",
    // etc. truncate the token on insert) -- picking one would insert a dead
    // token that resolves to no mention and notifies nobody.
    if (!/^[\p{L}\p{N}_.-]{1,64}$/u.test(member.username)) continue;
    // Match on the display name too, so typing "@Ali" finds "Alice". The
    // token inserted is still the username -- it is the unique handle the
    // mention grammar resolves against.
    const lowerUsername = member.username.toLowerCase();
    const display = member.displayName;
    const lowerDisplay = typeof display === "string" ? display.toLowerCase() : "";
    if (q !== "" && !lowerUsername.includes(q) && !lowerDisplay.includes(q)) continue;
    const label = memberDisplayName(member);
    const entry: MentionSuggestion = {
      token: member.username,
      label,
      detail:
        label === member.username
          ? member.role
          : messagingText("mention.userDetail", { username: member.username, role: member.role }),
      kind: "user",
      userId: member.id,
    };
    if (q === "" || lowerUsername.startsWith(q) || lowerDisplay.startsWith(q)) {
      prefix.push(entry);
    } else {
      substring.push(entry);
    }
  }

  // Recent chatters first, then alphabetical within each group; a user with no
  // rank (never seen in the loaded history) sorts after every ranked one.
  const compare = (a: MentionSuggestion, b: MentionSuggestion): number => {
    const ra = a.userId === null ? undefined : ranks.get(a.userId);
    const rb = b.userId === null ? undefined : ranks.get(b.userId);
    if (ra !== rb) {
      if (ra === undefined) return 1;
      if (rb === undefined) return -1;
      return ra - rb;
    }
    return a.label.localeCompare(b.label);
  };
  prefix.sort(compare);
  substring.sort(compare);

  const broadcasts: MentionSuggestion[] = [];
  if (currentUserHasPermission(Permission.MENTION_EVERYONE)) {
    const all: MentionSuggestion[] = [
      {
        token: EVERYONE_TOKEN,
        label: EVERYONE_TOKEN,
        detail: messagingText("mention.everyone"),
        kind: "broadcast",
        userId: null,
      },
      {
        token: HERE_TOKEN,
        label: HERE_TOKEN,
        detail: messagingText("mention.here"),
        kind: "broadcast",
        userId: null,
      },
    ];
    broadcasts.push(...all.filter((s) => q === "" || s.token.startsWith(q)));
  }

  return [...broadcasts, ...prefix, ...substring].slice(0, MAX_MENTION_SUGGESTIONS);
}

/**
 * One mention row: `@token`, or a display name whose @username leads the
 * detail line, plus the role / broadcast-meaning detail.
 */
function renderMentionRow(s: MentionSuggestion): HTMLElement[] {
  const name = createElement("span", { class: "ma-name" });
  setText(name, s.label === s.token ? `@${s.token}` : s.label);
  const detail = createElement("span", { class: "ma-detail" });
  setText(detail, s.detail);
  return [name, detail];
}

export function createMentionAutocomplete(
  options: MentionAutocompleteOptions,
): MentionAutocompleteComponent {
  return createInlineAutocomplete<MentionSuggestion>({
    rootClass: "mention-autocomplete",
    rootTestId: "mention-autocomplete",
    filter: (query) => filterMentionSuggestions(query, options.channelId),
    valueOf: (s) => s.token,
    rowTestId: (s) => `mention-option-${s.token}`,
    renderRow: renderMentionRow,
    // Open already populated with the full member list.
    primeOnCreate: true,
    onSelect: options.onSelect,
    onClose: options.onClose,
    comboboxInput: options.comboboxInput,
  });
}
