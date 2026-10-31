import { updateVoiceState, type VoiceUser } from "../../src/stores/voice.store";
import type { VoiceStatePayload } from "../../src/lib/types";

/** Add a connected voice user to a channel (via the same store path the WS uses). */
export function addVoiceUser(
  channelId: number,
  userId: number,
  username: string,
  flags: Partial<
    Pick<VoiceStatePayload, "muted" | "deafened" | "speaking" | "camera" | "screenshare">
  > = {},
): void {
  updateVoiceState({
    channel_id: channelId,
    user_id: userId,
    username,
    muted: false,
    deafened: false,
    speaking: false,
    camera: false,
    screenshare: false,
    ...flags,
  });
}

/** A voice-store user `u<id>` with the flags off; `over` wins. */
export function voiceUser(userId: number, over: Partial<VoiceUser> = {}): VoiceUser {
  return {
    userId,
    username: `u${userId}`,
    muted: false,
    deafened: false,
    speaking: false,
    camera: false,
    screenshare: false,
    ...over,
  };
}

/** A voice-store user `user<id>` with every flag off; `over` wins. */
export function makeVoiceUser(userId: number, over: Partial<VoiceUser> = {}): VoiceUser {
  return {
    userId,
    username: `user${userId}`,
    muted: false,
    deafened: false,
    speaking: false,
    camera: false,
    screenshare: false,
    serverMuted: false,
    serverDeafened: false,
    ...over,
  };
}
