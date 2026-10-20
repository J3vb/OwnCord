/**
 * callChat — the call view's chat. The voice channel's own chat is the chat
 * column with that channel active; the grid sits beside it (WP 6.1b). This owns
 * the two decisions around that: opening the call view selects the voice
 * channel first, and the split holds only while the active channel is the one
 * the user is in a call on. Its one store write is navigateToChannel's.
 */

import { channelsStore } from "@stores/channels.store";
import { voiceStore } from "@stores/voice.store";
import { Disposable } from "@lib/disposable";
import { navigateToChannel } from "@lib/channel-navigation";
import type { VideoModeController } from "./VideoModeController";

export interface CallChatOptions {
  readonly videoModeCtrl: Pick<VideoModeController, "openCall" | "setChatBeside" | "isVideoMode">;
}

export interface CallChat {
  /** Open the call view; a guild call selects its voice channel first. */
  openVoiceCall(): void;
  destroy(): void;
}

/** The guild voice channel the user is in a call on, else null (no call, or a DM call). */
function callVoiceChannelId(): number | null {
  const id = voiceStore.getState().currentChannelId;
  if (id === null) return null;
  return channelsStore.getState().channels.get(id)?.type === "voice" ? id : null;
}

export function createCallChat(opts: CallChatOptions): CallChat {
  const owner = new Disposable();
  let lastCallChannel = callVoiceChannelId();

  function sync(): void {
    const call = callVoiceChannelId();
    const previous = lastCallChannel;
    lastCallChannel = call;
    const active = channelsStore.getState().activeChannelId;
    // The call moved A -> B under the chat of A: follow, so A's chat is never
    // left beside B's grid. Leaving (B null) keeps the chat and drops the split.
    if (call !== null && previous !== null && call !== previous && active === previous) {
      if (opts.videoModeCtrl.isVideoMode()) {
        navigateToChannel(call);
        return;
      }
    }
    opts.videoModeCtrl.setChatBeside(call !== null && active === call);
  }

  owner.onStoreChange(
    channelsStore,
    (s) => s.activeChannelId,
    () => sync(),
  );
  // The call's channel may land in the store after currentChannelId (ready).
  owner.onStoreChange(
    channelsStore,
    (s) => s.channels,
    () => sync(),
  );
  owner.onStoreChange(
    voiceStore,
    (s) => s.currentChannelId,
    () => sync(),
  );
  owner.onStoreChange(
    voiceStore,
    (s) => s.voiceStatus,
    () => sync(),
  );
  sync();

  return {
    openVoiceCall(): void {
      const call = callVoiceChannelId();
      if (call !== null && channelsStore.getState().activeChannelId !== call) {
        navigateToChannel(call);
      }
      // The stores tell subscribers a microtask later; the grid must open
      // already beside the chat.
      sync();
      opts.videoModeCtrl.openCall();
    },
    destroy(): void {
      owner.destroy();
      opts.videoModeCtrl.setChatBeside(false);
    },
  };
}
