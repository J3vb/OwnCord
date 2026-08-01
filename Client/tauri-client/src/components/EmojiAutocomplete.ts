/**
 * EmojiAutocomplete — inline emoji picker the composer opens on ":".
 *
 * Deliberately the same shape as MentionAutocomplete (setQuery / handleKeydown
 * / destroy, mousedown-to-choose, arrow-key navigation): the composer drives
 * both through one code path, and a user who has learned one has learned the
 * other.
 *
 * Two sources in one list: the server's custom emoji, which insert their
 * `:shortcode:` text, and the built-in unicode set, which inserts the character
 * itself. Custom emoji come first — they are the ones a shortcode is really
 * for, and there are far fewer of them.
 *
 * Uses @lib/dom helpers exclusively. Never sets innerHTML with user content.
 */

import { createElement, setText } from "@lib/dom";
import { EMOJI_NAMES } from "@components/EmojiPicker";
import { buildCustomEmojiImage } from "@components/message-list/custom-emoji";
import { listCustomEmoji, type CustomEmoji } from "@stores/emoji.store";
import {
  createInlineAutocomplete,
  type InlineAutocompleteComponent,
} from "@components/inline-autocomplete";

/** Maximum rows shown at once — the popup is a shortcut, not the picker. */
export const MAX_EMOJI_SUGGESTIONS = 10;

/**
 * The shortest query that opens the popup. One character after the colon would
 * match most of the unicode set and fire on ordinary prose ("note: a thing").
 */
export const MIN_EMOJI_QUERY = 2;

export interface EmojiSuggestion {
  /** Row label — the shortcode, or the unicode emoji's primary name. */
  readonly label: string;
  /** Text inserted into the composer, replacing the `:query` under the caret. */
  readonly insert: string;
  /** Secondary line: the remaining keywords, or the literal token for custom. */
  readonly detail: string;
  readonly kind: "custom" | "unicode";
  /** The character to show as the preview, or null for a custom emoji image. */
  readonly char: string | null;
  /** The custom emoji this row stands for, or null for a unicode one. */
  readonly emoji: CustomEmoji | null;
}

export interface EmojiAutocompleteOptions {
  /** Called with the text to insert (`:wave:` or a unicode character). */
  readonly onSelect: (insert: string) => void;
  readonly onClose: () => void;
}

/** Same shape as the shared inline-autocomplete widget. */
export type EmojiAutocompleteComponent = InlineAutocompleteComponent;

function byLabel(a: EmojiSuggestion, b: EmojiSuggestion): number {
  return a.label.localeCompare(b.label);
}

/** The preview cell for one row: the custom emoji's image, or the character. */
function buildPreview(s: EmojiSuggestion): HTMLSpanElement {
  const preview = createElement("span", { class: "ea-preview" });
  if (s.emoji !== null) preview.appendChild(buildCustomEmojiImage(s.emoji));
  else setText(preview, s.char ?? "");
  return preview;
}

/**
 * Suggestions for `query`, in the order the popup lists them: custom emoji
 * first (prefix matches before substring), then unicode, alphabetical within
 * each group.
 *
 * A query shorter than MIN_EMOJI_QUERY yields nothing at all, so the composer
 * never opens a popup over a lone colon.
 */
export function filterEmojiSuggestions(query: string): EmojiSuggestion[] {
  const q = query.toLowerCase();
  if (q.length < MIN_EMOJI_QUERY) return [];

  const customPrefix: EmojiSuggestion[] = [];
  const customSubstring: EmojiSuggestion[] = [];
  for (const emoji of listCustomEmoji()) {
    const name = emoji.shortcode;
    if (!name.includes(q)) continue;
    const entry: EmojiSuggestion = {
      label: name,
      insert: `:${name}:`,
      detail: "Server emoji",
      kind: "custom",
      char: null,
      emoji,
    };
    if (name.startsWith(q)) customPrefix.push(entry);
    else customSubstring.push(entry);
  }

  const unicodePrefix: EmojiSuggestion[] = [];
  const unicodeSubstring: EmojiSuggestion[] = [];
  for (const [char, keywords] of Object.entries(EMOJI_NAMES)) {
    if (!keywords.includes(q)) continue;
    const words = keywords.split(" ");
    const primary = words[0] ?? keywords;
    const entry: EmojiSuggestion = {
      label: primary,
      insert: char,
      detail: words.slice(1).join(" "),
      kind: "unicode",
      char,
      emoji: null,
    };
    // "Prefix" means some whole keyword starts with the query, not just the
    // primary one — typing ":fire" should rank 🔥 ("fire hot flame lit") above
    // an emoji that merely contains "fire" mid-word.
    if (words.some((w) => w.startsWith(q))) unicodePrefix.push(entry);
    else unicodeSubstring.push(entry);
  }

  customPrefix.sort(byLabel);
  customSubstring.sort(byLabel);
  unicodePrefix.sort(byLabel);
  unicodeSubstring.sort(byLabel);

  return [...customPrefix, ...customSubstring, ...unicodePrefix, ...unicodeSubstring].slice(
    0,
    MAX_EMOJI_SUGGESTIONS,
  );
}

/** One emoji row: preview cell, `:label:`/name, and a keyword detail line. */
function renderEmojiRow(s: EmojiSuggestion): HTMLElement[] {
  const name = createElement("span", { class: "ma-name" });
  setText(name, s.kind === "custom" ? `:${s.label}:` : s.label);
  const detail = createElement("span", { class: "ma-detail" });
  setText(detail, s.detail);
  return [buildPreview(s), name, detail];
}

export function createEmojiAutocomplete(
  options: EmojiAutocompleteOptions,
): EmojiAutocompleteComponent {
  return createInlineAutocomplete<EmojiSuggestion>({
    // Shares the base class deliberately (the composer test selects
    // `.mention-autocomplete:not(.emoji-autocomplete)` to distinguish them).
    rootClass: "mention-autocomplete emoji-autocomplete",
    rootTestId: "emoji-autocomplete",
    filter: filterEmojiSuggestions,
    valueOf: (s) => s.insert,
    rowTestId: (s) => `emoji-option-${s.label}`,
    renderRow: renderEmojiRow,
    // Unlike mentions, emoji stay empty until the composer types past
    // MIN_EMOJI_QUERY, so there is nothing to prime on create.
    onSelect: options.onSelect,
    onClose: options.onClose,
  });
}
