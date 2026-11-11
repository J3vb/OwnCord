/**
 * The New Post dialog's tag picker: a hint line (a required marker when the
 * forum asks for a tag) and one toggle chip per tag, up to the per-post limit.
 */

import { createElement } from "@lib/dom";
import type { ForumTag } from "@lib/types";
import { forumsText } from "../../i18n/forums";
import { MAX_POST_TAGS } from "./forumModel";

/** One labelled field, in the app's shared form-group spacing. */
export function fieldGroup(...children: HTMLElement[]): HTMLElement {
  const g = createElement("div", { class: "form-group" });
  g.append(...children);
  return g;
}

export interface TagSectionInput {
  readonly tags: readonly ForumTag[];
  readonly requireTag: boolean;
  readonly channelId: number;
  /** The picked tag ids; the section edits it in place. */
  readonly picked: Set<number>;
  readonly onPick: () => void;
  readonly signal: AbortSignal;
}

/** The tag picker: a hint line, and a chip per tag that toggles it. */
export function buildTagSection(input: TagSectionInput): {
  group: HTMLElement;
  firstChip: HTMLButtonElement | null;
} {
  const { tags, requireTag, channelId, picked } = input;
  const hintId = `forum-post-tags-hint-${channelId}`;
  const hint = createElement(
    "span",
    { id: hintId, class: "forum-tags-hint", "data-testid": "forum-post-tags-hint" },
    requireTag
      ? forumsText("dialog.tagsRequired")
      : forumsText("dialog.tagsOptional", { max: MAX_POST_TAGS }),
  );
  const tagsHead = createElement("div", { class: "forum-field-head" });
  const tagsLabel = createElement("span", { class: "form-label" }, forumsText("dialog.tagsLabel"));
  if (requireTag) {
    tagsLabel.appendChild(
      createElement("span", { class: "forum-required", "aria-hidden": "true" }, " *"),
    );
  }
  tagsHead.append(tagsLabel, hint);
  const tagBar = createElement("div", {
    class: "forum-tag-bar forum-dialog-tags",
    role: "group",
    "aria-describedby": hintId,
    "aria-label": forumsText("dialog.tagsLabel"),
    "data-testid": "forum-post-tags",
  });
  const tagChips = new Map<number, HTMLButtonElement>();
  const paintTags = (): void => {
    for (const [id, chip] of tagChips) {
      const on = picked.has(id);
      chip.classList.toggle("selected", on);
      chip.setAttribute("aria-pressed", String(on));
      chip.disabled = !on && picked.size >= MAX_POST_TAGS;
    }
  };
  let firstChip: HTMLButtonElement | null = null;
  for (const tag of tags) {
    const chip = createElement(
      "button",
      {
        type: "button",
        class: "forum-tag forum-tag-chip",
        "data-testid": `forum-post-tag-${tag.id}`,
      },
      `${tag.emoji ?? ""} ${tag.name}`.trim(),
    );
    chip.addEventListener(
      "click",
      () => {
        if (!picked.delete(tag.id)) picked.add(tag.id);
        paintTags();
        input.onPick();
      },
      { signal: input.signal },
    );
    tagChips.set(tag.id, chip);
    firstChip ??= chip;
    tagBar.appendChild(chip);
  }
  paintTags();
  return { group: fieldGroup(tagsHead, tagBar), firstChip };
}
