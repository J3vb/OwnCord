/**
 * The message list's store and clock subscriptions: what repaints rows in
 * place, rebuilds them or moves the scroll when messages, history state,
 * blocks, roles, threads or the connection change. Unsubscribers collect on
 * `st.unsubscribers`; timers and preference listeners are owned by the list's
 * `disposable.signal`.
 */
import { setOwnedTimeout } from "@lib/dom";
import { messagesStore, getChannelMessages } from "@stores/messages.store";
import { membersStore } from "@stores/members.store";
import { blocksStore } from "@stores/blocks.store";
import { emojiStore } from "@stores/emoji.store";
import type { Message } from "@stores/messages.store";
import { authorityChannelId, threadsStore } from "@stores/threads.store";
import { uiStore } from "@stores/ui.store";
import { channelsStore } from "@stores/channels.store";
import { refreshThreadChips } from "./threadChip";
import { safetyStore } from "../../safety/store";
import { registerReadingAnchor } from "../readingAnchor";
import { refreshConnectionControls } from "./renderers";
import { refreshReactionLocks } from "./reactions";
import { relabelInlineTimestamps } from "../content/contentParser";
import { canManageMessages } from "@lib/permissions";
import { onPhoneLayoutChange } from "@lib/ui/bottomSheet";
import { atEachMidnight } from "@lib/text/formatting";
import { highlightsCurrentUser } from "@lib/text/mentions";
import type { VirtualItemMessage } from "./virtualItems";
import { onMarkUnreadFailed, setLiveTailInView } from "@lib/readState";
import { onPrefChange } from "@lib/prefs/preferences";
import { RELATIVE_TIMESTAMP_REFRESH_MS, FOLLOW_OWN_SEND_MS, blockedUsers } from "./listShared";
import type { ListState, ListApi } from "./listState";

/** A `:shortcode:` in the text or a reaction: the row may hold a custom emoji. */
const SHORTCODE_TOKEN = /:[A-Za-z0-9_]{2,32}:/;
function namesCustomEmoji(m: Message): boolean {
  return SHORTCODE_TOKEN.test(m.content) || m.reactions.some((r) => r.emoji.startsWith(":"));
}

export function subscribeListStores(st: ListState, api: ListApi): void {
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
  /** Rows after `prevLast` landed below a reader scrolled up: count them for the pill. */
  const countArrivalsBelow = (prevLast: number): void => {
    // Older ids (a prepend) and the reader's own rows never count.
    for (const m of st.allMessages) {
      if (m.id <= prevLast || m.user.id === st.options.currentUserId) continue;
      st.newBelowCount++;
      const mentionInfo = {
        mentions: m.mentions,
        mentionsEveryone: m.mentionsEveryone,
        mentionRoles: m.mentionRoles,
      };
      if (!m.deleted && highlightsCurrentUser(m.content, mentionInfo)) {
        st.mentionsBelowCount++;
      }
    }
  };
  /** After the rows are patched or rebuilt: count what landed below a scrolled-up
   *  reader, settle the tail flag and the pill, and mark a live arrival seen. */
  const settleAfterMessages = (prevLast: number, firstLive: boolean, wasBottom: boolean): void => {
    // Only an append counts: a window swap drops the previous last row.
    const appended = firstLive || (prevLast > 0 && st.allMessages.some((m) => m.id === prevLast));
    if (!wasBottom && appended && !st.loadingNewer) countArrivalsBelow(prevLast);
    // The page kept the reader in place: the live-tail flag now describes
    // that spot, not the one before the page landed.
    if (st.loadingNewer) setLiveTailInView(st.options.channelId, api.isNearBottom());
    api.updateScrollToBottomBtn();
    api.settleUnreadNav();
    if (wasBottom && appended && !st.loadingNewer && st.allMessages.some((m) => m.id > prevLast)) {
      api.markLiveArrivalSeen();
    }
  };
  const onChannelMessages = (): void => {
    // Optimistic rows (id 0) sit at the tail; live rows land before them.
    const prevLast = st.allMessages.findLast((m) => m.id > 0)?.id ?? 0;
    // The loaded-and-empty welcome state was on screen, so a first row
    // is a live arrival and not the first page landing.
    const firstLive = prevLast === 0 && st.loadedEmptyShown;
    if (api.ownSends(getChannelMessages(st.options.channelId)) > api.ownSends(st.allMessages)) {
      st.followOwnSendUntil = performance.now() + FOLLOW_OWN_SEND_MS;
    }
    const wasBottom = api.isNearBottom() || api.followOwnSend();
    if (!api.patchRows()) {
      api.renderAll();
    }
    if (api.followOwnSend()) st.followOwnSendUntil = 0;
    settleAfterMessages(prevLast, firstLive, wasBottom);
  };
  st.unsubscribers.push(
    messagesStore.subscribeSelector(
      // Scoped to the mounted channel so updates to OTHER channels (their
      // array references are unchanged) never trigger a re-render here.
      (s) => s.messagesByChannel.get(st.options.channelId),
      () => onChannelMessages(),
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
  // Rows drawn before the server's emoji set arrived (or before an emoji was
  // added or removed) show the shortcode as text. Rebuild them when the set
  // changes, but only if a loaded message could name a custom emoji.
  st.unsubscribers.push(
    emojiStore.subscribeSelector(
      (s) => s.byShortcode,
      () => {
        if (st.allMessages.some(namesCustomEmoji)) api.renderAll();
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
  onPrefChange(["timeFormat", "dateFormat"], api.relabelRenderedTimes, st.disposable.signal);
  // A phone shows the clock alone in the header, so a rotation or resize that
  // crosses the phone layout rewrites the rendered times too.
  onPhoneLayoutChange(api.relabelRenderedTimes, st.disposable.signal);
  // Role Colors on/off recolours the names already drawn. formatting.ts
  // refreshes its cached flag from the same event first (it registered
  // earlier), so the rows are repainted from the new value.
  onPrefChange(["roleColors"], api.refreshAuthorRows, st.disposable.signal);
}
