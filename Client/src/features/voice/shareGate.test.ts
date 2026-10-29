import { describe, it, expect, beforeEach } from "vitest";
import { shareBlockReason } from "./shareGate";
import { channelsStore, type Channel } from "../../stores/channels.store";
import type { VoiceState, VoiceUser } from "../../stores/voice.store";

const LIMIT = "This channel has reached its video limit";
const DENIED = "You don't have permission to share your screen here";

function user(userId: number, camera: boolean, screenshare: boolean): VoiceUser {
  return {
    userId,
    username: `u${userId}`,
    muted: false,
    deafened: false,
    speaking: false,
    camera,
    screenshare,
  };
}

function voice(patch: Partial<VoiceState>, users: VoiceUser[] = []): VoiceState {
  return {
    currentChannelId: 1,
    voiceUsers: new Map([[1, new Map(users.map((u) => [u.userId, u]))]]),
    voiceConfigs: new Map(),
    localMuted: false,
    localDeafened: false,
    localCamera: false,
    localScreenshare: false,
    joinedAt: null,
    listenOnly: false,
    voiceStatus: "connected",
    ...patch,
  };
}

function setLimit(voiceMaxVideo: number): void {
  channelsStore.setState((prev) => ({
    ...prev,
    channels: new Map([[1, { id: 1, voiceMaxVideo } as Channel]]),
  }));
}

describe("shareBlockReason", () => {
  beforeEach(() => setLimit(0));

  it("blocks nothing outside a call or while you share", () => {
    expect(shareBlockReason(voice({ currentChannelId: null, shareDenied: true }))).toBeNull();
    expect(shareBlockReason(voice({ localScreenshare: true, shareDenied: true }))).toBeNull();
  });

  it("names the missing permission first", () => {
    setLimit(1);
    expect(shareBlockReason(voice({ shareDenied: true }, [user(2, true, false)]))).toBe(DENIED);
    expect(shareBlockReason(voice({ shareDenied: false }))).toBeNull();
  });

  it("counts cameras and shares against the limit, like the server", () => {
    setLimit(3);
    expect(shareBlockReason(voice({}, [user(1, true, false), user(2, false, true)]))).toBeNull();
    expect(shareBlockReason(voice({}, [user(1, true, false), user(2, true, true)]))).toBe(LIMIT);
  });

  it("has no limit at 0 or for an unknown channel", () => {
    const busy = [user(1, true, true), user(2, true, true)];
    expect(shareBlockReason(voice({}, busy))).toBeNull();
    channelsStore.setState((prev) => ({ ...prev, channels: new Map() }));
    expect(shareBlockReason(voice({}, busy))).toBeNull();
  });
});
