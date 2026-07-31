/**
 * MentionAutocomplete — inline member picker the composer opens on "@".
 * Uses @lib/dom helpers exclusively. Never sets innerHTML with user content.
 */

import { createElement, setText, clearChildren, appendChildren } from "@lib/dom";
import { membersStore } from "@stores/members.store";
import { currentUserHasPermission } from "@lib/permissions";
import { Permission } from "@lib/types";
import { EVERYONE_TOKEN, HERE_TOKEN } from "@lib/mentions";

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

export interface MentionAutocompleteComponent {
  readonly element: HTMLDivElement;
  /**
   * Re-filter for `query` (the text typed after "@"). Returns false when
   * nothing matches, which the composer treats as "close the popup" rather
   * than leaving an empty box hanging over the input.
   */
  setQuery(query: string): boolean;
  /** Handle a composer keydown. Returns true when the key was consumed. */
  handleKeydown(e: KeyboardEvent): boolean;
  destroy(): void;
}

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

export function createMentionAutocomplete(
  options: MentionAutocompleteOptions,
): MentionAutocompleteComponent {
  const ac = new AbortController();
  const signal = ac.signal;

  let suggestions: MentionSuggestion[] = [];
  let activeIndex = 0;

  const root = createElement("div", {
    class: "mention-autocomplete",
    role: "listbox",
    "data-testid": "mention-autocomplete",
  });
  const list = createElement("div", { class: "ma-list" });
  root.appendChild(list);

  function choose(index: number): void {
    const picked = suggestions[index];
    if (picked === undefined) return;
    options.onSelect(picked.token);
  }

  function render(): void {
    clearChildren(list);
    for (let i = 0; i < suggestions.length; i++) {
      const s = suggestions[i]!;
      const row = createElement("div", {
        class: i === activeIndex ? "ma-item ma-item--active" : "ma-item",
        role: "option",
        "aria-selected": i === activeIndex ? "true" : "false",
        "data-testid": `mention-option-${s.token}`,
      });
      const name = createElement("span", { class: "ma-name" });
      setText(name, `@${s.label}`);
      const detail = createElement("span", { class: "ma-detail" });
      setText(detail, s.detail);
      appendChildren(row, name, detail);
      // mousedown, not click: the textarea must not lose focus before the
      // insertion runs.
      row.addEventListener(
        "mousedown",
        (e: MouseEvent) => {
          e.preventDefault();
          choose(i);
        },
        { signal },
      );
      list.appendChild(row);
    }
  }

  function setQuery(query: string): boolean {
    suggestions = filterMentionSuggestions(query);
    activeIndex = 0;
    render();
    return suggestions.length > 0;
  }

  function handleKeydown(e: KeyboardEvent): boolean {
    if (suggestions.length === 0) return false;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        activeIndex = (activeIndex + 1) % suggestions.length;
        render();
        return true;
      case "ArrowUp":
        e.preventDefault();
        activeIndex = (activeIndex - 1 + suggestions.length) % suggestions.length;
        render();
        return true;
      case "Enter":
      case "Tab":
        e.preventDefault();
        choose(activeIndex);
        return true;
      case "Escape":
        e.preventDefault();
        options.onClose();
        return true;
      default:
        return false;
    }
  }

  function destroy(): void {
    ac.abort();
    root.remove();
  }

  setQuery("");

  return { element: root, setQuery, handleKeydown, destroy };
}
