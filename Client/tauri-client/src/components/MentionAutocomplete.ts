/**
 * MentionAutocomplete — inline member picker the composer opens on "@".
 * Uses @lib/dom helpers exclusively. Never sets innerHTML with user content.
 */

import { createElement, setText } from "@lib/dom";
import { membersStore } from "@stores/members.store";
import { currentUserHasPermission } from "@lib/permissions";
import { Permission } from "@lib/types";
import { EVERYONE_TOKEN, HERE_TOKEN } from "@lib/mentions";
import {
  createInlineAutocomplete,
  type InlineAutocompleteComponent,
} from "@components/inline-autocomplete";

/** Maximum rows shown at once — the popup is a shortcut, not the member list. */
export const MAX_MENTION_SUGGESTIONS = 10;

export interface MentionSuggestion {
  /** Token inserted after the "@", e.g. "alice" or "everyone". */
  readonly token: string;
  /** Row label. Equal to `token` for users. */
  readonly label: string;
  /** Secondary line (role for users, meaning for @everyone/@here). */
  readonly detail: string;
  readonly kind: "user" | "broadcast";
  /** User id, or null for @everyone/@here. */
  readonly userId: number | null;
}

export interface MentionAutocompleteOptions {
  /** Called with the token to insert (without the leading "@"). */
  readonly onSelect: (token: string) => void;
  readonly onClose: () => void;
}

/** Same shape as the shared inline-autocomplete widget. */
export type MentionAutocompleteComponent = InlineAutocompleteComponent;

function byLabel(a: MentionSuggestion, b: MentionSuggestion): number {
  return a.label.localeCompare(b.label);
}

/**
 * Suggestions for `query`, in the order the popup lists them: prefix matches
 * before substring matches, alphabetical within each group.
 *
 * @everyone / @here are offered only when the signed-in user's role holds
 * MENTION_EVERYONE — offering a token the server will refuse to honour would
 * be a lie. The server still enforces.
 */
export function filterMentionSuggestions(query: string): MentionSuggestion[] {
  const q = query.toLowerCase();
  const prefix: MentionSuggestion[] = [];
  const substring: MentionSuggestion[] = [];

  for (const member of membersStore.getState().members.values()) {
    const lower = member.username.toLowerCase();
    if (q !== "" && !lower.includes(q)) continue;
    const entry: MentionSuggestion = {
      token: member.username,
      label: member.username,
      detail: member.role,
      kind: "user",
      userId: member.id,
    };
    if (q === "" || lower.startsWith(q)) {
      prefix.push(entry);
    } else {
      substring.push(entry);
    }
  }

  prefix.sort(byLabel);
  substring.sort(byLabel);

  const broadcasts: MentionSuggestion[] = [];
  if (currentUserHasPermission(Permission.MENTION_EVERYONE)) {
    const all: MentionSuggestion[] = [
      {
        token: EVERYONE_TOKEN,
        label: EVERYONE_TOKEN,
        detail: "Notify everyone in this channel",
        kind: "broadcast",
        userId: null,
      },
      {
        token: HERE_TOKEN,
        label: HERE_TOKEN,
        detail: "Notify everyone who is online",
        kind: "broadcast",
        userId: null,
      },
    ];
    broadcasts.push(...all.filter((s) => q === "" || s.token.startsWith(q)));
  }

  return [...broadcasts, ...prefix, ...substring].slice(0, MAX_MENTION_SUGGESTIONS);
}

/** One mention row: `@label` plus a role / broadcast-meaning detail line. */
function renderMentionRow(s: MentionSuggestion): HTMLElement[] {
  const name = createElement("span", { class: "ma-name" });
  setText(name, `@${s.label}`);
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
    filter: filterMentionSuggestions,
    valueOf: (s) => s.token,
    rowTestId: (s) => `mention-option-${s.token}`,
    renderRow: renderMentionRow,
    // Open already populated with the full member list.
    primeOnCreate: true,
    onSelect: options.onSelect,
    onClose: options.onClose,
  });
}
