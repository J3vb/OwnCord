/**
 * The channel sidebar's row builders: each draws a row or a category group from
 * its model, then binds its handlers. A row's listeners hold the row's own
 * `Disposable` (kept in `ownerByEl`), NOT the sidebar-lifetime signal:
 * addEventListener({ signal }) keeps a detached row alive via that signal's own
 * retained "abort" listener list until it fires, so a row left on the sidebar
 * signal would be retained for the sidebar's whole lifetime. Anything a handler
 * mounts outside the row (a menu or modal on document.body) takes the
 * sidebar-lifetime signal instead, so an unrelated re-render cannot tear it
 * down.
 */

import { Disposable } from "@lib/disposable";
import { navigateToChannel } from "@lib/nav/channelNavigation";
import { attachPressWarm } from "@lib/nav/pressWarm";
import {
  NO_CATEGORY,
  UNCATEGORIZED_VOICE_CATEGORY,
  type CategoryRef,
  type Channel,
} from "@stores/channels.store";
import { followedThreadsStore } from "@stores/followedThreads.store";
import { toggleCategory } from "@stores/ui.store";
import { attachCategoryContextMenu } from "./sidebar/categoryMenu";
import { attachChannelContextMenu } from "./sidebar/contextMenu";
import { attachCategoryDragHandlers, attachDragHandlers } from "./sidebar/dragReorder";
import { attachThreadContextMenu } from "./sidebar/threadMenu";
import type { ChannelSidebarOptions } from "./channelSidebarTypes";
import {
  drawCategoryGroup,
  drawTextChannelRow,
  drawThreadMoreRow,
  drawThreadRow,
  type CategoryGroupModel,
  type ThreadMoreRowModel,
  type ThreadRowModel,
} from "./channelRow.view";
import type { ChannelGroup, ChannelRowModel, SidebarEntry } from "./channelRowModel";
import type { VoiceRows } from "./voiceSidebarRows";

/** What every builder needs from the sidebar that owns the rows. */
export interface RowEnv {
  readonly options: ChannelSidebarOptions;
  /** The sidebar's lifetime: aborted only in destroy(). */
  readonly lifetime: AbortSignal;
  /** Listener owners for every keyed group and row. */
  readonly ownerByEl: WeakMap<Element, Disposable>;
  readonly voice: VoiceRows;
}

/** A followed thread's row: a click opens its parent and the panel; the menu offers Mark as Read and Unfollow. */
export function createThreadRow(env: RowEnv, model: ThreadRowModel): HTMLDivElement {
  const { onOpenThread, onMarkThreadRead, onUnfollowThread } = env.options;
  const el = drawThreadRow(model);
  const owner = new Disposable();
  env.ownerByEl.set(el, owner);
  const { signal } = owner;
  const { threadId, parentId } = model;
  el.addEventListener("click", () => onOpenThread?.(threadId, parentId), { signal });
  attachThreadContextMenu(
    el,
    {
      hasUnread: () => {
        const row = followedThreadsStore
          .getState()
          .byParent.get(parentId)
          ?.find((r) => r.id === threadId);
        return row !== undefined && (row.unread > 0 || row.mentions > 0);
      },
      onMarkRead: () => onMarkThreadRead?.(threadId),
      onUnfollow: () => onUnfollowThread?.(threadId),
    },
    signal,
    env.lifetime,
  );
  return el;
}

/** A parent's "N more" row: opens its channel and the Threads list. */
export function createThreadMoreRow(env: RowEnv, model: ThreadMoreRowModel): HTMLDivElement {
  const el = drawThreadMoreRow(model);
  const owner = new Disposable();
  env.ownerByEl.set(el, owner);
  el.addEventListener("click", () => env.options.onOpenThreadList?.(model.parentId), {
    signal: owner.signal,
  });
  return el;
}

/**
 * A channel's row, text or voice: drawn from its model, then the click, the
 * context menu and the drag handlers. `shown` is the group's displayed rows,
 * the order Move Up/Down swaps within; `g` the group, whose channels the drag
 * moves among.
 */
export function createChannelRow(
  env: RowEnv,
  model: ChannelRowModel,
  ch: Channel,
  atEvent: () => SidebarEntry,
  container: HTMLElement,
  g: ChannelGroup,
  shown: readonly Channel[],
): HTMLElement {
  const { onEditChannel, onDeleteChannel, onPurgeChannel, onReorderChannel, onInviteFromChannel } =
    env.options;
  const liveChannel = (): Channel => {
    const entry = atEvent();
    return entry.kind === "channel" ? entry.channel : ch;
  };
  const owner = new Disposable();
  const { signal } = owner;
  const el = model.kind === "voice" ? env.voice.create(ch, signal) : drawTextChannelRow(model);
  if (model.kind !== "voice") {
    el.addEventListener("click", () => navigateToChannel(model.channelId), { signal });
    attachPressWarm(el, model.channelId, signal);
  }
  attachChannelContextMenu(
    el,
    ch,
    signal,
    // Sidebar-lifetime signal (aborted only in destroy()) for anything
    // that owns DOM mounted outside this render's rows — a menu or
    // modal on document.body must not be torn down by an unrelated
    // re-render.
    env.lifetime,
    // A row now outlives a channel edit, so the actions take the live
    // channel, not the one this row was built for.
    onEditChannel === undefined ? undefined : () => onEditChannel(liveChannel()),
    onDeleteChannel === undefined ? undefined : () => onDeleteChannel(liveChannel()),
    onPurgeChannel === undefined
      ? undefined
      : (_channel, count) => onPurgeChannel(liveChannel(), count),
    shown,
    onReorderChannel,
    onInviteFromChannel === undefined ? undefined : () => onInviteFromChannel(liveChannel()),
    model.access,
  );
  attachDragHandlers(
    el,
    ch,
    container,
    g.channels,
    signal,
    env.lifetime,
    onReorderChannel,
    model.access.manageChannels,
  );
  env.ownerByEl.set(el, owner);
  return el;
}

/** Bind a real category's header: its "+", the drag, the collapse click and the menu. */
function bindCategoryHeader(
  env: RowEnv,
  model: CategoryGroupModel,
  key: string,
  category: CategoryRef,
  header: HTMLElement,
  arrow: HTMLElement,
  signal: AbortSignal,
): void {
  const { onCreateChannel, onCreateCategory, onRenameCategory, onDeleteCategory, onMoveCategory } =
    env.options;
  header.querySelector(":scope > .category-add-btn")?.addEventListener(
    "click",
    (e) => {
      e.stopPropagation();
      // The synthetic Voice group files nothing: no category, a voice channel.
      if (key === UNCATEGORIZED_VOICE_CATEGORY && model.categoryId === 0) {
        onCreateChannel?.(NO_CATEGORY, "voice");
      } else {
        onCreateChannel?.(category);
      }
    },
    { signal },
  );
  // Registered before the collapse click so its capture-phase guard and
  // the drag's own listeners belong to the same render owner.
  if (model.draggable) {
    attachCategoryDragHandlers(
      header,
      model.categoryId,
      signal,
      env.lifetime,
      env.options.onReorderCategory,
      model.draggable,
    );
  }
  header.addEventListener("click", () => toggleCategory(key), { signal });
  attachCategoryContextMenu(
    header,
    arrow,
    { key, ...category },
    {
      onCreateCategory,
      onRenameCategory,
      onDeleteCategory,
      onMoveCategory,
    },
    signal,
    env.lifetime,
  );
}

/** Draw one category group from its model, bind its header, then fill its rows. */
export function buildCategoryGroup(
  env: RowEnv,
  model: CategoryGroupModel,
  g: ChannelGroup,
  reconcileRows: (container: HTMLElement, g: ChannelGroup) => void,
): HTMLDivElement {
  const group = drawCategoryGroup(model);
  const owner = new Disposable();
  env.ownerByEl.set(group, owner);
  const { key, name } = model;

  if (key !== null && name !== null) {
    const header = group.querySelector<HTMLElement>(":scope > .category");
    const arrow = header?.querySelector<HTMLElement>(":scope > .category-arrow") ?? null;
    if (header !== null && arrow !== null) {
      const category: CategoryRef = { id: model.categoryId, name };
      bindCategoryHeader(env, model, key, category, header, arrow, owner.signal);
    }
  }

  const container = group.querySelector<HTMLElement>(":scope > .category-channels-container");
  // Populate through the reconciler so every row gets its key metadata; a
  // later in-place update can then recognise and reuse them.
  if (container !== null) reconcileRows(container, g);
  return group;
}
