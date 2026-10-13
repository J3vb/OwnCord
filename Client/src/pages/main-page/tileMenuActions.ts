/**
 * The person rows of a video tile's menu (WP 1B-5): Profile, Message and the
 * voice roster's moderation section, wired to the same openers the sidebar
 * and member list use.
 */

import { buildVoiceModOptions } from "@components/ChannelSidebar";
import type { VideoGridCallbacks } from "@components/VideoGrid";
import { channelsStore } from "@stores/channels.store";
import { voiceStore } from "@stores/voice.store";
import type { WsClient } from "@lib/ws";
import { openUserProfilePopup } from "../../features/profiles/openUserProfilePopup";
import { createVoiceModerationCallbacks } from "./VoiceCallbacks";

export function createTileMenuActions(
  ws: WsClient,
  messageUser: (userId: number) => void,
): NonNullable<VideoGridCallbacks["tileMenu"]> {
  const moderate = createVoiceModerationCallbacks(ws);
  return {
    onProfile: (userId, x, y) => {
      openUserProfilePopup({
        userId,
        anchorX: x,
        anchorY: y,
        callbacks: { onMessage: messageUser },
      });
    },
    onMessage: messageUser,
    // Only in a server voice channel: a DM call has no voice moderation.
    moderation: (userId) => {
      const voice = voiceStore.getState();
      const channelId = voice.currentChannelId;
      if (channelId === null) return undefined;
      if (channelsStore.getState().channels.get(channelId)?.type !== "voice") return undefined;
      const user = voice.voiceUsers.get(channelId)?.get(userId);
      return user === undefined ? undefined : buildVoiceModOptions(channelId, user, moderate);
    },
  };
}
