/**
 * The person rows of a video tile's menu: Profile, Message and the
 * voice roster's moderation section, wired to the same openers the sidebar
 * and member list use.
 */

import { buildVoiceModOptions } from "@components/ChannelSidebar";
import { Disposable } from "@lib/disposable";
import type { VideoGridCallbacks } from "@components/VideoGrid";
import { channelsStore } from "@stores/channels.store";
import { voiceStore } from "@stores/voice.store";
import type { WsClient } from "@lib/ws";
import { openUserProfilePopup } from "../../features/profiles/openUserProfilePopup";
import { createVoiceModerationCallbacks } from "./VoiceCallbacks";

export function createTileMenuActions(
  ws: WsClient,
  messageUser: (userId: number) => void,
  showChat: () => void,
): NonNullable<VideoGridCallbacks["tileMenu"]> & { readonly destroy: () => void } {
  const moderate = createVoiceModerationCallbacks(ws);
  // The page's lifetime: a profile still loading or open when the page goes
  // (logout, server switch) is dropped with it.
  const owner = new Disposable();
  let closeProfile: (() => void) | null = null;
  // Message opens the DM in the chat, out of the call view.
  const message = (userId: number): void => {
    showChat();
    messageUser(userId);
  };
  return {
    onProfile: (userId, x, y) => {
      closeProfile = openUserProfilePopup({
        userId,
        anchorX: x,
        anchorY: y,
        signal: owner.signal,
        callbacks: { onMessage: message },
      });
    },
    onMessage: message,
    // Only in a server voice channel: a DM call has no voice moderation.
    moderation: (userId) => {
      const voice = voiceStore.getState();
      const channelId = voice.currentChannelId;
      if (channelId === null) return undefined;
      if (channelsStore.getState().channels.get(channelId)?.type !== "voice") return undefined;
      const user = voice.voiceUsers.get(channelId)?.get(userId);
      return user === undefined ? undefined : buildVoiceModOptions(channelId, user, moderate);
    },
    destroy: () => {
      owner.destroy();
      closeProfile?.();
      closeProfile = null;
    },
  };
}
