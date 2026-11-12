// The emoji picker's grid cells. Never sets innerHTML with user content.

import { createElement, setText } from "@lib/dom";
import { buildCustomEmojiNode } from "./content/customEmoji";
import { buildEmojiImage, showsAsImage } from "./content/emojiImage";
import { showSheetCell } from "./emojiSheets";
import type { PickerImages } from "./pickerImages";

/** A sheet-backed cell: the emoji's index in its group and the group's size. */
export interface SheetSpot {
  readonly index: number;
  readonly count: number;
}

export function buildEmojiSpan(
  emoji: string,
  images: PickerImages,
  spot?: SheetSpot,
): HTMLSpanElement {
  const span = createElement("span", {
    class: "ep-emoji",
    title: emoji,
    role: "option",
    // Mirrors the title (the character or :shortcode: token) — e2e specs
    // select cells by title, so the accessible name must never diverge.
    "aria-label": emoji,
    // Read by the picker's delegated click handler on its scroll area
    // (EmojiPicker.ts) instead of a per-cell listener.
    "data-emoji": emoji,
  });
  // A catalog emoji shows its cell of the group's sheet; a `:shortcode:` entry
  // its image; a Recent emoji its own Twemoji image. An unresolvable shortcode
  // falls back to the text, which is what it would render as in a message.
  if (spot !== undefined) {
    showSheetCell(span, spot.index, spot.count);
    return span;
  }
  const image = buildCustomEmojiNode(emoji, images);
  if (image !== null) {
    span.classList.add("ep-emoji-custom");
    span.appendChild(image);
  } else if (showsAsImage(emoji)) {
    span.appendChild(buildEmojiImage(emoji));
  } else {
    setText(span, emoji);
  }
  return span;
}
