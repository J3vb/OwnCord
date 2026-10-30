/**
 * ChannelAutocomplete — inline channel picker the composer opens on "#".
 * Uses @lib/dom helpers exclusively. Never sets innerHTML with user content.
 */

import { createElement, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { channelsStore } from "@stores/channels.store";
import {
  createInlineAutocomplete,
  type InlineAutocompleteComponent,
} from "@components/inlineAutocomplete";
import { messagingText } from "../i18n/messaging";

/** Maximum rows shown at once, as for mentions. */
export const MAX_CHANNEL_SUGGESTIONS = 10;

/** Names the `#channel` grammar can express (lib/text/mentions CHANNEL_TOKEN_REGEX). */
const CHANNEL_NAME = /^[\p{L}\p{N}_-]{1,64}$/u;

export interface ChannelSuggestion {
  readonly id: number;
  readonly name: string;
  /** The channel's category, or "Voice channel" for an uncategorised voice one. */
  readonly detail: string;
  /** Set for a forum channel, whose row draws the forum glyph. */
  readonly forum?: true;
}

export interface ChannelAutocompleteOptions {
  /** Called with the channel name to insert (without the leading "#"). */
  readonly onSelect: (name: string) => void;
  readonly onClose: () => void;
  /** Composer textarea the popup completes for (see inline-autocomplete). */
  readonly comboboxInput?: HTMLElement;
}

export type ChannelAutocompleteComponent = InlineAutocompleteComponent;

/** The sidebar's order: position, then id for channels that share one. */
function byPosition(
  a: { position: number; id: number },
  b: { position: number; id: number },
): number {
  return a.position - b.position || a.id - b.id;
}

/**
 * Server channels for `query`, prefix matches before substring matches, each
 * group in sidebar order. DMs are not channels here, and a name the `#token`
 * grammar cannot express is left out: inserting it would not link. Of
 * channels sharing a name (in any case) only the one a `#name` link opens is
 * offered, the first in store order (lib/nav/channelNavigation findChannelByName).
 */
export function filterChannelSuggestions(query: string): ChannelSuggestion[] {
  const q = query.toLowerCase();
  const prefix: { s: ChannelSuggestion; position: number; id: number }[] = [];
  const substring: { s: ChannelSuggestion; position: number; id: number }[] = [];
  const seen = new Set<string>();
  for (const ch of channelsStore.getState().channels.values()) {
    if (ch.type === "dm") continue;
    const lower = ch.name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    if (!CHANNEL_NAME.test(ch.name)) continue;
    if (q !== "" && !lower.includes(q)) continue;
    const detail =
      ch.category ?? (ch.type === "voice" ? messagingText("channelMention.voice") : "");
    const entry = {
      s: {
        id: ch.id,
        name: ch.name,
        detail,
        ...(ch.type === "forum" ? { forum: true as const } : {}),
      },
      position: ch.position,
      id: ch.id,
    };
    (q === "" || lower.startsWith(q) ? prefix : substring).push(entry);
  }
  return [...prefix.toSorted(byPosition), ...substring.toSorted(byPosition)]
    .slice(0, MAX_CHANNEL_SUGGESTIONS)
    .map((e) => e.s);
}

function renderChannelRow(s: ChannelSuggestion): HTMLElement[] {
  const name = createElement("span", { class: "ma-name" });
  if (s.forum === true) {
    name.append(createIcon("messages-square", 12), ` ${s.name}`);
  } else {
    setText(name, `#${s.name}`);
  }
  const detail = createElement("span", { class: "ma-detail" });
  setText(detail, s.detail);
  return [name, detail];
}

export function createChannelAutocomplete(
  options: ChannelAutocompleteOptions,
): ChannelAutocompleteComponent {
  return createInlineAutocomplete<ChannelSuggestion>({
    rootClass: "mention-autocomplete channel-autocomplete",
    rootTestId: "channel-autocomplete",
    filter: filterChannelSuggestions,
    valueOf: (s) => s.name,
    rowTestId: (s) => `channel-option-${s.id}`,
    renderRow: renderChannelRow,
    primeOnCreate: true,
    onSelect: options.onSelect,
    onClose: options.onClose,
    comboboxInput: options.comboboxInput,
  });
}
