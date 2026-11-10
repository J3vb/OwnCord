/**
 * The channel sidebar's list render: one pass over the groups the inputs
 * produce, reconciling each category group and then its rows by key, so an
 * unchanged row is reused with its listeners left alone. The empty state and
 * the focus a collapsed or hidden row hands back are handled here; the row and
 * group builders are `channelRowBinders.ts`'s.
 */

import { Disposable } from "@lib/disposable";
import { appendChildren, createElement } from "@lib/dom";
import { reconcileModels } from "@lib/net/reconcile";
import { setRovingTabindex } from "@lib/ui/a11y";
import { isChannelMuted } from "@lib/prefs/channelMutes";
import { NO_CATEGORY, type Channel } from "@stores/channels.store";
import { shellText } from "../../i18n/shell";
import type { CategoryGroupModel } from "./channelRow.view";
import {
  buildCategoryGroup,
  createChannelRow,
  createThreadMoreRow,
  createThreadRow,
  type RowEnv,
} from "./channelRowBinders";
import {
  categoryGroupModel,
  channelAccess,
  channelGroups,
  entryKey,
  sidebarEntries,
  sidebarRowModel,
  visibleRows,
  type ChannelGroup,
  type ChannelListContext,
  type ChannelListInputs,
  type SidebarEntry,
  type SidebarRowModel,
} from "./channelRowModel";
import type { SidebarInputs } from "./sidebarInputs";
import type { VoiceRowInputs } from "./voiceRowModel";

const UNCATEGORIZED_KEY = "\u0000uncategorized";
const groupKeyOf = (key: string | null): string => key ?? UNCATEGORIZED_KEY;

/** A row's reconcile key, from what it draws: a thread row, an "N more" row or a channel. */
function rowKeyOf(el: HTMLElement): string {
  if (el.dataset.threadId !== undefined) return `t${el.dataset.threadId}`;
  if (el.dataset.moreParentId !== undefined) return `m${el.dataset.moreParentId}`;
  return el.dataset.channelId ?? "";
}

/** The `.channel-item` of the container's child that holds focus, if one does.
 *  The row is the container's child holding focus, so a focused participant
 *  counts for its voice channel: it sits beside that channel's .channel-item,
 *  not inside it. */
function focusedChannelItem(container: HTMLElement): HTMLElement | null {
  const focused = document.activeElement;
  const holder =
    focused instanceof HTMLElement
      ? Array.from(container.children).find((child) => child.contains(focused))
      : undefined;
  if (holder === undefined) return null;
  return holder.matches(".channel-item")
    ? (holder as HTMLElement)
    : holder.querySelector<HTMLElement>(":scope > .channel-item");
}

/** Hand focus on: a hidden muted row in an expanded list goes to the row that
 *  took its place; otherwise to the category's arrow. */
function refocusAfterLoss(
  container: HTMLElement,
  header: Element | null,
  collapsed: boolean,
  lostIndex: number,
): void {
  const left = container.querySelectorAll<HTMLElement>(".channel-item");
  const next =
    !collapsed && left.length > 0 ? left[Math.min(Math.max(lostIndex, 0), left.length - 1)] : null;
  (next ?? header?.querySelector<HTMLElement>(".category-arrow"))?.focus();
}

/** The empty state: the plain message, plus the create button for a manager
 *  (a non-manager gets a hint instead). */
function drawEmptyState(
  env: RowEnv,
  list: ChannelListInputs,
): { el: HTMLDivElement; owner: Disposable | null } {
  const { onCreateChannel } = env.options;
  const emptyState = createElement("div", { class: "channel-list-empty" });
  const msg = createElement("p", { class: "channel-list-empty-text" }, shellText("channel.empty"));
  appendChildren(emptyState, msg);
  // With zero channels there is no category header, so the per-category
  // "+" (the only create affordance) never renders. Offer one here for a
  // manager; a non-manager gets the plain message (#9).
  if (onCreateChannel === undefined || !channelAccess(list).manageChannels) {
    emptyState.appendChild(
      createElement("p", { class: "channel-list-empty-hint" }, shellText("channel.emptyHint")),
    );
    return { el: emptyState, owner: null };
  }
  const createBtn = createElement(
    "button",
    {
      type: "button",
      class: "channel-list-empty-create",
      "data-testid": "create-channel-empty",
    },
    shellText("channel.create"),
  );
  // Per-render owner so repeated empty-state renders do not stack
  // listeners on the factory-lifetime signal.
  const owner = new Disposable();
  createBtn.addEventListener("click", () => onCreateChannel(NO_CATEGORY), {
    signal: owner.signal,
  });
  emptyState.appendChild(createBtn);
  return { el: emptyState, owner };
}

/**
 * The sidebar's list render, bound to what outlives a render: the callbacks and
 * owners in `env`, and each group's displayed rows, one array per group kept
 * across renders and refilled in place, so Move Up/Down on a row built earlier
 * swaps with the row shown next to it, not a channel a collapsed category
 * hides. The returned function draws `inputs` into `channelList`.
 */
export function createListRenderer(
  env: RowEnv,
): (channelList: HTMLElement, inputs: SidebarInputs) => void {
  const { options, ownerByEl, voice } = env;
  const shownRowsByGroup = new Map<string, Channel[]>();
  const listCtx: ChannelListContext = {
    isMuted: isChannelMuted,
    canCreate: options.onCreateChannel !== undefined,
    canReorder: options.onReorderChannel !== undefined,
    canReorderCategories: options.onReorderCategory !== undefined,
  };

  /** One group's rows, keyed and reused. A collapsed category
   *  keeps only the rows `visibleRows` allows. */
  function reconcileRows(
    container: HTMLElement,
    g: ChannelGroup,
    list: ChannelListInputs,
    voiceInputs: VoiceRowInputs,
  ): void {
    const rows = visibleRows(g, list, voiceInputs, listCtx);
    const byId = new Map(rows.map((c) => [c.id, c]));
    const header = container.parentElement?.querySelector(".category") ?? null;
    const groupKey = groupKeyOf(g.key);
    let shown = shownRowsByGroup.get(groupKey);
    if (shown === undefined) {
      shown = [];
      shownRowsByGroup.set(groupKey, shown);
    }
    shown.splice(0, shown.length, ...rows);
    const shownRows = shown;
    const collapsed = g.key !== null && list.collapsed.has(g.key);
    // A focused row a collapsed category stops showing (read, muted, emptied)
    // hands focus to the category's arrow instead of dropping it to the page.
    const focusedRow = focusedChannelItem(container);
    const entries = sidebarEntries(rows, g, list);
    const entryKeys = new Set(entries.map(entryKey));
    const losesFocus = focusedRow !== null && !entryKeys.has(rowKeyOf(focusedRow));
    const lostIndex = losesFocus
      ? Array.from(container.querySelectorAll(".channel-item")).indexOf(focusedRow)
      : -1;
    reconcileModels<SidebarEntry, SidebarRowModel>(container, entries, {
      key: entryKey,
      model: (entry) => sidebarRowModel(entry, g, list, listCtx),
      create: (model, atEvent) => {
        if (model.kind === "thread") return createThreadRow(env, model);
        if (model.kind === "threadMore") return createThreadMoreRow(env, model);
        const ch = byId.get(model.channelId);
        // i18n-exempt: developer-facing invariant error, never shown to a user
        if (ch === undefined) throw new Error("channel row built for a channel not in the pass");
        return createChannelRow(env, model, ch, atEvent, container, g, shownRows);
      },
      // A reused voice wrapper brings its chrome and participants up to date.
      update: (el, entry, model) => {
        if (model.kind === "voice" && entry.kind === "channel") voice.update(el, entry.channel);
      },
      dispose: voice.disposeOwned,
    });
    if (losesFocus) refocusAfterLoss(container, header, collapsed, lostIndex);
  }

  return (channelList, { list, voice: voiceInputs }) => {
    const groups = channelGroups(list);

    if (groups.length === 0) {
      for (const child of Array.from(channelList.children)) {
        voice.disposeOwned(child);
        child.remove();
      }
      const { el, owner } = drawEmptyState(env, list);
      if (owner !== null) ownerByEl.set(el, owner);
      channelList.appendChild(el);
      return;
    }
    channelList.querySelector(".channel-list-empty")?.remove();

    const reconcileGroupRows = (container: HTMLElement, g: ChannelGroup): void =>
      reconcileRows(container, g, list, voiceInputs);
    const groupsByKey = new Map(groups.map((g) => [groupKeyOf(g.key), g]));
    reconcileModels<ChannelGroup, CategoryGroupModel>(channelList, groups, {
      key: (g) => groupKeyOf(g.key),
      // A group rebuilds when its own header changes (collapse, the "+");
      // an unchanged group reuses its element and reconciles its rows in place.
      model: (g) => categoryGroupModel(g, list, listCtx),
      create: (model) => {
        const g = groupsByKey.get(groupKeyOf(model.key));
        // i18n-exempt: developer-facing invariant error, never shown to a user
        if (g === undefined) throw new Error("category group built for a group not in the pass");
        return buildCategoryGroup(env, model, g, reconcileGroupRows);
      },
      update: (el, g) => {
        const container = el.querySelector<HTMLElement>(".category-channels-container");
        if (container !== null) reconcileGroupRows(container, g);
      },
      dispose: voice.disposeOwned,
    });

    setRovingTabindex(channelList, ".channel-item");
  };
}
