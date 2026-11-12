/**
 * The chat header's More button. On a phone the header has room for search,
 * the call buttons and one more control, so the panel toggles (profile or
 * members, pins, media) move behind it; CSS hides them and shows this button
 * under the phone media query, and on a wider screen the button stays hidden.
 *
 * The sheet's rows are built at open time from the buttons that are showing
 * in this header mode, and a row clicks its button, so each button keeps its
 * own handler, label and pressed state as the only source of truth.
 */

import { Disposable } from "../../lib/disposable";
import { createElement } from "../../lib/dom";
import { createIcon } from "../../lib/icons";
import type { ContextMenuItem } from "../../lib/ui/contextMenu";
import { openMenuSheet } from "../menus/menuSheet";
import { messagingText } from "../../i18n/messaging";

export interface ChatHeaderOverflow {
  readonly button: HTMLButtonElement;
  readonly destroy: () => void;
}

/** A button the header shows in its current mode: not `hidden`, not display:none inline. */
function isShown(btn: HTMLButtonElement): boolean {
  return !btn.hidden && btn.style.display !== "none";
}

function rowFor(btn: HTMLButtonElement): ContextMenuItem {
  const pressed = btn.getAttribute("aria-pressed");
  return {
    label: btn.getAttribute("aria-label") ?? btn.title,
    testId: `chat-header-more-${btn.dataset["testid"] ?? ""}`,
    ...(pressed === null ? {} : { checked: pressed === "true" }),
    onClick: () => btn.click(),
  };
}

export function createChatHeaderOverflow(
  buttons: readonly HTMLButtonElement[],
): ChatHeaderOverflow {
  const owner = new Disposable();
  const label = messagingText("header.more");
  const button = createElement("button", {
    type: "button",
    class: "ch-more-btn",
    title: label,
    "aria-label": label,
    "aria-haspopup": "true",
    "aria-expanded": "false",
    "data-testid": "chat-header-more",
  });
  button.appendChild(createIcon("ellipsis", 18));
  button.addEventListener(
    "click",
    () => {
      const items = buttons.filter(isShown).map(rowFor);
      if (items.length === 0) return;
      button.setAttribute("aria-expanded", "true");
      openMenuSheet({
        items,
        label,
        testId: "chat-header-more-sheet",
        signal: owner.signal,
        fallbackFocus: () => (button.isConnected ? button : null),
        onClosed: () => button.setAttribute("aria-expanded", "false"),
      });
    },
    { signal: owner.signal },
  );
  return { button, destroy: () => owner.destroy() };
}
