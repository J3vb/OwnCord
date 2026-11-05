/**
 * The message actions on a phone: the message menu's own rows, laid out as a
 * bottom sheet. The quick reactions and Add Reaction sit in one row of large
 * round buttons on top; each separator-delimited section of the menu becomes
 * its own card below, so Delete and Report keep their red group at the bottom.
 *
 * It only lays out what `messageMenu.ts` built: which rows show, which are
 * locked, and what each does all come from there.
 */

import type { ContextMenuItem, ContextMenuSeparator } from "@lib/ui/contextMenu";
import { openBottomSheet } from "@lib/ui/bottomSheet";
import { createElement } from "@lib/dom";

export interface MessageSheetRequest {
  readonly items: readonly (ContextMenuItem | ContextMenuSeparator)[];
  /** The quick reactions: `count` items from `start`, then Add Reaction. */
  readonly group: { readonly start: number; readonly count: number } | null;
  readonly label: string;
  readonly groupLabel: string;
  readonly signal: AbortSignal;
  readonly fallbackFocus: () => HTMLElement | null;
  readonly onClosed: () => void;
}

const ADD_REACTION_TEST_ID = "msg-menu-add-reaction";

function isSeparator(item: ContextMenuItem | ContextMenuSeparator): item is ContextMenuSeparator {
  return "separator" in item;
}

function actionButton(item: ContextMenuItem, className: string, close: () => void): HTMLElement {
  const btn = createElement("button", {
    type: "button",
    class: className,
    ...(item.testId !== undefined ? { "data-testid": item.testId } : {}),
    ...(item.title !== undefined ? { title: item.title } : {}),
  });
  if (item.content !== undefined) {
    btn.setAttribute("aria-label", item.label);
    btn.appendChild(item.content);
  } else {
    btn.textContent = item.label;
  }
  if (item.danger === true) btn.classList.add("danger");
  if (item.disabled === true) {
    // Still focusable, so the reason in the title can be read out.
    btn.setAttribute("aria-disabled", "true");
  }
  btn.addEventListener("click", (e) => {
    if (item.disabled === true) return;
    // Closed first: the action may open the next sheet (Add Reaction) or a
    // dialog, and must find this one gone.
    close();
    item.onClick(e);
  });
  return btn;
}

export function openMessageSheet(req: MessageSheetRequest): void {
  const content = createElement("div", { class: "msg-sheet" });
  const sheet = openBottomSheet({
    label: req.label,
    content,
    testId: "message-sheet",
    signal: req.signal,
    fallbackFocus: req.fallbackFocus,
    onClosed: req.onClosed,
  });
  if (sheet.signal.aborted) return;
  const close = sheet.close;

  const { items, group } = req;
  const inGroup = (i: number): boolean =>
    group !== null && i >= group.start && i < group.start + group.count;
  const addReactionAt = items.findIndex(
    (item) => !isSeparator(item) && item.testId === ADD_REACTION_TEST_ID,
  );

  const quick = createElement("div", {
    class: "msg-sheet-quick",
    role: "group",
    "aria-label": req.groupLabel,
  });
  const sections: HTMLElement[] = [];
  let section: HTMLElement | null = null;
  for (const [i, item] of items.entries()) {
    if (isSeparator(item)) {
      section = null;
      continue;
    }
    if (inGroup(i) || i === addReactionAt) {
      const btn = actionButton(item, "msg-sheet-quick-btn", close);
      if (i === addReactionAt) {
        btn.classList.add("msg-sheet-add-reaction");
        btn.setAttribute("aria-label", item.label);
        btn.textContent = "+";
      }
      quick.appendChild(btn);
      continue;
    }
    if (section === null) {
      section = createElement("div", { class: "msg-sheet-section" });
      sections.push(section);
    }
    section.appendChild(actionButton(item, "msg-sheet-action", close));
  }

  if (quick.childElementCount > 0) content.appendChild(quick);
  content.append(...sections);
}
