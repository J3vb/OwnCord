// The `ready` slices of the channel handlers: the channel snapshot, the active
// channel, the read pointer capabilities, and the emoji and sticker loads.
// Plain functions; wsHandlers.ts re-exports them for lib/dispatcher.ts.
import {
  channelsStore,
  setChannels,
  setRoles,
  setCategories,
  setActiveChannel,
  firstTextInSidebarOrder,
  readyChannelMap,
} from "../../stores/channels.store";
import { setMembers } from "../../stores/members.store";
import { emojiStore, setCustomEmoji } from "../../stores/emoji.store";
import { setStickers, stickersStore } from "../../stores/stickers.store";
import { uiStore } from "../../stores/ui.store";
import { loadLastChannel } from "../../lib/prefs/lastChannel";
import {
  forgetPendingMarkUnread,
  isChannelAway,
  markChannelRead,
  markChannelReadSeen,
} from "../../lib/readState";
import {
  applyReadyCapabilities,
  readPointerEnabled,
  stickersEnabled,
} from "../../lib/net/serverCapabilities";
import type { DispatchApi, Payload } from "../connection/dispatchContext";
import { log } from "../connection/dispatchContext";

/** The channel/role/member snapshot of `ready`. */
export function applyReadyChannels(payload: Payload<"ready">): void {
  setChannels(payload.channels);
  // Managers only; absent for everyone else and for older servers, which leaves
  // the list empty so the groups come from the channels alone.
  setCategories(payload.categories ?? []);
  setRoles(payload.roles ?? []);
  setMembers(payload.members);
}

/**
 * The active-channel slice of `ready`: auto-select, or clear a channel that is
 * gone. Returns the channel markReadyActiveChannelRead should mark read.
 */
export function applyReadyActiveChannel(payload: Payload<"ready">): number | null {
  // Auto-select the first text channel if none is active; clear it when
  // the channel this session was viewing is gone from the fresh snapshot
  // (deleted, or a DM closed elsewhere while this client was offline) so
  // the activeChannelId subscriber actually fires and tears down the
  // stale message list/composer instead of leaving them mounted against
  // a channel the server no longer recognizes. Checked against the raw
  // payload (not the synthesized channelsStore row) so a still-open DM
  // that was never locally synthesized this session isn't wrongly
  // cleared.
  const currentActive = channelsStore.select((s) => s.activeChannelId);
  // Set only when the branch below clears a channel that was active
  // before this ready — distinct from "no channel was active", which
  // must NOT mark-read whatever the auto-select branch just picked.
  let activeChannelCleared = false;
  // A content view leaves no channel active on purpose; auto-selecting
  // one would close it.
  const viewOpen = uiStore.getState().activeView !== null;
  if (currentActive === null && !viewOpen && payload.channels.length > 0) {
    // Restore where the user left off rather than always jumping to the
    // first text channel. The stored id is a hint — ignore it when the channel
    // is gone or no longer visible. Selecting is not viewing, so neither this
    // nor the fallback clears the badge (clearUnread: false); the channel
    // clears only when actually mounted.
    const remembered = loadLastChannel();
    const rememberedVisible =
      remembered !== null && payload.channels.some((ch) => ch.id === remembered);
    if (rememberedVisible) {
      setActiveChannel(remembered, { clearUnread: false });
    } else {
      const firstText = firstTextInSidebarOrder(readyChannelMap(payload.channels));
      if (firstText !== undefined) {
        setActiveChannel(firstText.id, { clearUnread: false });
      }
    }
  } else if (currentActive !== null) {
    const stillPresent =
      payload.channels.some((ch) => ch.id === currentActive) ||
      (payload.dm_channels ?? []).some((dm) => dm.channel_id === currentActive);
    if (!stillPresent) {
      setActiveChannel(null);
      activeChannelCleared = true;
    }
  }
  return activeChannelCleared ? null : currentActive;
}

/**
 * Mark the channel the user was already reading as read after `ready`.
 *
 * The server's read_states go stale while a channel stays focused
 * (channel_focus is sent once per mount, mark_read only from the context
 * menu), so a full-ready resync restates non-zero unread/mention counts for
 * the very channel the user is reading. Mark it read: this advances the
 * server read state and clears the local badges, for server channels and DMs
 * alike. Skipped on first connect (nothing was active yet) and when
 * applyReadyActiveChannel just cleared a channel that's gone — it returns
 * null for both.
 *
 * Only while the reader is actually watching — a focused window whose
 * loaded window is not detached. An unfocused or background resync restates
 * the messages missed while away, and clearing them here would silently mark
 * those unseen messages read (isChannelAway, lib/readState.ts).
 */
export function markReadyActiveChannelRead(currentActive: number | null): void {
  // A forum holds no messages, so there is nothing in it to mark read.
  if (
    currentActive !== null &&
    channelsStore.getState().channels.get(currentActive)?.type === "forum"
  ) {
    return;
  }
  if (currentActive !== null && !isChannelAway(currentActive)) {
    // With a read pointer the ready-time mark is only what the reader saw, not
    // "everything": a resync that restated messages missed while the list was
    // not on screen must not mark them read. Without one, as it always was.
    if (readPointerEnabled()) markChannelReadSeen(currentActive);
    else markChannelRead(currentActive);
  }
}

/**
 * The capabilities slice of a full `ready`, applied first. A new `ready`
 * restates every pointer, so a Mark Unread still waiting for its answer from
 * the previous connection is forgotten rather than restored or toasted against
 * the new one.
 */
export function applyReadyReadPointer(payload: Payload<"ready">): void {
  applyReadyCapabilities(payload.capabilities);
  forgetPendingMarkUnread();
}

/** The custom-emoji slice of `ready`. */
export function applyReadyEmoji(api: DispatchApi | undefined): void {
  // Custom emoji are not in the ready payload (they are server-wide and
  // change rarely, so they do not belong in the per-session dump). Load
  // them once here; `emoji_update` keeps them fresh from then on. A
  // failure is non-fatal — unresolved shortcodes stay plain text.
  //
  // Snapshot the revision emojiStore was at right before issuing
  // this fetch, mirroring the blockedByMeRev guard above. The GET
  // travels over a separate HTTP connection while an `emoji_update` can
  // arrive on the already-open socket — if one lands (bumping the
  // revision) while this GET is in flight, setCustomEmoji sees the
  // mismatch and skips applying this reply instead of clobbering the
  // fresher broadcast with a stale full-set snapshot.
  if (api?.listEmoji !== undefined) {
    const emojiRevAtFetch = emojiStore.getState().rev ?? 0;
    api
      .listEmoji()
      .then((list) => setCustomEmoji(list, emojiRevAtFetch))
      .catch((err) => log.warn("Failed to load custom emoji", { error: String(err) }));
  }
}

/**
 * The custom-sticker slice of `ready`. Like emoji, the set is not in
 * the ready payload: load it once here, only on a server that advertises the
 * `stickers` capability (applyReadyCapabilities has already run), and let
 * `sticker_update` keep it fresh. A failure is non-fatal: the picker shows its
 * empty state until the next broadcast.
 *
 * The revision snapshot mirrors the emoji one: a `sticker_update` that lands
 * while this GET is in flight bumps it, and the stale reply is then dropped.
 */
export function applyReadyStickers(api: DispatchApi | undefined): void {
  if (!stickersEnabled() || api?.listStickers === undefined) return;
  const revAtFetch = stickersStore.getState().rev;
  api
    .listStickers()
    .then((list) => setStickers(list, revAtFetch))
    .catch((err) => log.warn("Failed to load custom stickers", { error: String(err) }));
}
