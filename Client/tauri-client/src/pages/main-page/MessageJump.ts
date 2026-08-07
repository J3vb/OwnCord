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
import { showToast } from "@lib/toast";
import { findChannelById, navigateToChannel } from "@lib/channel-navigation";
import { setAroundMessages, hasMessageLoaded } from "@stores/messages.store";
import type { ChannelController } from "./ChannelController";

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

  async function jumpTo(channelId: number, messageId: number): Promise<boolean> {
    const gen = ++jumpGen;

    // A permalink to a channel this user cannot see must degrade quietly
    // rather than blank the chat area on an unknown id.
    if (findChannelById(channelId) === null) {
      showToast("That channel isn't available", "info");
      return false;
    }

    const ctrl = opts.getChannelCtrl();
    if (ctrl === null) return false;

    if (ctrl.currentChannelId !== channelId) {
      navigateToChannel(channelId);
      // The channel switch mounts a fresh MessageList and kicks off its
      // history fetch; give it a frame before asking it to scroll.
      await nextFrame();
    }

    if (scrollIfMounted(channelId, messageId)) return true;

    // Not in the loaded window (or the fresh channel is still fetching) —
    // replace the window with one centred on the target.
    try {
      const resp = await opts.api.getMessagesAround(channelId, messageId, {
        limit: AROUND_WINDOW,
      });
      // A newer jump was fired (and possibly already resolved) while this
      // fetch was in flight — its response landing now must not clobber the
      // window the newer jump already applied.
      if (gen !== jumpGen) return false;
      setAroundMessages(channelId, resp.messages, resp.has_more_before, resp.has_more_after);
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 404) {
        showToast("That message no longer exists", "info");
        return false;
      }
      log.error("Failed to fetch the message window", { channelId, messageId, error: String(err) });
      showToast("Couldn't jump to that message", "error");
      return false;
    }

    if (!hasMessageLoaded(channelId, messageId)) {
      // The server answered but the centre is not in the window — nothing to
      // scroll to, and silently landing elsewhere would be worse.
      showToast("Couldn't jump to that message", "error");
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
