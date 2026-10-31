/**
 * Unread state in the message list: the NEW line, the unread bar, marking read
 * as rows are seen, and Mark Unread.
 */
import { isWindowDetached } from "@stores/messages.store";
import { isReadSurface } from "@stores/threads.store";
import { channelsStore } from "@stores/channels.store";
import { UNREAD_COUNT_CAP, formatBadgeCount, formatMessageTimestamp } from "@lib/text/formatting";
import { messagingText } from "../../i18n/messaging";
import {
  markChannelRead,
  markChannelReadSeen,
  hasUnread,
  isHeldUnread,
  isChannelAway,
  isChannelCovered,
  noteLiveMessageSeen,
  noteMessageSeen,
  noteVisibleMessageSeen,
} from "@lib/readState";
import { readPointerEnabled } from "@lib/net/serverCapabilities";
import { markMessageUnread } from "./markUnread";
import { UNREAD_BAR_CLEARANCE, type ScrollMetrics, readMetrics } from "./listShared";
import type { ListState, ListApi } from "./listState";

export function createListUnread(st: ListState, api: ListApi) {
  /** Move the view to the NEW divider once one exists. Does not force a row rebuild (R2). */
  function openAtDividerIfReady(): boolean {
    // Hidden, the scroller cannot move: the resize observer places it once shown.
    if (!st.openAtDividerPending || st.root === null || st.root.clientHeight === 0) return false;
    const idx = st.virtualItems.findIndex((item) => item.kind === "new-divider");
    if (idx === -1) return false;
    st.openAtDividerPending = false;
    // The rows between here and the divider are estimates until rendered, so
    // settle against their measured heights, as a jump does.
    for (let pass = 0; pass < 3; pass++) {
      if (!api.placeIndex(idx, -UNREAD_BAR_CLEARANCE)) break;
    }
    api.updateScrollToBottomBtn();
    return true;
  }

  /** The bar shows while the visit has unread it has not dismissed. */
  function updateUnreadBar(): void {
    if (st.unreadBar === null || st.unreadBarLabel === null) return;
    let text = "";
    // A detached window draws no NEW line, so the bar (which counts toward it)
    // stays hidden until the tail returns.
    if (!st.unreadBarDismissed && st.unreadOnOpen > 0 && !isWindowDetached(st.options.channelId)) {
      const shown = formatBadgeCount(st.openedUnread);
      if (st.unreadOnOpen === Infinity) {
        text = messagingText("unreadBar.capped", { shown });
      } else {
        // The divider latches to the first unread message; until it does (a
        // deferred revisit) there is no time to show.
        const anchor = st.allMessages.find((m) => m.id === st.newDividerAnchorId);
        if (anchor !== undefined) {
          text = messagingText("unreadBar.since", {
            count: st.openedUnread,
            shown,
            time: formatMessageTimestamp(anchor.timestamp),
          });
        }
      }
    }
    st.unreadBarLabel.textContent = text;
    st.unreadBar.hidden = text === "";
    // Announce when the count first appears, not on every refresh.
    if (st.unreadAnnouncer !== null) {
      if (text === "") st.unreadAnnouncer.textContent = "";
      else if (st.unreadAnnouncer.textContent === "") st.unreadAnnouncer.textContent = text;
    }
  }

  function dismissUnreadBar(): void {
    st.unreadBarDismissed = true;
    updateUnreadBar();
  }

  function markReadAndJumpToPresent(): void {
    if (st.root === null) return;
    dismissUnreadBar();
    // Just marked unread: Escape is the reader asking for it read, so mark at
    // latest (which also ends the hold). Otherwise what was seen. The gate
    // keeps a held or repeated Escape off the 5/s mark_read budget.
    if (readPointerEnabled() && isHeldUnread(st.options.channelId)) {
      markChannelRead(st.options.channelId);
    } else if (hasUnread(st.options.channelId) || readPointerEnabled()) {
      markChannelReadSeen(st.options.channelId);
    }
    if (isWindowDetached(st.options.channelId)) {
      st.options.onJumpToPresent?.();
      return;
    }
    api.scrollToBottom();
    api.updateScrollToBottomBtn();
  }

  /** A messagesByChannel / historyLoadState change landed: refresh the bar and the open position. */
  function settleUnreadNav(): void {
    // Only while the reader is still at the bottom the mount left them at.
    if (st.openAtDividerPending && api.isNearBottom()) openAtDividerIfReady();
    updateUnreadBar();
    markReadIfSeen();
  }

  /**
   * The channel is read once the reader has seen its bottom with
   * the window focused. Fires on every scroll and on window focus; the
   * hasUnread gate keeps a plain scroll from spending the server's 5/s
   * mark_read budget, and the bottom of a detached window is not the present,
   * so that case is excluded too (isChannelAway, lib/readState.ts).
   * The bottom-in-view check alone also covers focus returning while the reader
   * is scrolled up.
   */
  function markReadIfSeen(m?: ScrollMetrics): void {
    if (st.root === null) return;
    if (!isReadSurface(st.options.channelId, channelsStore.getState().activeChannelId)) return;
    if (!api.isAtBottom(m) || isChannelAway(st.options.channelId)) {
      st.bottomMarked = false;
      noteVisibleRowsSeen(m);
      return;
    }
    // The cached bottom of a revisit predates what arrived while away; keep
    // the bar until the refetched tail places the divider.
    if (st.newDividerDeferred) return;
    dismissUnreadBar();
    // With a read pointer the mark is what was seen, and what gates it is the
    // pointer (nothing is sent unless the newest seen id is above it); without
    // one, the local unread count gates it, as before.
    if (readPointerEnabled()) {
      if (!isChannelCovered()) noteMessageSeen(st.options.channelId, newestLoadedId());
      // Every append auto-scrolls and lands here: send on reaching the bottom
      // only. Arrivals watched at the bottom go by the throttled live path.
      if (st.bottomMarked) return;
      st.bottomMarked = true;
    } else if (!hasUnread(st.options.channelId)) return;
    markChannelReadSeen(st.options.channelId);
  }

  /**
   * A reader scrolling short of the bottom has seen the rows on screen: record
   * the newest confirmed one whose top is above the viewport's bottom, so
   * leaving sends `mark_read` up to it (the badge was cleared on open, and the
   * server must follow). Records only; nothing is sent here. Reads the height
   * tree, not the DOM, so a scroll event costs one lookup.
   */
  function noteVisibleRowsSeen(m?: ScrollMetrics): void {
    if (st.root === null || !readPointerEnabled() || isChannelCovered()) return;
    if (st.newDividerDeferred || st.virtualItems.length === 0) return;
    // The last pixel in view: a row starting exactly at the bottom edge is not.
    const { scrollTop, clientHeight } = m ?? readMetrics(st.root);
    const bottom = scrollTop + Math.max(clientHeight - 1, 0);
    for (let i = Math.min(api.offsetToIndex(bottom), st.virtualItems.length - 1); i >= 0; i--) {
      const item = st.virtualItems[i]!;
      if (item.kind === "blocked-run" && !item.expanded) {
        noteVisibleMessageSeen(st.options.channelId, item.lastId);
        return;
      }
      if (item.kind !== "message" || item.message.id <= 0) continue;
      noteVisibleMessageSeen(st.options.channelId, item.message.id);
      return;
    }
  }

  /** The newest confirmed message loaded here (pending rows have no id yet); 0 for none. */
  function newestLoadedId(): number {
    for (let i = st.allMessages.length - 1; i >= 0; i--) {
      if (st.allMessages[i]!.id > 0) return st.allMessages[i]!.id;
    }
    return 0;
  }

  /**
   * Mark Unread from `messageId` (the message menu, Alt+click): the server's
   * pointer and the NEW line both move to just before it. A no-op unless the
   * server keeps a read pointer.
   */
  function markUnreadFrom(messageId: number): void {
    const before = {
      linePointer: st.linePointer,
      newDividerAnchorId: st.newDividerAnchorId,
      markedUnread: st.markedUnread,
      unreadBarDismissed: st.unreadBarDismissed,
      openedUnread: st.openedUnread,
      unreadOnOpen: st.unreadOnOpen,
    };
    const pointer = markMessageUnread(st.options.channelId, messageId);
    if (pointer === null) return;
    st.unmarked = before;
    st.linePointer = pointer;
    st.newDividerAnchorId = messageId;
    st.markedUnread = true;
    st.unreadBarDismissed = false;
    refreshUnreadFromChannel(messageId);
    if (!api.patchRows()) api.renderAll();
  }

  /**
   * The Mark Unread did not happen (refused, or never sent) and its pointer is
   * back: the NEW line and the unread bar go back to what they were. A
   * confirming `read_state` never comes here, so a mark that worked stays.
   */
  function revertMarkUnread(): void {
    if (st.unmarked === null) return;
    ({
      linePointer: st.linePointer,
      newDividerAnchorId: st.newDividerAnchorId,
      markedUnread: st.markedUnread,
      unreadBarDismissed: st.unreadBarDismissed,
      openedUnread: st.openedUnread,
      unreadOnOpen: st.unreadOnOpen,
    } = st.unmarked);
    st.unmarked = null;
    updateUnreadBar();
    if (!api.patchRows()) api.renderAll();
  }

  /**
   * After Mark Unread the top bar and the line count what is unread now: the
   * channel's count once the server has answered (`read_state`), until then the
   * loaded messages from the marked one on.
   */
  function refreshUnreadFromChannel(markedId: number): void {
    const known = channelsStore.getState().channels.get(st.options.channelId)?.unreadCount ?? 0;
    st.openedUnread = known > 0 ? known : st.allMessages.filter((m) => m.id >= markedId).length;
    st.unreadOnOpen = st.openedUnread >= UNREAD_COUNT_CAP ? Infinity : st.openedUnread;
    updateUnreadBar();
  }

  /**
   * A live message was appended while the reader had the live tail in view. The
   * dispatcher does not count it unread, so markReadIfSeen (gated on a local
   * unread count) never sends for it; tell the server it was seen, throttled
   * (lib/readState.ts). Same away and deferred-divider checks as above, plus
   * the Settings overlay and content views, which cover a still-mounted list.
   */
  function markLiveArrivalSeen(): void {
    if (st.root === null) return;
    if (!isReadSurface(st.options.channelId, channelsStore.getState().activeChannelId)) return;
    if (isChannelAway(st.options.channelId) || isChannelCovered()) return;
    if (st.newDividerDeferred) return;
    noteMessageSeen(st.options.channelId, newestLoadedId(), true);
    noteLiveMessageSeen(st.options.channelId, st.disposable.signal);
  }

  return {
    openAtDividerIfReady,
    updateUnreadBar,
    dismissUnreadBar,
    markReadAndJumpToPresent,
    settleUnreadNav,
    markReadIfSeen,
    noteVisibleRowsSeen,
    newestLoadedId,
    markUnreadFrom,
    revertMarkUnread,
    refreshUnreadFromChannel,
    markLiveArrivalSeen,
  };
}
