/**
 * The Direct folder: the last group of Command Deck's server tree. A header
 * with the unread total and a "+", People, Message requests (both always
 * there) and every DM and group DM, drawn as flat tree items under the
 * channel list's tree.
 *
 * It is its own module rather than a mode of the preview section, whose DOM
 * does not fit a tree. It builds a small skeleton and reuses the pieces both
 * lists share: the row parts, the leave prompt, the redraw triggers and the
 * People and requests rows. The tree's keys and Tab stop belong to
 * `lib/ui/treeKeys.ts`; this module never roves.
 *
 * Collapsing hides only the other conversations: People, Message requests and
 * the open chat stay, so a waiting request is never hidden.
 */
import { Disposable } from "@lib/disposable";
import { appendChildren, createElement, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { reconcileModels } from "@lib/net/reconcile";
import { formatBadgeCount } from "@lib/text/formatting";
import { showContextMenu } from "@lib/ui/contextMenu";
import { totalDmUnread } from "@lib/dmUnread";
import { dmStore, type DmChannel } from "@stores/dm.store";
import { channelsStore } from "@stores/channels.store";
import {
  DM_SECTION_COLLAPSED_KEY,
  isCategoryCollapsed,
  toggleCategory,
  uiStore,
} from "@stores/ui.store";
import { shellText } from "../../i18n/shell";
import type { ContentViewId, NavigationDestinations } from "../navigation/destinations";
import type { TreeSection } from "../channels/channelSidebarTypes";
import type { DmMenuActions } from "./dmContextMenu";
import { buildDmEntries } from "./dmEntries";
import {
  buildDmFolderRow,
  createLeavePrompt,
  dmFolderRowModel,
  watchDmListInputs,
  type DmFolderRowModel,
} from "./sidebarDmRow";

export interface DmFolderOptions {
  readonly onSelectDm: (dm: DmChannel) => void;
  readonly onNewDm: () => void;
  readonly menu: DmMenuActions | undefined;
  readonly destinations: NavigationDestinations | undefined;
  readonly onOpenView: ((id: ContentViewId, opener: HTMLElement) => void) | undefined;
}

const LABEL_ID = "server-tree-direct-label";

/** The header: a collapsible tree item with a decorative chevron, the label, the unread total and "+". */
function buildHeader(onNewDm: () => void): {
  readonly head: HTMLElement;
  readonly chevron: HTMLElement;
  readonly badge: HTMLElement;
} {
  const head = createElement("div", {
    class: "server-tree-direct-head",
    role: "treeitem",
    "data-tree-kind": "head",
    tabindex: "-1",
    "aria-labelledby": LABEL_ID,
    "aria-expanded": "true",
  });
  const chevron = createElement("span", { class: "category-arrow", "aria-hidden": "true" });
  const label = createElement(
    "span",
    { class: "category-name", id: LABEL_ID },
    shellText("dm.folder"),
  );
  const badge = createElement("span", { class: "dm-header-unread-badge", hidden: "" });
  const add = createElement(
    "button",
    {
      type: "button",
      class: "category-add-btn",
      title: shellText("dm.new"),
      "aria-label": shellText("dm.new"),
      "data-testid": "dm-folder-new",
      tabindex: "-1",
    },
    "+",
  );
  add.addEventListener("click", (e) => {
    e.stopPropagation();
    onNewDm();
  });
  appendChildren(head, chevron, label, badge, add);
  return { head, chevron, badge };
}

/** Draw the chevron for the folder's state, replacing the last one. */
function paintChevron(chevron: HTMLElement, collapsed: boolean): void {
  chevron.replaceChildren(createIcon(collapsed ? "chevron-right" : "chevron-down", 12));
}

export function createDmFolder(opts: DmFolderOptions): TreeSection {
  const owner = new Disposable();
  const unsubs: Array<() => void> = [];
  const rendered: Array<() => void> = [];
  // Each row's menu listeners die with the row, not with the folder.
  const rowOwners = new Map<Element, Disposable>();
  const leave = createLeavePrompt(owner.signal);
  const rowContext = {
    onSelectDm: opts.onSelectDm,
    menu: opts.menu,
    confirmLeave: leave.confirmLeave,
  };

  const root = createElement("div", { class: "server-tree-direct" });
  const { head, chevron, badge } = buildHeader(opts.onNewDm);
  const group = createElement("div", { "data-tree-group": "" });
  // People and Message requests are built once and never detached, so a focused
  // row survives a collapse or the last request being handled.
  const entries = buildDmEntries(opts, unsubs, "div");
  for (const entry of entries) {
    entry.setAttribute("role", "treeitem");
    entry.dataset.treeKind = "row";
    entry.setAttribute("tabindex", "-1");
  }
  const list = createElement("div", { class: "server-tree-direct-list" });
  appendChildren(group, ...entries, list);
  appendChildren(root, head, group);

  function paintHeader(channels: readonly DmChannel[], collapsed: boolean): void {
    head.setAttribute("aria-expanded", String(!collapsed));
    head.classList.toggle("collapsed", collapsed);
    paintChevron(chevron, collapsed);
    const total = totalDmUnread(channels);
    badge.hidden = total === 0;
    setText(badge, total === 0 ? "" : formatBadgeCount(total));
  }

  function render(): void {
    const channels = dmStore.getState().channels;
    const activeId = channelsStore.getState().activeChannelId;
    const collapsed = isCategoryCollapsed(DM_SECTION_COLLAPSED_KEY);
    paintHeader(channels, collapsed);
    // Collapsed, only the open conversation is passed: the reconciler removes the rest.
    const shown = collapsed ? channels.filter((dm) => dm.channelId === activeId) : channels;
    const hadFocus = list.contains(document.activeElement);
    reconcileModels<DmChannel, DmFolderRowModel>(list, shown, {
      key: (dm) => String(dm.channelId),
      model: (dm) => dmFolderRowModel(dm, activeId),
      create: (model) => {
        const rowOwner = new Disposable();
        const el = buildDmFolderRow(model, rowOwner.signal, rowContext);
        rowOwners.set(el, rowOwner);
        return el;
      },
      dispose: (el) => {
        rowOwners.get(el)?.destroy();
        rowOwners.delete(el);
      },
    });
    // A focused row that went away hands focus to the header, never to the page.
    if (hadFocus && !list.contains(document.activeElement)) head.focus();
    leave.closeIfGone(channels);
    for (const cb of rendered) cb();
  }

  head.addEventListener("click", () => toggleCategory(DM_SECTION_COLLAPSED_KEY));
  const openMenu = (x: number, y: number): void => {
    showContextMenu({
      x,
      y,
      items: [{ label: shellText("dm.new"), testId: "ctx-dm-new", onClick: opts.onNewDm }],
      signal: owner.signal,
      restoreFocusTo: () => head,
    });
  };
  head.addEventListener(
    "contextmenu",
    (e) => {
      e.preventDefault();
      openMenu(e.clientX, e.clientY);
    },
    { signal: owner.signal },
  );
  head.addEventListener(
    "keydown",
    (e) => {
      if ((e.shiftKey && e.key === "F10") || e.key === "ContextMenu") {
        e.preventDefault();
        const box = head.getBoundingClientRect();
        openMenu(box.right, box.top);
      }
    },
    { signal: owner.signal },
  );

  render();

  // The mute event, a call starting or ending and the DM list redraw it; so do
  // the open conversation (the highlight) and the folder's collapsed flag.
  watchDmListInputs(owner.signal, unsubs, render);
  owner.onStoreChange(channelsStore, (s) => s.activeChannelId, render);
  owner.onStoreChange(uiStore, (s) => s.collapsedCategories.has(DM_SECTION_COLLAPSED_KEY), render);
  // Home puts DM mode on; bring the folder's header into view, nothing more.
  owner.onStoreChange(
    uiStore,
    (s) => s.sidebarMode,
    (mode) => {
      if (mode === "dms") head.scrollIntoView({ block: "nearest" });
    },
  );

  return {
    element: root,
    onRender: (cb) => {
      rendered.push(cb);
    },
    destroy: () => {
      owner.destroy();
      for (const rowOwner of rowOwners.values()) rowOwner.destroy();
      rowOwners.clear();
      for (const unsub of unsubs) unsub();
    },
  };
}
