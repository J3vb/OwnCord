/**
 * The Command Deck's Direct button: an envelope in the top bar with one count,
 * the unread DMs plus the waiting message requests, hidden at zero. A click
 * moves focus to the Direct folder's header in the server tree, opening the
 * sidebar drawer first when the tree is collapsed into it.
 *
 * It is built detached; `mountDeckFrame` attaches it. Its subscriptions belong
 * to the `owner` it is given.
 */
import type { Disposable } from "@lib/disposable";
import { createElement, setText } from "@lib/dom";
import { totalDmUnread } from "@lib/dmUnread";
import { createIcon } from "@lib/icons";
import { CHANNEL_MUTE_CHANGED } from "@lib/prefs/channelMutes";
import { formatBadgeCount } from "@lib/text/formatting";
import { dmStore } from "@stores/dm.store";
import { serverRailText } from "../../i18n/serverRail";
import { pendingRequestCount } from "../message-requests/store";
import { DIRECT_HEAD_CLASS } from "./dmFolder";

export interface DirectButtonInput {
  /** The page root; the Direct folder header is looked up inside it at click time. */
  readonly root: HTMLElement;
  /** Opens the sidebar drawer when the tree is collapsed into it. */
  readonly revealSidebar: (() => void) | undefined;
  readonly owner: Disposable;
}

/** The button's name: its unread DMs and waiting requests, each said apart. */
function directLabel(unread: number, requests: number): string {
  if (requests === 0) {
    return unread === 0
      ? serverRailText("homeDirect")
      : serverRailText("directUnread", { count: unread });
  }
  return unread === 0
    ? serverRailText("directRequests", { count: requests })
    : serverRailText("directUnreadRequests", { count: requests, unread });
}

/** Focus the Direct folder's header, revealing the drawer first when the tree is inert in it. */
function goToDirectFolder(input: DirectButtonInput): void {
  const head = input.root.querySelector<HTMLElement>(`.${DIRECT_HEAD_CLASS}`);
  if (head === null) return;
  if (head.closest("[inert]") !== null) input.revealSidebar?.();
  head.focus();
}

/** A detached button.deck-direct; its subscriptions go on `owner`. */
export function createDirectButton(input: DirectButtonInput): HTMLButtonElement {
  const button = createElement("button", {
    type: "button",
    class: "deck-direct",
    title: serverRailText("homeDirect"),
    "data-testid": "deck-direct",
  });
  const badge = createElement("span", { class: "deck-direct-badge", "aria-hidden": "true" });
  button.append(createIcon("mail", 16), badge);

  const draw = (): void => {
    const unread = totalDmUnread(dmStore.getState().channels);
    const requests = pendingRequestCount.get();
    const total = unread + requests;
    button.setAttribute("aria-label", directLabel(unread, requests));
    badge.hidden = total === 0;
    setText(badge, total === 0 ? "" : formatBadgeCount(total));
  };
  draw();
  const { owner } = input;
  owner.onStoreChange(dmStore, (s) => s.channels, draw);
  owner.addCleanup(pendingRequestCount.subscribe(draw));
  window.addEventListener(CHANNEL_MUTE_CHANGED, draw, { signal: owner.signal });

  button.addEventListener("click", () => {
    // WebKit does not focus a button on a mouse click, and the drawer records
    // whatever has focus as the opener to return to.
    button.focus();
    goToDirectFolder(input);
  });
  return button;
}
