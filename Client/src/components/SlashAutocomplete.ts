/**
 * SlashAutocomplete — the command list the composer opens while the whole
 * draft is "/" plus letters (3A-10a). A thin config over the shared
 * inline-autocomplete listbox, like ChannelAutocomplete: the keyboard handling
 * and the combobox ARIA live there.
 *
 * Uses @lib/dom helpers exclusively. Never sets innerHTML with user content.
 */

import { createElement, setText } from "@lib/dom";
import {
  createInlineAutocomplete,
  type InlineAutocompleteComponent,
} from "@components/inlineAutocomplete";
import { messagingText } from "../i18n/messaging";
import { filterSlashCommands, type SlashCommand } from "../features/messaging/slashCommands";

export interface SlashAutocompleteOptions {
  /** Called with the command name to insert (without the leading "/"). */
  readonly onSelect: (name: string) => void;
  readonly onClose: () => void;
  /** Composer textarea the popup completes for (see inline-autocomplete). */
  readonly comboboxInput?: HTMLElement;
}

export type SlashAutocompleteComponent = InlineAutocompleteComponent;

function renderSlashRow(c: SlashCommand): HTMLElement[] {
  const name = createElement("span", { class: "ma-name" });
  setText(name, `/${c.name}`);
  const detail = createElement("span", { class: "ma-detail" });
  setText(detail, messagingText(c.descriptionKey));
  return [name, detail];
}

export function createSlashAutocomplete(
  options: SlashAutocompleteOptions,
): SlashAutocompleteComponent {
  return createInlineAutocomplete<SlashCommand>({
    rootClass: "mention-autocomplete slash-autocomplete",
    rootTestId: "slash-autocomplete",
    filter: filterSlashCommands,
    valueOf: (c) => c.name,
    rowTestId: (c) => `slash-option-${c.name}`,
    renderRow: renderSlashRow,
    ariaLabel: messagingText("slash.listLabel"),
    primeOnCreate: true,
    onSelect: options.onSelect,
    onClose: options.onClose,
    comboboxInput: options.comboboxInput,
  });
}
