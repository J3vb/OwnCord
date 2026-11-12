/**
 * MessageJump — the one implementation behind every "jump to this message"
 * affordance: search results, the pinned panel, reply bars, permalink chips in
 * chat, and `owncord://message/…` links opened from the OS.
 *
 * The interesting case is a target outside the loaded window. Rather than
 * telling the user "not in loaded history" and stopping there (which is what
 * the search and pinned panels used to do), the jumper fetches the server's
 * around-window, swaps it into the store, and scrolls to the target. That
 * leaves the channel *detached* from the live tail, which the MessageList
 * signals with its "Jump to Present" pill.
 */

import type { ApiClient } from "@lib/api";
import { createLogger } from "@lib/logger";
import { ApiClientError } from "@lib/api";
import { showToast } from "@lib/ui/toast";
import { findChannelById, navigateToChannel } from "@lib/nav/channelNavigation";
import {
  setAroundMessages,
  hasMessageLoaded,
  isChannelLoaded,
  isWindowDetached,
  getChannelMessages,
} from "@stores/messages.store";
import {
  newestSentId,
  recoverRefusedTail,
  withLoadJournal,
} from "../../features/messaging/historyFetch";
import { NSFW_ACKNOWLEDGEMENT_REQUIRED } from "../../features/content-consent/nsfw";
import type { ChannelController } from "./ChannelController";
import { messagingText } from "../../i18n/messaging";

const log = createLogger("message-jump");

/** Window size requested when a jump target is not in the loaded page. */
const AROUND_WINDOW = 50;

export interface MessageJumpOptions {
  readonly api: ApiClient;
  readonly getChannelCtrl: () => ChannelController | null;
  /**
   * Wait for the channel switch / re-render to hit the DOM. Defaults to a
   * requestAnimationFrame; tests inject a resolved promise instead.
   */
  readonly nextFrame?: () => Promise<void>;
}

export interface MessageJumper {
  /**
   * Open `channelId` if needed and scroll to `messageId`, fetching the
   * around-window when the message is not loaded. Resolves true when the row
   * was actually reached.
   */
  jumpTo(channelId: number, messageId: number): Promise<boolean>;
}

function defaultNextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

/** A jump that is known to be pointless: say why, quietly. */
function refuseJump(channelId: number, messageId: number): boolean {
  // A permalink to a channel this user cannot see must degrade quietly
  // rather than blank the chat area on an unknown id.
  if (findChannelById(channelId) === null) {
    showToast(messagingText("jump.channelUnavailable"), "info");
    return true;
  }
  // The store keeps a deleted message as a tombstone, so a jump to one is
  // known to be pointless: the list does not draw it and the around fetch
  // would 404.
  if (getChannelMessages(channelId).some((m) => m.id === messageId && m.deleted)) {
    showToast(messagingText("jump.gone"), "info");
    return true;
  }
  return false;
}

function reportWindowFetchFailure(err: unknown, channelId: number, messageId: number): void {
  // The channel's NSFW gate is showing and says why.
  if (err instanceof ApiClientError && err.code === NSFW_ACKNOWLEDGEMENT_REQUIRED) return;
  if (err instanceof ApiClientError && err.status === 404) {
    showToast(messagingText("jump.gone"), "info");
    return;
  }
  log.error("Failed to fetch the message window", { channelId, messageId, error: String(err) });
  showToast(messagingText("jump.failed"), "error");
}

export function createMessageJumper(opts: MessageJumpOptions): MessageJumper {
  const nextFrame = opts.nextFrame ?? defaultNextFrame;

  // Generation counter: every jumpTo() call claims the latest generation at
  // entry. Concurrent jumps to the same channel are not serialized, so
  // without this an older request whose response lands after a newer jump
  // already applied its window would silently overwrite it (last network
  // reply wins instead of last click).
  let jumpGen = 0;

  /** Scroll the mounted list to a message, if that list is showing `channelId`. */
  function scrollIfMounted(channelId: number, messageId: number): boolean {
    const ctrl = opts.getChannelCtrl();
    if (ctrl === null || ctrl.messageList === null) return false;
    if (ctrl.currentChannelId !== channelId) return false;
    return ctrl.messageList.scrollToMessage(messageId);
  }

  /** Swap the fetched around-window in, unless the jump went stale meanwhile. */
  function installAroundWindow(
    gen: number,
    channelId: number,
    resp: Awaited<ReturnType<ApiClient["getMessagesAround"]>>,
  ): boolean {
    // A newer jump was fired (and possibly already resolved) while this
    // fetch was in flight — its response landing now must not clobber the
    // window the newer jump already applied.
    if (gen !== jumpGen) return false;
    // The user left the channel while the fetch was in flight. The switch
    // already dropped its loaded flag, so writing the window now would mark
    // it loaded and detached, and the next visit would open on this old
    // window instead of the live tail.
    if (opts.getChannelCtrl()?.currentChannelId !== channelId) return false;
    const wasDetached = isWindowDetached(channelId);
    setAroundMessages(channelId, resp.messages, resp.has_more_before, resp.has_more_after);
    // A live message refused while the window was detached is in neither the
    // window nor the list when this one reaches the newest message.
    // A recovery that lands after a channel switch only merges by id into
    // that channel's cached window.
    if (wasDetached && !isWindowDetached(channelId)) {
      void recoverRefusedTail(opts.api, channelId, newestSentId(channelId));
    }
    return true;
  }

  async function jumpTo(channelId: number, messageId: number): Promise<boolean> {
    const gen = ++jumpGen;

    if (refuseJump(channelId, messageId)) return false;

    const ctrl = opts.getChannelCtrl();
    if (ctrl === null) return false;

    if (ctrl.currentChannelId !== channelId) {
      navigateToChannel(channelId);
      // The channel switch mounts a fresh MessageList and kicks off its
      // history fetch; give it a frame before asking it to scroll.
      await nextFrame();
    }

    // Only a loaded window is stable. Before the channel's mount-time history
    // fetch lands, live rows can already show the target, but that fetch then
    // re-renders the list at the tail and loses it — so take the around-window
    // instead, which marks the channel loaded and makes that fetch stand down.
    if (isChannelLoaded(channelId) && scrollIfMounted(channelId, messageId)) return true;

    // Not in the loaded window (or the fresh channel is still fetching) —
    // replace the window with one centred on the target.
    try {
      // Held so an edit, delete or pin that arrives while the window is in
      // flight is replayed onto it instead of undone.
      const installed = await withLoadJournal(channelId, async () => {
        const resp = await opts.api.getMessagesAround(channelId, messageId, {
          limit: AROUND_WINDOW,
        });
        return installAroundWindow(gen, channelId, resp);
      });
      if (!installed) return false;
    } catch (err) {
      reportWindowFetchFailure(err, channelId, messageId);
      return false;
    }

    if (!hasMessageLoaded(channelId, messageId)) {
      // The server answered but the centre is not in the window — nothing to
      // scroll to, and silently landing elsewhere would be worse.
      showToast(messagingText("jump.failed"), "error");
      return false;
    }

    // The store update re-renders the list; scroll on the next frame.
    await nextFrame();
    if (gen !== jumpGen) return false;
    if (scrollIfMounted(channelId, messageId)) return true;

    log.warn("Around-window loaded but the row did not render", { channelId, messageId });
    return false;
  }

  return { jumpTo };
}
