/**
 * ChannelAutocomplete — inline channel picker the composer opens on "#".
 * Uses @lib/dom helpers exclusively. Never sets innerHTML with user content.
 */

import { createElement, setText } from "@lib/dom";
import { channelsStore } from "@stores/channels.store";
import {
  createInlineAutocomplete,
  type InlineAutocompleteComponent,
} from "@components/inline-autocomplete";
import { messagingText } from "../i18n/messaging";

/** Maximum rows shown at once, as for mentions. */
export const MAX_CHANNEL_SUGGESTIONS = 10;

/** Names the `#channel` grammar can express (lib/mentions CHANNEL_TOKEN_REGEX). */
const CHANNEL_NAME = /^[\p{L}\p{N}_-]{1,64}$/u;

export interface ChannelSuggestion {
  readonly id: number;
  readonly name: string;
  /** The channel's category, or "Voice channel" for an uncategorised voice one. */
  readonly detail: string;
}

export interface ChannelAutocompleteOptions {
  /** Called with the channel name to insert (without the leading "#"). */
  readonly onSelect: (name: string) => void;
  readonly onClose: () => void;
  /** Composer textarea the popup completes for (see inline-autocomplete). */
  readonly comboboxInput?: HTMLElement;
}

export type ChannelAutocompleteComponent = InlineAutocompleteComponent;

function byPosition(a: { position: number }, b: { position: number }): number {
  return a.position - b.position;
}

/**
 * Server channels for `query`, prefix matches before substring matches, each
 * group in sidebar order. DMs are not channels here, and a name the `#token`
 * grammar cannot express is left out: inserting it would not link.
 */
export function filterChannelSuggestions(query: string): ChannelSuggestion[] {
  const q = query.toLowerCase();
  const prefix: { s: ChannelSuggestion; position: number }[] = [];
  const substring: { s: ChannelSuggestion; position: number }[] = [];
  for (const ch of channelsStore.getState().channels.values()) {
    if (ch.type === "dm" || !CHANNEL_NAME.test(ch.name)) continue;
    const lower = ch.name.toLowerCase();
    if (q !== "" && !lower.includes(q)) continue;
    const detail =
      ch.category ?? (ch.type === "voice" ? messagingText("channelMention.voice") : "");
    const entry = { s: { id: ch.id, name: ch.name, detail }, position: ch.position };
    (q === "" || lower.startsWith(q) ? prefix : substring).push(entry);
  }
  return [...prefix.toSorted(byPosition), ...substring.toSorted(byPosition)]
    .slice(0, MAX_CHANNEL_SUGGESTIONS)
    .map((e) => e.s);
}

function renderChannelRow(s: ChannelSuggestion): HTMLElement[] {
  const name = createElement("span", { class: "ma-name" });
  setText(name, `#${s.name}`);
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
