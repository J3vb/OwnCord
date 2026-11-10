/**
 * DmSidebar component — direct messages sidebar showing conversations
 * sorted by most recent, with unread indicators.
 *
 * Uses the `channel-sidebar` container class (shared with channel sidebar)
 * and DM-specific classes from app.css: dm-sidebar-header, dm-search,
 * dm-section-label, dm-add, dm-item, dm-avatar, dm-status,
 * dm-name, dm-close, dm-unread.
 *
 * Rows are keyed on the DM *channel*, not on a recipient user: a group DM has
 * no single recipient, and the same person can be in both a 1:1 and a group
 * with you, so a user id no longer identifies a conversation.
 */

import { Disposable } from "@lib/disposable";
import { createElement, setText, appendChildren } from "@lib/dom";
import { atEachMidnight } from "@lib/text/formatting";
import { reconcileChildren } from "@lib/net/reconcile";
import { enableRovingNavigation, setRovingTabindex } from "@lib/ui/a11y";
import type { ModalInstance } from "@lib/ui/modalFactory";
import type { MountableComponent } from "@lib/text/safeRender";
import { requestsText } from "../../i18n/requests";
import { onPrefChange } from "@lib/prefs/preferences";
import { convoSignature, renderDmItem } from "./dmRow";
import { openLeaveConfirm, type DmMenuConvo } from "./dmContextMenu";
import type { DmConversation, DmSidebarOptions } from "./dmConversation";

export type { DmConversation, DmSidebarOptions } from "./dmConversation";
export { buildGroupAvatarStack } from "./dmAvatars";

/**
 * SidebarArea refreshes the DM list on every dmStore change (a presence flip,
 * a message, an unread clear). Rebuilding the whole subtree would lose the
 * "Find a conversation" filter, its focus and the scroll position; the keyed
 * list keeps every unchanged row, so those all survive an unrelated update.
 */
export interface DmSidebar extends MountableComponent {
  /** Re-render the conversation rows from a fresh list, in place. */
  update(conversations: readonly DmConversation[]): void;
}

/** A row the search filter has not hidden: the only rows the keyboard visits. */
const VISIBLE_ROW = ".dm-item:not([hidden])";

/**
 * The order the conversation list renders in: pure recency, which is the order
 * the store already carries (the server lists DMs by last message time, and
 * every store mutator moves a touched DM to the front). The old unread-first
 * sort contradicted this component's own header — and unread is not
 * what a DM list is for; the badge already marks what is unread.
 */
function sortConversations(conversations: readonly DmConversation[]): DmConversation[] {
  return [...conversations];
}

export function createDmSidebar(options: DmSidebarOptions): DmSidebar {
  const disposable = new Disposable();
  let root: HTMLDivElement | null = null;
  let list: HTMLDivElement | null = null;
  let emptyState: HTMLDivElement | null = null;
  let searchInput: HTMLInputElement | null = null;
  // The sorted list the current filter runs over, kept in sync with the DOM.
  let rendered: readonly DmConversation[] = [];
  // Rows the search filter has hidden, so a later update can re-apply it.
  let query = "";
  // Each row's listeners die with the row, not with the sidebar.
  const rowOwners = new Map<Element, Disposable>();
  let leavePrompt: { channelId: number; modal: ModalInstance } | null = null;

  function confirmLeave(convo: DmMenuConvo, onClose: (channelId: number) => void): void {
    leavePrompt = {
      channelId: convo.channelId,
      modal: openLeaveConfirm(convo, onClose, disposable.signal),
    };
  }

  /** Apply the current search query to the current rows. */
  function applyFilter(): void {
    if (list === null) return;
    const q = query.trim().toLowerCase();
    const rows = list.children;
    rendered.forEach((convo, i) => {
      const el = rows[i] as HTMLElement | undefined;
      if (el === undefined) return;
      const match = q === "" || convo.username.toLowerCase().includes(q);
      el.hidden = !match;
    });
    setRovingTabindex(list, VISIBLE_ROW);
  }

  function update(conversations: readonly DmConversation[]): void {
    if (list === null) return;
    rendered = sortConversations(conversations);
    reconcileChildren(list, rendered, {
      key: (c) => String(c.channelId),
      signature: convoSignature,
      create: (convo) => {
        const owner = new Disposable();
        const el = renderDmItem(convo, options, owner.signal, confirmLeave);
        rowOwners.set(el, owner);
        return el;
      },
      dispose: (el) => {
        rowOwners.get(el)?.destroy();
        rowOwners.delete(el);
      },
    });
    if (leavePrompt !== null && !rendered.some((c) => c.channelId === leavePrompt?.channelId)) {
      leavePrompt.modal.close();
      leavePrompt = null;
    }
    applyFilter();
    if (emptyState !== null) emptyState.hidden = rendered.length > 0;
  }

  function mount(container: Element): void {
    // Reuse channel-sidebar container class per mockup
    root = createElement("div", { class: "channel-sidebar" });

    // Back to server header (optional)
    if (options.onBack !== undefined) {
      const backFn = options.onBack;
      const backHeader = createElement("div", {
        class: "dm-back-header",
        "data-testid": "dm-back-header",
      });
      backHeader.tabIndex = 0;
      backHeader.setAttribute("role", "button");
      // Named by the visible title rather than a second copy of its text.
      const backTitleId = "dm-back-title";
      backHeader.setAttribute("aria-labelledby", backTitleId);
      const arrow = createElement("span", { class: "dm-back-arrow", "aria-hidden": "true" }, "←");
      const backInfo = createElement("div", { class: "dm-back-info" });
      const backTitle = createElement(
        "div",
        { class: "dm-back-title", id: backTitleId },
        requestsText("dm.backTo", {
          server: options.serverName ?? requestsText("dm.serverFallback"),
        }),
      );
      const backSub = createElement(
        "div",
        { class: "dm-back-subtitle" },
        requestsText("dm.returnToChannels"),
      );
      appendChildren(backInfo, backTitle, backSub);
      appendChildren(backHeader, arrow, backInfo);
      backHeader.addEventListener("click", () => backFn(), { signal: disposable.signal });
      backHeader.addEventListener(
        "keydown",
        (e: KeyboardEvent) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          backFn();
        },
        { signal: disposable.signal },
      );
      root.appendChild(backHeader);
    }

    // Search header
    const header = createElement("div", { class: "dm-sidebar-header" });
    searchInput = createElement("input", {
      class: "dm-search",
      placeholder: requestsText("dm.find"),
    });
    header.appendChild(searchInput);

    // Section label with + button
    const sectionLabel = createElement("div", { class: "dm-section-label" });
    setText(sectionLabel, requestsText("dm.heading"));
    const addBtn = createElement("button", {
      class: "dm-add",
      title: requestsText("dm.new"),
    });
    setText(addBtn, "+");
    addBtn.addEventListener("click", () => options.onNewDm(), { signal: disposable.signal });
    sectionLabel.appendChild(addBtn);

    // Conversation list
    list = createElement("div", { class: "dm-conversation-list" });

    searchInput.addEventListener(
      "input",
      () => {
        query = searchInput?.value ?? "";
        applyFilter();
      },
      { signal: disposable.signal },
    );

    // One Tab stop for the list; ArrowUp/Down step, Enter/Space open.
    enableRovingNavigation(list, VISIBLE_ROW, disposable.signal, "vertical");
    // A row's time is "3:04 PM" today and "Sep 29" after midnight.
    atEachMidnight(disposable.signal, () => update(rendered));
    // A clock-format change relabels the row times in place.
    onPrefChange(["timeFormat", "dateFormat"], () => update(rendered), disposable.signal);

    // Nothing to list: say so, with the way to start (Discord's DM list does).
    emptyState = createElement("div", {
      class: "dm-empty",
      "data-testid": "dm-empty-state",
    });
    emptyState.hidden = true;
    const startBtn = createElement(
      "button",
      { type: "button", class: "dm-empty-start", "data-testid": "dm-empty-start" },
      requestsText("dm.emptyStart"),
    );
    startBtn.addEventListener("click", () => options.onNewDm(), { signal: disposable.signal });
    appendChildren(
      emptyState,
      createElement("p", { class: "dm-empty-text" }, requestsText("dm.empty")),
      startBtn,
    );

    appendChildren(root, header, sectionLabel, list, emptyState);
    container.appendChild(root);

    update(options.conversations);
  }

  function destroy(): void {
    disposable.destroy();
    for (const owner of rowOwners.values()) owner.destroy();
    rowOwners.clear();
    if (root !== null) {
      root.remove();
      root = null;
    }
    list = null;
    emptyState = null;
    searchInput = null;
    rendered = [];
  }

  return { mount, update, destroy };
}
