/**
 * MessageList component — renders chat messages with grouping, day dividers,
 * role-colored usernames, @mention highlighting, infinite scroll, and
 * virtual scrolling (DOM windowing) for performance with large message counts.
 */
import { Disposable } from "@lib/disposable";
import { createElement, setOwnedTimeout } from "@lib/dom";
import type { MountableComponent } from "@lib/text/safeRender";
import { messagesStore, getChannelMessages, isWindowDetached } from "@stores/messages.store";
import { membersStore } from "@stores/members.store";
import { blocksStore } from "@stores/blocks.store";
import { authorityChannelId, threadsStore } from "@stores/threads.store";
import { refreshThreadChips } from "./message-list/threadChip";
import { safetyStore } from "../features/safety/store";
import { registerReadingAnchor } from "../features/messaging/readingAnchor";
import { openUserProfilePopup } from "../features/profiles/openUserProfilePopup";
import { uiStore } from "@stores/ui.store";
import { renderUnreadBar, refreshConnectionControls } from "./message-list/renderers";
import { refreshReactionLocks } from "./message-list/reactions";
import { withMessageMenu } from "./message-list/messageMenuLoader";
import { preloadInlineEdit } from "../features/messaging/inlineEditLoader";
import { clearContentParseCache, relabelInlineTimestamps } from "./message-list/contentParser";
import { canManageMessages } from "@lib/permissions";
import { channelsStore, getPointerOnOpen, getUnreadOnOpen } from "@stores/channels.store";
import { UNREAD_COUNT_CAP, atEachMidnight } from "@lib/text/formatting";
import type { VirtualItemMessage } from "./message-list/virtualItems";
import type { PollOutcome } from "../features/messaging/pollSend";
import { messagingText } from "../i18n/messaging";
import { markChannelRead, onMarkUnreadFailed, setLiveTailInView } from "@lib/readState";
import { readPointerEnabled } from "@lib/net/serverCapabilities";
import { onPrefChange } from "@lib/prefs/preferences";
import {
  RELATIVE_TIMESTAMP_REFRESH_MS,
  FOLLOW_OWN_SEND_MS,
  SCROLL_BOTTOM_THRESHOLD,
  blockedUsers,
  moreButtonOf,
  readMetrics,
} from "./message-list/listShared";
import type { ListState, ListApi } from "./message-list/listState";
import { createListWindow } from "./message-list/listWindow";
import { createListRender } from "./message-list/listRender";
import { createListScroll } from "./message-list/listScroll";
import { createListUnread } from "./message-list/listUnread";
import { createListRows } from "./message-list/listRows";

/**
 * MessageList component — renders chat messages with grouping, day dividers,
 * role-colored usernames, @mention highlighting, infinite scroll, and
 * virtual scrolling (DOM windowing) for performance with large message counts.
 */
export { estimateItemHeight, type VirtualItem } from "./message-list/virtualItems";

// -- Options ------------------------------------------------------------------

export interface MessageListOptions {
  readonly channelId: number;
  readonly channelName: string;
  readonly channelType?: string;
  readonly currentUserId: number;
  /** May return a promise (e.g. the underlying fetch); MessageList clears its
   *  loadingOlder latch once it settles, success or failure. */
  readonly onScrollTop: () => void | Promise<void>;
  /**
   * Load the page of messages below a window detached from the live tail
   * (after a jump to an old message). Fired near the bottom of a detached
   * window only; may return a promise, which clears the in-flight latch once
   * it settles. The page that reaches the newest message reattaches the
   * window through the store. No paging below the window without it.
   */
  readonly onScrollBottom?: () => void | Promise<void>;
  readonly onReplyClick: (messageId: number) => void;
  readonly onEditClick: (messageId: number) => void;
  /**
   * Save the inline editor's text (cleaned, non-empty, within the limit).
   * True closes the editor; false keeps it open with the text (offline).
   */
  readonly onEditSave: (messageId: number, content: string) => boolean;
  /** Save with the text cleared: the host offers to delete the message. */
  readonly onEmptyEdit: (messageId: number) => void;
  /** The inline editor closed while it held focus: hand focus back (the composer). */
  readonly onEditEnd?: () => void;
  readonly onDeleteClick: (messageId: number, shiftKey: boolean) => void;
  readonly onReactionClick: (messageId: number, emoji: string) => void;
  readonly onPinClick: (messageId: number, channelId: number, currentlyPinned: boolean) => void;
  /** Report someone else's message or one of its attachments. No button without it. */
  readonly onReportClick?: (messageId: number) => void;
  /** Opens the Forward picker for a message. Absent, the menu offers no Forward. */
  readonly onForwardClick?: (messageId: number) => void;
  /** Set the viewer's whole selection on a poll (`[]` removes the vote); absent disables voting. */
  readonly onPollVote?: (
    messageId: number,
    answerIds: readonly number[],
  ) => Promise<PollOutcome<unknown>>;
  /** End a poll now; absent hides End poll. */
  readonly onPollEnd?: (messageId: number) => Promise<PollOutcome<unknown>>;
  /** Opens the Create Thread dialog for a message. Absent, the menu offers no Create Thread. */
  readonly onCreateThreadClick?: (messageId: number) => void;
  /** Opens a thread's side panel (the starter chip). Absent, the chip is inert text. */
  readonly onOpenThread?: (threadId: number) => void;
  /** Retry a failed optimistic send (by its correlation id). */
  readonly onRetry?: (correlationId: string) => void;
  /** Discard a failed optimistic send without retrying. */
  readonly onDeleteDraft?: (correlationId: string) => void;
  /** The upload strip of a send queued behind its files (3A-9), for the row with this
   *  correlation id; null when the row has none. `signal` ends with the row's render. */
  readonly renderUploadStrip?: (correlationId: string, signal: AbortSignal) => HTMLElement | null;
  /** Retry a failed first-page history fetch. */
  readonly onRetryLoad?: () => void;
  /**
   * Jump to another message in this channel — the reply bar above a reply, and
   * any other in-row affordance. May target a message outside the loaded
   * window; the handler is expected to fetch the around-window in that case.
   */
  readonly onJumpToMessage?: (messageId: number) => void;
  /**
   * Leave a detached around-window and reload the live tail. Wired to the
   * "Jump to Present" pill, which only appears while the window is detached.
   */
  readonly onJumpToPresent?: () => void;
  /** Send the 👋 reply to a welcome row. Absent, the row has no Wave button. */
  readonly onWave?: (messageId: number) => boolean;
  /** Open the pinned-messages panel ("pinned messages" link of a pin row). It never closes an open panel. */
  readonly onOpenPins?: () => void;
  /** Join the DM call a live call log row stands for. No Join button without it. */
  readonly onJoinCall?: (channelId: number) => void;
}

// -- Factory ------------------------------------------------------------------

export type MessageListComponent = MountableComponent & {
  /** Scroll to a message by ID. Returns false if the message is not in the loaded window. */
  scrollToMessage(messageId: number): boolean;
  /** Escape: mark the channel read, drop the unread bar and go back to the
   *  newest messages (a detached window jumps to the present). */
  markReadAndJumpToPresent(): void;
  /** PageUp/PageDown from the message box: scroll one page; 1 is down. */
  scrollPage(direction: 1 | -1): void;
  /**
   * Open the inline editor in your own sent message's row, with `text` (default
   * the message's current content). False when the message is not loaded, not
   * yours or not sent. The editor itself arrives a moment later (lazy chunk).
   */
  /** Open the inline editor on one of your sent messages. `focus: false`
   *  restores it quietly (no focus, no scrolling) for a late failed save. */
  startEdit(messageId: number, text?: string, opts?: { readonly focus?: boolean }): boolean;
  /** Close the open inline editor, discarding its text. */
  cancelEdit(): void;
  /** True while an inline editor is open (or loading) in this list. */
  isEditing(): boolean;
};

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
    scrollToBottomCount: null,
    newBelowCount: 0,
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

  /** The author name, avatar or user @mention chip `target` is inside, if any.
   *  @everyone/@here chips carry no `data-user-id`, so they never match. */
  function profileControlOf(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    const control = target.closest<HTMLElement>(
      ".msg-author[data-user-id], .msg-avatar[data-user-id], .mention[data-user-id]",
    );
    if (
      control === null ||
      st.contentContainer === null ||
      !st.contentContainer.contains(control)
    ) {
      return null;
    }
    return control;
  }

  function openProfileFrom(target: EventTarget | null, anchorX: number, anchorY: number): void {
    const control = profileControlOf(target);
    if (control === null) return;
    const userId = Number(control.dataset["userId"]);
    if (!Number.isInteger(userId) || userId <= 0) return;
    st.closeProfilePopup = openUserProfilePopup({
      userId,
      anchorX,
      anchorY,
      signal: st.disposable.signal,
      fallbackFocus: () => (control.isConnected ? control : null),
    });
  }

  // ---------------------------------------------------------------------------
  // Mount / Destroy
  // ---------------------------------------------------------------------------

  function mount(parentContainer: Element): void {
    st.region = createElement("div", { class: "messages-region" });
    // Focusable by script only (-1): the older-history Retry hands focus here.
    st.root = createElement("div", { class: "messages-container", tabindex: "-1" });

    st.topSpacer = createElement("div", { class: "virtual-spacer-top" });
    st.contentContainer = createElement("div", { class: "virtual-content" });
    st.bottomSpacer = createElement("div", { class: "virtual-spacer-bottom" });
    const scrollAnchor = createElement("div", { class: "scroll-anchor" });
    st.olderLoadingRow = createElement("div", {
      class: "messages-older-loading",
      role: "status",
      "aria-label": messagingText("loading"),
    });
    st.olderLoadingRow.appendChild(createElement("div", { class: "spinner" }));

    st.olderFailedRow = createElement("div", {
      class: "messages-older-failed",
      role: "alert",
      "data-testid": "messages-older-failed",
    });
    st.olderFailedRow.appendChild(
      createElement("span", { class: "messages-load-error-text" }, messagingText("loadFailed")),
    );
    const olderRetryBtn = createElement(
      "button",
      { class: "messages-retry-btn", type: "button", "data-testid": "messages-older-retry" },
      messagingText("retry"),
    );
    olderRetryBtn.addEventListener("click", api.retryOlder, { signal: st.disposable.signal });
    st.olderFailedRow.appendChild(olderRetryBtn);
    api.updateOlderFailedRow();

    st.scrollToBottomBtn = createElement("button", {
      class: "scroll-to-bottom-btn",
      "aria-label": messagingText("scrollToBottom"),
    });
    st.btnShownKey = "";
    st.scrollToBottomBtn.append("↓");
    st.scrollToBottomCount = createElement("span", {
      class: "scroll-to-bottom-count",
      "data-testid": "scroll-to-bottom-count",
      hidden: "",
    });
    st.scrollToBottomBtn.appendChild(st.scrollToBottomCount);
    st.scrollToBottomBtn.addEventListener(
      "click",
      () => {
        api.scrollToBottom();
        api.updateScrollToBottomBtn();
      },
      { signal: st.disposable.signal },
    );

    const unreadBarParts = renderUnreadBar(() => {
      markChannelRead(st.options.channelId);
      api.dismissUnreadBar();
    }, st.disposable.signal);
    st.unreadBar = unreadBarParts.bar;
    st.unreadBarLabel = unreadBarParts.label;
    st.unreadAnnouncer = unreadBarParts.announcer;

    st.jumpToPresentPill = createElement("button", {
      class: "jump-to-present-pill",
      "data-testid": "jump-to-present",
    });
    st.jumpToPresentPill.textContent = messagingText("jumpToPresent");
    st.jumpToPresentPill.addEventListener("click", () => st.options.onJumpToPresent?.(), {
      signal: st.disposable.signal,
    });

    st.root.appendChild(st.topSpacer);
    st.root.appendChild(st.contentContainer);
    st.root.appendChild(st.bottomSpacer);
    st.root.appendChild(scrollAnchor);
    st.region.appendChild(st.root);
    st.region.appendChild(st.olderFailedRow);
    st.region.appendChild(st.scrollToBottomBtn);
    st.region.appendChild(st.jumpToPresentPill);
    st.region.appendChild(st.unreadBar);
    st.region.appendChild(st.unreadAnnouncer);

    st.root.addEventListener("scroll", api.handleScroll, {
      signal: st.disposable.signal,
      passive: true,
    });

    // One delegated pair of listeners opens a user's profile from an author
    // name, an avatar or an @mention chip, so no row carries its own handler
    // (rows are rebuilt by virtual scrolling). Owned by disposable.signal.
    st.contentContainer.addEventListener(
      "click",
      (e) => {
        const control = profileControlOf(e.target);
        if (control === null) return;
        // A mention can be the label of a masked link ([@name](https://...)),
        // which would otherwise also navigate: the anchor's default action, and
        // main.ts's bubbling document listener that hands target=_blank links
        // to the system browser. Handle the click here and stop it, but only
        // inside an anchor so other document-level dismissals still see it.
        e.preventDefault();
        if (control.closest("a") !== null) e.stopPropagation();
        openProfileFrom(control, e.clientX, e.clientY);
      },
      { signal: st.disposable.signal },
    );
    st.contentContainer.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        const control = profileControlOf(e.target);
        if (control === null) return;
        e.preventDefault();
        const rect = control.getBoundingClientRect();
        openProfileFrom(control, rect.left, rect.bottom);
      },
      { signal: st.disposable.signal },
    );
    st.disposable.signal.addEventListener("abort", () => st.closeProfilePopup?.(), { once: true });

    // One delegated listener opens the message menu, by right-click and by the
    // Menu key / Shift+F10 (which dispatch `contextmenu` to the focused control
    // with no pointer position). The lazy module decides whether the target
    // offers a menu (an image's own listener stops the event first; a text
    // field keeps the webview's own menu), and main.ts already suppresses the
    // webview's menu everywhere else, so nothing is prevented here.
    st.contentContainer.addEventListener(
      "contextmenu",
      (e) => {
        const { clientX: x, clientY: y, target } = e;
        withMessageMenu((m) =>
          m.openMessageMenuAt({
            opts: st.options,
            x,
            y,
            target,
            signal: st.disposable.signal,
            markUnread: api.markUnreadFrom,
          }),
        );
      },
      { signal: st.disposable.signal },
    );
    // The hover bar's "..." button: one delegated listener, so the menu is
    // owned by the list's signal and survives its row being patched or rebuilt.
    // A click on "..." while its menu is open closes it (the outside mousedown
    // already has), so the open state is noted at pointerdown, before that.
    let moreWasOpen = false;
    st.contentContainer.addEventListener(
      "pointerdown",
      (e) => {
        moreWasOpen = moreButtonOf(e.target)?.getAttribute("aria-expanded") === "true";
      },
      { signal: st.disposable.signal },
    );
    st.contentContainer.addEventListener(
      "click",
      (e) => {
        // Reset on every click, so a press on More released elsewhere cannot
        // leave the flag set; a keyboard click (detail 0) had no pointerdown.
        const skip = moreWasOpen && e.detail > 0;
        moreWasOpen = false;
        const button = moreButtonOf(e.target);
        if (button === null || skip) return;
        const testId = button.dataset["testid"] ?? "";
        withMessageMenu((m) => {
          // The first open waits for the menu module; a patch or scroll in that
          // time replaces the button, so anchor on the live one, or open nothing.
          const live = button.isConnected
            ? button
            : (st.contentContainer?.querySelector<HTMLElement>(`[data-testid="${testId}"]`) ??
              null);
          if (live === null) return;
          m.openMessageMenuFromButton({
            opts: st.options,
            button: live,
            signal: st.disposable.signal,
            markUnread: api.markUnreadFrom,
          });
        });
      },
      { signal: st.disposable.signal },
    );
    // Shift pressed before the pointer arrived still reveals Pin and Delete.
    st.contentContainer.addEventListener(
      "mouseover",
      (e) => {
        st.root?.classList.toggle("shift-held", e.shiftKey);
      },
      { signal: st.disposable.signal },
    );
    // Alt+click on a message row marks it unread (the lazy module decides which
    // targets count: not a link, button, image or text field).
    st.contentContainer.addEventListener(
      "click",
      (e) => {
        if (!e.altKey || !readPointerEnabled()) return;
        const { target } = e;
        withMessageMenu((m) =>
          m.markUnreadAt({ opts: st.options, target, markUnread: api.markUnreadFrom }),
        );
      },
      { signal: st.disposable.signal },
    );

    // Focus returning with the bottom already in view counts as seeing it.
    // Owned by disposable.signal so destroy() releases it.
    window.addEventListener("focus", () => api.markReadIfSeen(), { signal: st.disposable.signal });

    // Shift reveals the hover bar's Pin and Delete: one pair of
    // window listeners toggles a class on the list root, and CSS shows the
    // extra buttons. A lost keyup (focus left the window, the tab was hidden)
    // would leave them out, so both of those reset it. Owned by disposable.signal.
    const setShiftHeld = (held: boolean): void => {
      st.root?.classList.toggle("shift-held", held);
    };
    const trackShift = (e: KeyboardEvent): void => {
      // Releasing Shift hides the Shift-only buttons: if one holds focus, hand
      // it to the row's "..." first so it does not drop to <body>.
      if (e.type === "keyup" && !e.shiftKey) {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active.classList.contains("msg-shift-only")) {
          active
            .closest(".msg-actions-bar")
            ?.querySelector<HTMLElement>("[data-testid^='msg-more-']")
            ?.focus();
        }
      }
      setShiftHeld(e.shiftKey);
    };
    window.addEventListener("keydown", trackShift, { signal: st.disposable.signal });
    window.addEventListener("keyup", trackShift, { signal: st.disposable.signal });
    window.addEventListener("blur", () => setShiftHeld(false), { signal: st.disposable.signal });
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.hidden) setShiftHeld(false);
      },
      { signal: st.disposable.signal },
    );

    // Watch for height changes in rendered items (images loading, embeds expanding).
    // A plain re-measure runs inside the observer callback, which comes after
    // layout and before paint: deferring it to the next frame painted one frame
    // with the rows below a grown image or card shifted, then snapped them back.
    // A pass that may build rows (a resized viewport, a jump settling, the NEW
    // divider still to place) resizes the observed content itself, so it waits
    // for the next frame instead of looping the observer.
    const resizePass = (): void => {
      if (st.root === null || st.contentContainer === null) return;
      // The text estimates wrap at the list's width: when it changes, the
      // rows nothing has measured yet are estimated again (below).
      const width = st.root.clientWidth;
      // A list mounted hidden learns its width here, even at the default one,
      // so the rows an earlier visit measured seed it.
      const widthChanged = width > 0 && width !== st.estimateWidth;
      if (widthChanged) st.estimateWidth = width;

      // A viewport that grew (pane enlarged, window maximized) needs more
      // rows than the window holds, with no scroll event to say so.
      const viewportHeight = st.root.clientHeight;
      if (viewportHeight !== st.lastViewportHeight) api.renderWindow();

      const jumpIdx = api.activeJumpIndex();
      if (jumpIdx !== -1) {
        if (widthChanged) api.reseedUnmeasured();
        api.measureRendered();
        api.updateSpacers();
        api.centreOnIndex(jumpIdx);
        return;
      }

      // Where the reader was before the content changed size: a row near the
      // bottom that grew past the threshold has already moved the bottom away
      // by the time this runs, which must not unpin a reader who was at it.
      const atBottom = api.isNearBottom() || st.bottomGapBeforeResize < SCROLL_BOTTOM_THRESHOLD;

      // Capture anchor: the first item that starts in view, and its offset
      // from the viewport top. Not the item straddling the top edge: growth
      // inside it (an image box settling below its header) would then move
      // every row the reader is looking at.
      const { scrollTop, clientHeight } = readMetrics(st.root);
      let anchorIdx = api.offsetToIndex(scrollTop);
      if (
        api.offsetBefore(anchorIdx) < scrollTop &&
        anchorIdx + 1 < st.renderedEnd &&
        api.offsetBefore(anchorIdx + 1) < scrollTop + clientHeight
      ) {
        anchorIdx++;
      }
      const anchorOffset = scrollTop - api.offsetBefore(anchorIdx);

      // The anchor above was read against the old estimates; the restore
      // below reads the new ones, so the reading position holds.
      if (widthChanged) api.reseedUnmeasured();

      // Re-measure rendered elements
      api.measureRendered();

      // Update spacer heights with new measurements
      api.updateSpacers();

      // Restore scroll position using anchor
      if (atBottom) {
        // A list mounted while hidden still owes the reader its NEW divider.
        if (!api.openAtDividerIfReady()) api.scrollToBottom();
      } else {
        api.setScrollTop(api.offsetBefore(anchorIdx) + anchorOffset);
      }
      st.bottomGapBeforeResize = api.bottomGap();
      api.keepEditorCaretInView();
    };
    st.resizeObserver = new ResizeObserver(() => {
      if (st.root === null || st.contentContainer === null) return;
      // Hidden (the call grid has the chat column, display: none): nothing is
      // laid out, so there is nothing to measure, and the position from before
      // it was hidden is what showing it again restores.
      if (st.root.clientHeight === 0) return;
      const buildsRows =
        st.root.clientHeight !== st.lastViewportHeight ||
        api.activeJumpIndex() !== -1 ||
        st.openAtDividerPending;
      if (!buildsRows) {
        if (st.resizeRafId === 0) resizePass();
        return;
      }
      if (st.resizeRafId !== 0) return;
      st.resizeRafId = requestAnimationFrame(() => {
        st.resizeRafId = 0;
        if (st.root !== null && st.root.clientHeight > 0) resizePass();
      });
    });
    st.resizeObserver.observe(st.contentContainer);
    st.resizeObserver.observe(st.root);

    parentContainer.appendChild(st.region);
    // Estimate at the real width from the first render, so rows an earlier
    // visit measured seed it rather than a reseed after the observer fires.
    if (st.root.clientWidth > 0) st.estimateWidth = st.root.clientWidth;

    st.openAtDividerPending = st.unreadOnOpen > 0;
    api.renderAll();
    // Fetch the inline editor chunk once the list is up, so ArrowUp opens at once.
    setOwnedTimeout(st.disposable.signal, preloadInlineEdit, 0);
    api.updateJumpToPresentPill();
    const openedAtDivider = api.openAtDividerIfReady();
    api.updateUnreadBar();
    // A deferred divider still moves the view later, so only the bottom
    // scrolls are skipped when the open already landed on it.
    if (!openedAtDivider) api.scrollToBottom();
    setLiveTailInView(st.options.channelId, api.isNearBottom());
    const initialScrollRaf = requestAnimationFrame(() => {
      if (!openedAtDivider) api.scrollToBottom();
    });
    st.disposable.signal.addEventListener("abort", () => cancelAnimationFrame(initialScrollRaf));

    // A full-ready resync refetches a detached window around this (P2-T4).
    st.unsubscribers.push(
      registerReadingAnchor((channelId) => {
        if (channelId !== st.options.channelId) return null;
        const idx = api.topMessageIndex();
        return idx === -1 ? null : (st.virtualItems[idx] as VirtualItemMessage).message.id;
      }),
    );

    st.unsubscribers.push(
      onMarkUnreadFailed((channelId) => {
        if (channelId === st.options.channelId) api.revertMarkUnread();
      }),
    );
    st.unsubscribers.push(
      channelsStore.subscribeSelector(
        (s) => s.channels.get(st.options.channelId)?.unreadCount,
        () => {
          if (st.markedUnread && st.newDividerAnchorId !== null) {
            api.refreshUnreadFromChannel(st.newDividerAnchorId);
          }
        },
      ),
    );
    st.unsubscribers.push(
      messagesStore.subscribeSelector(
        // Scoped to the mounted channel so updates to OTHER channels (their
        // array references are unchanged) never trigger a re-render here.
        (s) => s.messagesByChannel.get(st.options.channelId),
        () => {
          // Optimistic rows (id 0) sit at the tail; live rows land before them.
          const prevLast = st.allMessages.findLast((m) => m.id > 0)?.id ?? 0;
          // The loaded-and-empty welcome state was on screen, so a first row
          // is a live arrival and not the first page landing.
          const firstLive = prevLast === 0 && st.loadedEmptyShown;
          if (
            api.ownSends(getChannelMessages(st.options.channelId)) > api.ownSends(st.allMessages)
          ) {
            st.followOwnSendUntil = performance.now() + FOLLOW_OWN_SEND_MS;
          }
          const wasBottom = api.isNearBottom() || api.followOwnSend();
          if (!api.patchRows()) {
            api.renderAll();
          }
          if (api.followOwnSend()) st.followOwnSendUntil = 0;
          // Only an append counts: a window swap drops the previous last row.
          const appended =
            firstLive || (prevLast > 0 && st.allMessages.some((m) => m.id === prevLast));
          if (!wasBottom && appended && !st.loadingNewer) {
            // Older ids (a prepend) and the reader's own rows never count.
            for (const m of st.allMessages) {
              if (m.id > prevLast && m.user.id !== st.options.currentUserId) st.newBelowCount++;
            }
          }
          // The page kept the reader in place: the live-tail flag now describes
          // that spot, not the one before the page landed.
          if (st.loadingNewer) setLiveTailInView(st.options.channelId, api.isNearBottom());
          api.updateScrollToBottomBtn();
          api.settleUnreadNav();
          if (
            wasBottom &&
            appended &&
            !st.loadingNewer &&
            st.allMessages.some((m) => m.id > prevLast)
          ) {
            api.markLiveArrivalSeen();
          }
        },
      ),
    );

    // Re-render the (empty) region when the first-page fetch transitions
    // between loading / error / idle. Shown rows are left alone: a revisit's
    // refetch finishing must not rebuild them, and any change the
    // fetch made reaches the messagesByChannel subscriber above. A NEW divider
    // still waiting for that fetch is patched in on its own (R2).
    st.unsubscribers.push(
      messagesStore.subscribeSelector(
        (s) => s.historyLoadState.get(st.options.channelId),
        () => {
          if (st.virtualItems.length === 0 || (st.newDividerDeferred && !api.patchRows()))
            api.renderAll();
          api.settleUnreadNav();
        },
      ),
    );

    st.unsubscribers.push(
      messagesStore.subscribeSelector(
        (s) => s.olderLoadFailed?.has(st.options.channelId) ?? false,
        () => api.updateOlderFailedRow(),
      ),
    );

    // Show/hide the pill as the window detaches from (and reattaches to) the
    // live tail. No re-render — only the pill's visibility changes.
    st.unsubscribers.push(
      messagesStore.subscribeSelector(
        (s) => s.detachedChannels.has(st.options.channelId),
        () => {
          api.updateJumpToPresentPill();
          api.updateUnreadBar();
          // A tail reload that changed no rows reattaches without a messages
          // update, so the reader's pending own send follows here instead.
          if (api.followOwnSend()) {
            st.followOwnSendUntil = 0;
            api.scrollToBottom();
            api.updateScrollToBottomBtn();
          }
        },
      ),
    );

    // A membership, role or profile (rename/avatar) change repaints only the
    // author identity of the rendered rows that changed, not the whole list.
    // The store bumps roleRevision on every such mutation, so
    // selecting the counter avoids touching a role map per presence update.
    // The signed-in user's own role change can also change their per-row
    // affordances (pin/delete), so that case — and only it — falls back to a
    // rebuild.
    st.lastCanManageMessages = canManageMessages();
    // A block or an unblock folds or unfolds the author's rows in place.
    let prevBlocked = blockedUsers();
    st.unsubscribers.push(
      blocksStore.subscribeSelector(
        (s) => [...s.blockedByMe].toSorted((x, y) => x - y).join(","),
        () => {
          const now = blockedUsers();
          // A run of someone blocked again starts folded, whatever was shown before.
          for (const m of st.allMessages) {
            if (now.has(m.user.id) && !prevBlocked.has(m.user.id)) st.shownBlocked.delete(m.id);
          }
          prevBlocked = now;
          api.renderAll();
        },
      ),
    );
    st.unsubscribers.push(
      membersStore.subscribeSelector(
        (s) => s.roleRevision ?? 0,
        () => {
          const canManage = canManageMessages();
          if (canManage !== st.lastCanManageMessages) {
            st.lastCanManageMessages = canManage;
            api.renderAll();
          } else {
            api.refreshAuthorRows();
          }
        },
      ),
    );

    // A role rename, recolour or deletion changes how role pills read.
    st.unsubscribers.push(
      channelsStore.subscribeSelector(
        (s) => s.roles,
        () => api.refreshAuthorRows(),
      ),
    );

    // The server's per-channel verdicts change on a role or override edit.
    // Delete and pin are built into each row, so a change there rebuilds; react
    // only flips the lock on the rendered controls.
    st.unsubscribers.push(
      channelsStore.subscribeSelector(
        (s) => {
          const ch = s.channels.get(authorityChannelId(st.options.channelId));
          return `${String(ch?.canDeleteOthers)}|${String(ch?.canPin)}`;
        },
        () => api.renderAll(),
      ),
      channelsStore.subscribeSelector(
        (s) => s.channels.get(authorityChannelId(st.options.channelId))?.canReact,
        () => {
          if (st.contentContainer !== null)
            refreshReactionLocks(st.contentContainer, st.options.channelId);
        },
      ),
    );

    // A timeout starting or ending toggles the reaction controls' lock in place;
    // no row is rebuilt, so video, spoilers and focus survive.
    st.unsubscribers.push(
      safetyStore.subscribeSelector(
        (s) => s.timeout,
        () => {
          if (st.contentContainer !== null)
            refreshReactionLocks(st.contentContainer, st.options.channelId);
        },
      ),
    );

    // A thread's count, name or archive state changes far more often than its
    // starter row is rebuilt: repaint the chips on screen in place.
    const repaintThreadChips = (): void => {
      if (st.contentContainer === null) return;
      refreshThreadChips(st.contentContainer, {
        messages: getChannelMessages(st.options.channelId),
        onOpen: st.options.onOpenThread,
        signal: st.disposable.signal,
      });
    };
    st.unsubscribers.push(
      threadsStore.subscribeSelector((s) => s.byId, repaintThreadChips),
      threadsStore.subscribeSelector((s) => s.byStarter, repaintThreadChips),
      threadsStore.subscribeSelector((s) => s.deleted, repaintThreadChips),
    );

    // Delete and reactions are disabled while the socket is down; flip
    // the gates on the rendered controls in place, without a rebuild.
    st.unsubscribers.push(
      uiStore.subscribeSelector(
        (s) => s.connectionStatus,
        () => {
          if (st.contentContainer === null) return;
          refreshConnectionControls(st.contentContainer);
          refreshReactionLocks(st.contentContainer, st.options.channelId);
        },
      ),
    );

    // "Today at …" becomes "Yesterday at …" when the local day turns, so the
    // rendered rows' relative times are relabelled in place once a day; rows
    // outside the window get fresh text when renderWindow builds them. Owned
    // by disposable.signal: destroy() releases the pending timer.
    atEachMidnight(st.disposable.signal, api.relabelRenderedTimes);

    // A relative <t:…:R> timestamp ("in 5 minutes") drifts while the channel
    // sits open, so the rendered ones are rewritten once a minute.
    const relabelRelative = (): void => {
      setOwnedTimeout(
        st.disposable.signal,
        () => {
          if (st.contentContainer?.querySelector('time.md-timestamp[data-style="R"]')) {
            relabelInlineTimestamps(st.contentContainer);
          }
          relabelRelative();
        },
        RELATIVE_TIMESTAMP_REFRESH_MS,
      );
    };
    relabelRelative();

    // Switching the 12h/24h clock preference relabels the rendered rows in
    // place, the same way midnight does. Owned by disposable.signal, so the
    // listener dies with the component.
    onPrefChange(["timeFormat"], api.relabelRenderedTimes, st.disposable.signal);
    // Role Colors on/off recolours the names already drawn. formatting.ts
    // refreshes its cached flag from the same event first (it registered
    // earlier), so the rows are repainted from the new value.
    onPrefChange(["roleColors"], api.refreshAuthorRows, st.disposable.signal);
  }

  function destroy(): void {
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
  };
}
