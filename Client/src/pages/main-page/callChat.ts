/**
 * callChat — the call view's chat. The voice channel's own chat is the chat
 * column with that channel active; the grid sits beside it. This owns
 * the two decisions around that: opening the call view selects the voice
 * channel first, and the split holds only while the active channel is the one
 * the user is in a call on. It also holds the user's "Hide chat" choice:
 * split-capable means that split condition with the grid open, and the
 * chat sits beside the grid only while capable and the choice is on. Its one
 * store write is navigateToChannel's; the choice is the `callChatOpen` pref.
 */

import { channelsStore } from "@stores/channels.store";
import { voiceStore } from "@stores/voice.store";
import { Disposable } from "@lib/disposable";
import { loadPref, savePref } from "@lib/prefs/preferences";
import { navigateToChannel } from "@lib/channel-navigation";
import type { VideoModeController } from "./VideoModeController";

/** What the header toggle shows: whether it applies, and the user's choice. */
export interface CallChatState {
  readonly capable: boolean;
  readonly open: boolean;
}

export interface CallChatOptions {
  readonly videoModeCtrl: Pick<
    VideoModeController,
    "openCall" | "setChatBeside" | "isVideoMode" | "isGridInWindow"
  >;
  /** Told whenever the capable/open pair changes (and once at creation). */
  readonly onStateChange?: (state: CallChatState) => void;
}

const CALL_CHAT_PREF = "callChatOpen";

export interface CallChat {
  /** Open the call view; a guild call selects its voice channel first. */
  openVoiceCall(): void;
  /** Flip the user's Hide chat / Show chat choice and save it. */
  toggleChat(): void;
  /** Re-read the grid state (it opened or closed). */
  refresh(): void;
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
  let chatOpen = loadPref<boolean>(CALL_CHAT_PREF, true);
  let reported: CallChatState | null = null;
  let syncing = false;

  function sync(): void {
    // The grid's change callback fires from inside setChatBeside.
    if (syncing) return;
    syncing = true;
    try {
      syncOnce();
    } finally {
      syncing = false;
    }
  }

  function syncOnce(): void {
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
    const capable = call !== null && active === call && opts.videoModeCtrl.isGridInWindow();
    opts.videoModeCtrl.setChatBeside(call !== null && active === call && chatOpen);
    if (reported?.capable !== capable || reported.open !== chatOpen) {
      reported = { capable, open: chatOpen };
      opts.onStateChange?.(reported);
    }
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
    toggleChat(): void {
      chatOpen = !chatOpen;
      savePref(CALL_CHAT_PREF, chatOpen);
      sync();
    },
    refresh: sync,
    destroy(): void {
      owner.destroy();
      opts.videoModeCtrl.setChatBeside(false);
    },
  };
}
