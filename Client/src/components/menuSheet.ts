/**
 * A menu as a bottom sheet, for a phone. It lays out the rows a popover menu
 * would show (`ContextMenuItem`, the type `showContextMenu` takes), so the
 * channel menu and the server menu keep the rows, order and gates they have
 * on a desktop and only the presentation changes.
 *
 * Rows between separators become cards, as in the message actions sheet. A
 * row that owns a `submenu` (Mute Channel, Notification Settings) has no
 * hover flyout here: tapping it opens a second page in the same sheet, with a
 * back arrow that returns to the first. A row with a check state is a
 * checkbox, or a radio inside a group on the second page.
 *
 * Android Back and a swipe down close the whole sheet (bottomSheet.ts); Escape
 * on the second page goes back one page first.
 */

import type { ContextMenuItem, ContextMenuSeparator } from "@lib/ui/contextMenu";
import { openBottomSheet, type BottomSheet } from "@lib/ui/bottomSheet";
import { isImeCommit } from "@lib/text/ime";
import { createElement } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { shellText } from "../i18n/shell";

type MenuRow = ContextMenuItem | ContextMenuSeparator;

export interface MenuSheetRequest {
  readonly items: readonly MenuRow[];
  /** The sheet's accessible name. */
  readonly label: string;
  readonly testId: string;
  /** The owner's lifetime: an abort closes the sheet. */
  readonly signal: AbortSignal;
  /** Where focus goes on close when the control that opened the sheet is gone. */
  readonly fallbackFocus: () => HTMLElement | null;
  /** Runs once, however the sheet closed. */
  readonly onClosed?: () => void;
  /**
   * Extra rows after the first page's cards, for what a plain row cannot say
   * (the purge prompt's count field). `close` closes the sheet; `signal`
   * aborts when it has closed.
   */
  readonly footer?: (card: HTMLElement, close: () => void, signal: AbortSignal) => void;
}

function isSeparator(row: MenuRow): row is ContextMenuSeparator {
  return "separator" in row;
}

/** The cards of one page: rows between separators, in order. */
function sectionsOf(rows: readonly MenuRow[]): ContextMenuItem[][] {
  const sections: ContextMenuItem[][] = [];
  let current: ContextMenuItem[] | null = null;
  for (const row of rows) {
    if (isSeparator(row)) {
      current = null;
      continue;
    }
    if (current === null) {
      current = [];
      sections.push(current);
    }
    current.push(row);
  }
  return sections;
}

export function openMenuSheet(req: MenuSheetRequest): BottomSheet {
  const content = createElement("div", { class: "msg-sheet menu-sheet" });
  const sheet = openBottomSheet({
    label: req.label,
    content,
    testId: req.testId,
    signal: req.signal,
    fallbackFocus: req.fallbackFocus,
    ...(req.onClosed !== undefined ? { onClosed: req.onClosed } : {}),
  });
  if (sheet.signal.aborted) return sheet;
  const close = sheet.close;
  /** The row that opened the second page, so Back can hand focus back to it. */
  let openedFrom: ContextMenuItem | null = null;
  const rowButtons = new Map<ContextMenuItem, HTMLElement>();
  let onSecondPage = false;

  function actionButton(item: ContextMenuItem, inRadioGroup: boolean): HTMLElement {
    const btn = createElement("button", {
      type: "button",
      class: "msg-sheet-action menu-sheet-row",
      ...(item.testId !== undefined ? { "data-testid": item.testId } : {}),
      ...(item.title !== undefined ? { title: item.title } : {}),
    });
    btn.appendChild(createElement("span", { class: "menu-sheet-label" }, item.label));
    if (item.detail !== undefined) {
      btn.appendChild(createElement("span", { class: "menu-sheet-detail" }, item.detail));
    }
    if (item.danger === true) btn.classList.add("danger");
    if (item.checked !== undefined) {
      btn.setAttribute("role", inRadioGroup || item.radio === true ? "radio" : "checkbox");
      btn.setAttribute("aria-checked", String(item.checked));
      btn.classList.toggle("checked", item.checked);
    }
    const disabled = item.disabled === true;
    if (disabled) {
      // Still focusable, so the reason in the title can be read out.
      btn.setAttribute("aria-disabled", "true");
    }
    const submenu = item.submenu;
    if (submenu !== undefined && !disabled) {
      btn.classList.add("menu-sheet-next");
      btn.setAttribute("aria-haspopup", "true");
      btn.addEventListener("click", () => showSecondPage(item, submenu));
    } else {
      btn.addEventListener("click", (e) => {
        if (disabled) return;
        // Closed first: the action may open a dialog and must find this gone.
        close();
        item.onClick(e);
      });
    }
    rowButtons.set(item, btn);
    return btn;
  }

  function cards(rows: readonly MenuRow[], radio: boolean): HTMLElement[] {
    return sectionsOf(rows).map((section) => {
      const card = createElement("div", { class: "msg-sheet-section" });
      if (radio) card.setAttribute("role", "radiogroup");
      for (const item of section) card.appendChild(actionButton(item, radio));
      return card;
    });
  }

  function showFirstPage(): void {
    onSecondPage = false;
    rowButtons.clear();
    const pageCards = cards(req.items, false);
    if (req.footer !== undefined) {
      const card = createElement("div", { class: "msg-sheet-section menu-sheet-footer" });
      req.footer(card, close, sheet.signal);
      if (card.childElementCount > 0) pageCards.push(card);
    }
    content.replaceChildren(...pageCards);
  }

  function showSecondPage(from: ContextMenuItem, rows: readonly ContextMenuItem[]): void {
    onSecondPage = true;
    openedFrom = from;
    rowButtons.clear();
    const back = createElement("button", {
      type: "button",
      class: "menu-sheet-back",
      "aria-label": shellText("sheet.back"),
      "data-testid": "menu-sheet-back",
    });
    back.appendChild(createIcon("chevron-left", 22));
    back.addEventListener("click", goBack);
    const head = createElement("div", { class: "menu-sheet-head" });
    head.append(back, createElement("span", { class: "menu-sheet-title" }, from.label));
    const radio = rows.some((r) => r.radio === true);
    content.replaceChildren(head, ...cards(rows, radio));
    (content.querySelector<HTMLElement>(".menu-sheet-row") ?? back).focus();
  }

  function goBack(): void {
    const from = openedFrom;
    openedFrom = null;
    showFirstPage();
    if (from !== null) rowButtons.get(from)?.focus();
  }

  // The panel's own Escape closes the sheet; on the second page that one
  // press goes back a page, and the next closes.
  content.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || isImeCommit(e) || !onSecondPage) return;
      e.preventDefault();
      goBack();
    },
    { signal: sheet.signal },
  );

  showFirstPage();
  // The sheet focused its (still empty) panel as it opened: the first row is the better start.
  content.querySelector<HTMLElement>(".menu-sheet-row")?.focus();
  return sheet;
}
