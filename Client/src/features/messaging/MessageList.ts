/**
 * MessageList component — renders chat messages with grouping, day dividers,
 * role-colored usernames, @mention highlighting, infinite scroll, and
 * virtual scrolling (DOM windowing) for performance with large message counts.
 */
import { Disposable } from "@lib/disposable";
import { setOwnedTimeout } from "@lib/dom";
import { messagesStore, getChannelMessages, isWindowDetached } from "@stores/messages.store";
import { takeReadingPosition } from "./message-list/readingPositions";
import { preloadInlineEdit } from "./inlineEditLoader";
import { clearContentParseCache } from "./content/contentParser";
import { getPointerOnOpen, getUnreadOnOpen } from "@stores/channels.store";
import { UNREAD_COUNT_CAP } from "@lib/text/formatting";
import { setLiveTailInView } from "@lib/readState";
import { readPointerEnabled } from "@lib/net/serverCapabilities";
import { blockedUsers } from "./message-list/listShared";
import type { ListState, ListApi } from "./message-list/listState";
import { createListWindow } from "./message-list/listWindow";
import { createListRender } from "./message-list/listRender";
import { createListScroll } from "./message-list/listScroll";
import { createListUnread } from "./message-list/listUnread";
import { createListRows } from "./message-list/listRows";
import { buildListDom } from "./message-list/listDom";
import { wireListInput } from "./message-list/listInput";
import { observeListResize } from "./message-list/listResize";
import { subscribeListStores } from "./message-list/listSubscriptions";
import type { MessageListOptions, MessageListComponent } from "./messageListOptions";

/**
 * MessageList component — renders chat messages with grouping, day dividers,
 * role-colored usernames, @mention highlighting, infinite scroll, and
 * virtual scrolling (DOM windowing) for performance with large message counts.
 */
export { estimateItemHeight, type VirtualItem } from "./message-list/virtualItems";

export type { MessageListOptions, MessageListComponent } from "./messageListOptions";

// -- Factory ------------------------------------------------------------------

export function createMessageList(options: MessageListOptions): MessageListComponent {
  const disposable = new Disposable();
  const openedUnread = isWindowDetached(options.channelId) ? 0 : getUnreadOnOpen(options.channelId);
  const st: ListState = {
    options,
    disposable,
    unsubscribers: [],
    shownBlocked: new Set<number>(),
    renderOptions: {
      ...options,
      listSignal: disposable.signal,
      get blockedUsers() {
        return blockedUsers();
      },
    },
    rowOwners: new Map<HTMLElement, Disposable>(),
    edit: null,
    editGen: 0,
    editRefocus: false,
    region: null,
    root: null,
    wasAtBottom: true,
    virtualItems: [],
    allMessages: [],
    replyParents: [],
    heightCache: new Map<string, number>(),
    estimateWidth: undefined,
    tree: null,
    topSpacer: null,
    bottomSpacer: null,
    contentContainer: null,
    scrollToBottomBtn: null,
    unreadBar: null,
    unreadBarLabel: null,
    unreadAnnouncer: null,
    unreadBarDismissed: false,
    openAtDividerPending: false,
    restorePosition: null,
    scrollToBottomCount: null,
    newBelowCount: 0,
    mentionsBelowCount: 0,
    replyTargetId: null,
    jumpToPresentPill: null,
    renderedStart: 0,
    renderedEnd: 0,
    lastCanManageMessages: false,
    flashTimer: 0,
    flashEl: null,
    openedUnread,
    unreadOnOpen: openedUnread >= UNREAD_COUNT_CAP ? Infinity : openedUnread,
    markedUnread: false,
    bottomMarked: false,
    newDividerAnchorId: null,
    linePointer: readPointerEnabled() ? getPointerOnOpen(options.channelId) : undefined,
    newDividerDeferred: false,
    loadedEmptyShown: false,
    followOwnSendUntil: 0,
    scrollSnapshot: null,
    bottomGapBeforeResize: 0,
    btnShownKey: "",
    unmarked: null,
    jumpTarget: null,
    renderWindowCount: 0,
    renderWindowResetTimer: 0,
    renderWindowSuppressed: false,
    renderAllRunning: false,
    renderAllCount: 0,
    renderAllResetTimer: 0,
    renderAllSuppressed: false,
    loadingOlder: false,
    olderRetryAt: 0,
    loadingNewer: false,
    newerRetryAt: 0,
    olderLoadingRow: null,
    olderFailedRow: null,
    prevOldestId: getChannelMessages(options.channelId)[0]?.id ?? null,
    scrollRafId: 0,
    resizeRafId: 0,
    lastViewportHeight: 0,
    resizeObserver: null,
    closeProfilePopup: null,
  };
  const api = {} as ListApi;
  Object.assign(
    api,
    createListWindow(st, api),
    createListRender(st, api),
    createListScroll(st, api),
    createListUnread(st, api),
    createListRows(st, api),
  );

  const unsubLoadingReset = messagesStore.subscribeSelector(
    (s) => s.messagesByChannel,
    () => {
      const msgs = getChannelMessages(st.options.channelId);
      const oldestId = msgs.length > 0 ? msgs[0]!.id : null;
      if (oldestId !== st.prevOldestId) {
        st.prevOldestId = oldestId;
        api.setLoadingOlder(false);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Mount / Destroy
  // ---------------------------------------------------------------------------

  function mount(parentContainer: Element): void {
    const dom = buildListDom(st, api);
    wireListInput(st, api, dom);
    observeListResize(st, api, dom);

    parentContainer.appendChild(dom.region);
    // Estimate at the real width from the first render, so rows an earlier
    // visit measured seed it rather than a reseed after the observer fires.
    if (dom.root.clientWidth > 0) st.estimateWidth = dom.root.clientWidth;

    st.openAtDividerPending = st.unreadOnOpen > 0;
    // Taken either way, so a position from before unread arrived is not reused later.
    const lastPosition = takeReadingPosition(st.options.channelId);
    st.restorePosition =
      st.unreadOnOpen === 0 && !isWindowDetached(st.options.channelId) ? lastPosition : null;
    api.renderAll();
    // Fetch the inline editor chunk once the list is up, so ArrowUp opens at once.
    setOwnedTimeout(st.disposable.signal, preloadInlineEdit, 0);
    api.updateJumpToPresentPill();
    const openedAtDivider = api.openAtDividerIfReady() || api.restoreReadingPositionIfReady();
    api.updateUnreadBar();
    // A deferred divider still moves the view later, so only the bottom
    // scrolls are skipped when the open already landed on it (or on the
    // spot the reader left).
    if (!openedAtDivider) api.scrollToBottom();
    setLiveTailInView(st.options.channelId, api.isNearBottom());
    const initialScrollRaf = requestAnimationFrame(() => {
      if (!openedAtDivider) api.scrollToBottom();
    });
    st.disposable.signal.addEventListener("abort", () => cancelAnimationFrame(initialScrollRaf));

    subscribeListStores(st, api);
  }

  function setReplyTarget(messageId: number | null): void {
    st.replyTargetId = messageId;
    if (st.contentContainer === null) return;
    for (const el of st.contentContainer.querySelectorAll(".message.reply-target")) {
      el.classList.remove("reply-target");
    }
    if (messageId === null) return;
    st.contentContainer
      .querySelector(`.message[data-testid="message-${messageId}"]`)
      ?.classList.add("reply-target");
  }

  function destroy(): void {
    api.rememberReadingPositionNow();
    if (st.resizeObserver !== null) {
      st.resizeObserver.disconnect();
      st.resizeObserver = null;
    }
    st.disposable.destroy();
    // A channel switch discards an open edit, as it always has.
    st.edit?.session?.destroy();
    st.edit = null;
    st.editGen++;
    setLiveTailInView(st.options.channelId, true);
    api.beginRowRender();
    if (st.scrollRafId !== 0) {
      cancelAnimationFrame(st.scrollRafId);
      st.scrollRafId = 0;
    }
    if (st.resizeRafId !== 0) {
      cancelAnimationFrame(st.resizeRafId);
      st.resizeRafId = 0;
    }
    if (st.renderAllResetTimer !== 0) {
      clearTimeout(st.renderAllResetTimer);
      st.renderAllResetTimer = 0;
    }
    if (st.renderWindowResetTimer !== 0) {
      clearTimeout(st.renderWindowResetTimer);
      st.renderWindowResetTimer = 0;
    }
    if (st.flashTimer !== 0) {
      clearTimeout(st.flashTimer);
      st.flashTimer = 0;
      st.flashEl = null;
    }
    unsubLoadingReset();
    for (const unsub of st.unsubscribers) {
      unsub();
    }
    st.unsubscribers.length = 0;
    st.heightCache.clear();
    clearContentParseCache();
    st.tree = null;
    api.releaseTrackedMedia();
    if (st.region !== null) {
      st.region.remove();
      st.region = null;
    }
    st.root = null;
    st.contentContainer = null;
    st.topSpacer = null;
    st.bottomSpacer = null;
    st.scrollToBottomBtn = null;
    st.btnShownKey = "";
    st.scrollSnapshot = null;
    st.unreadBar = null;
    st.unreadBarLabel = null;
    st.unreadAnnouncer = null;
    st.scrollToBottomCount = null;
    st.newBelowCount = 0;
    st.mentionsBelowCount = 0;
    st.jumpToPresentPill = null;
    st.olderLoadingRow = null;
    st.olderFailedRow = null;
  }

  return {
    mount,
    destroy,
    scrollToMessage: api.scrollToMessage,
    markReadAndJumpToPresent: api.markReadAndJumpToPresent,
    scrollPage: api.scrollPage,
    startEdit: api.startEdit,
    cancelEdit: api.cancelEdit,
    isEditing: api.isEditing,
    setReplyTarget,
  };
}
