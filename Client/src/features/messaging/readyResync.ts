// The message slices of a `ready` frame: resuming queued sends and the refetch after a full resync.
import { authStore } from "../../stores/auth.store";
import { channelsStore } from "../../stores/channels.store";
import {
  setMessages,
  setAroundMessages,
  getChannelMessages,
  invalidateLoadedMessageWindows,
  setChannelLoading,
  setChannelLoadError,
  isWindowDetached,
} from "../../stores/messages.store";
import { recoverAfterReattach } from "./historyFetch";
import { clearReactionUsersCache } from "./reactionUsers";
import { showToast } from "../../lib/ui/toast";
import { connectText } from "../../i18n/connect";
import { readingAnchor } from "./readingAnchor";
import { activatePendingMessages } from "../../lib/pendingMessages";
import type { DispatchApi, Payload, ReconnectClock } from "../connection/dispatchContext";
import { log } from "../connection/dispatchContext";

/** The pending-message slice of `ready`: resume this user's queued sends. */
export function activateReadyPendingMessages(
  api: DispatchApi | undefined,
  payload: Payload<"ready">,
): void {
  const pendingUser = authStore.getState().user;
  if (api?.getConfig && pendingUser) {
    activatePendingMessages(
      { host: api.getConfig().host, userId: pendingUser.id },
      pendingUser,
      payload.capabilities?.message_deduplication === true,
      payload.capabilities?.message_retry_floor_ms,
    );
  }
}

/** The message-window slice of `ready`: after a full-ready resync, refetch the active channel. */
export function applyReadyMessageResync(api: DispatchApi | undefined, clock: ReconnectClock): void {
  // A second (or later) `ready` in this dispatcher's lifetime only ever
  // arrives from a full-ready resync (Server/ws/serve.go: a fresh connect
  // and a full resync are the only paths that send `ready` at all — a
  // successful seq-based replay reconnect does not), and that tier never
  // replays missed chat_message frames. Every channel this session had
  // already loaded would otherwise keep a permanent, silent hole in its
  // history — invalidate them and refetch the one actually on screen.
  if (clock.hasReceivedReadyBefore) {
    // Missed reaction_update frames are not replayed either, so every cached
    // who-reacted list may be stale.
    clearReactionUsersCache();
    const activeAfterReady = channelsStore.select((s) => s.activeChannelId);
    const getMessages = api?.getMessages;
    // Only invalidate when the refetch below can actually happen — api is
    // a Partial<...>, so getMessages may be absent, and there may be no
    // resolvable active channel to refetch. A channel marked not loaded with
    // nothing able to reload it would take live broadcasts onto a window
    // that may have a hole in it.
    if (activeAfterReady !== null && getMessages !== undefined) {
      const getMessagesAround = api?.getMessagesAround;
      // P2-T4: every loaded row stays on screen, and the refetch splices into
      // the window. A reader back in history (a detached window) is refetched
      // around the message at the top of the list, so it stays where it is;
      // with no list showing it, the tail is refetched instead.
      const wasDetached = isWindowDetached(activeAfterReady);
      const noAbort = new AbortController().signal;
      const anchor = wasDetached ? readingAnchor(activeAfterReady) : null;
      // Mark the active channel loading BEFORE invalidating: it records the
      // watermark the splice checks the page against, and a channel with no
      // rows shows the in-region spinner instead of reading as a genuinely
      // empty channel for the whole refetch.
      setChannelLoading(activeAfterReady);
      invalidateLoadedMessageWindows();
      // The user can switch (or the active channel can be cleared)
      // while the fetch is in flight. Writing the page unconditionally would
      // re-add a channel the user already left to loadedChannels with a
      // pre-resync-era page — MessageController.loadMessages then
      // short-circuits on isChannelLoaded() forever, so the hole this whole
      // resync block exists to close becomes permanent instead. Only the
      // channel still on screen when the response lands may accept it.
      const stillActive = (): boolean =>
        channelsStore.select((s) => s.activeChannelId) === activeAfterReady;
      const refetch: Promise<void> =
        anchor !== null && getMessagesAround !== undefined
          ? getMessagesAround(activeAfterReady, anchor, { limit: 50 }).then((resp) => {
              if (!stillActive()) return;
              setAroundMessages(
                activeAfterReady,
                resp.messages,
                resp.has_more_before,
                resp.has_more_after,
                true,
              );
              recoverAfterReattach({ getMessages }, activeAfterReady, wasDetached, noAbort);
            })
          : getMessages(activeAfterReady, { limit: 50 }).then((resp) => {
              if (!stillActive()) return;
              setMessages(
                activeAfterReady,
                resp.messages,
                resp.has_more,
                true,
                readingAnchor(activeAfterReady),
              );
              recoverAfterReattach({ getMessages }, activeAfterReady, wasDetached, noAbort);
            });
      refetch.catch((err: unknown) => {
        log.warn("Failed to reload message history after resync", { error: String(err) });
        // Same staleness guard as above — a rejection for a channel the user
        // already left must not flag it load-errored; that channel's own
        // mount/retry path owns its state now.
        if (!stillActive()) return;
        // An empty channel shows the inline error + Retry (MessageController's
        // loadMessages re-fetches because invalidate cleared "loaded"). Rows
        // still on screen hide that region, so say it with a toast, as the
        // normal load path does; the error detaches them, so "Jump to
        // Present" refetches and no live row lands across the gap.
        setChannelLoadError(activeAfterReady);
        if (getChannelMessages(activeAfterReady).length > 0) {
          showToast(connectText("app.loadHistoryFailed"), "error");
        }
      });
    }
  }
  clock.hasReceivedReadyBefore = true;
}
