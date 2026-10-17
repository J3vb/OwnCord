import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  hiddenByMute,
  isHideMutedChannels,
  setHideMutedChannels,
} from "../../src/lib/hide-muted-channels";
import { invalidateMuteCache, muteChannel } from "../../src/lib/channel-mutes";
import type { Channel } from "../../src/stores/channels.store";

function ch(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 1,
    name: "general",
    type: "text",
    category: null,
    position: 0,
    unreadCount: 0,
    mentionCount: 0,
    lastMessageId: null,
    canSend: true,
    slowMode: 0,
    topic: "",
    nsfw: false,
    isPrivate: false,
    voiceMaxUsers: 0,
    voiceMaxVideo: 0,
    ...overrides,
  };
}

describe("hide-muted-channels", () => {
  beforeEach(() => {
    localStorage.clear();
    invalidateMuteCache();
  });
  afterEach(() => {
    localStorage.clear();
    invalidateMuteCache();
  });

  it("defaults to off and persists the value", () => {
    expect(isHideMutedChannels()).toBe(false);
    setHideMutedChannels(true);
    expect(isHideMutedChannels()).toBe(true);
    expect(localStorage.getItem("owncord:settings:hideMutedChannels")).toBe("true");
    setHideMutedChannels(false);
    expect(isHideMutedChannels()).toBe(false);
  });

  it("treats a corrupted stored value as off", () => {
    localStorage.setItem("owncord:settings:hideMutedChannels", '"yes"');
    expect(isHideMutedChannels()).toBe(false);
  });

  it("hides only a muted channel, and only while the preference is on", () => {
    muteChannel(1);
    expect(hiddenByMute(ch(), null)).toBe(false);
    setHideMutedChannels(true);
    expect(hiddenByMute(ch(), null)).toBe(true);
    expect(hiddenByMute(ch({ id: 2 }), null)).toBe(false);
  });

  it("keeps the active channel and a muted mention", () => {
    muteChannel(1);
    setHideMutedChannels(true);
    expect(hiddenByMute(ch(), 1)).toBe(false);
    expect(hiddenByMute(ch({ unreadCount: 2, mentionCount: 1 }), null)).toBe(false);
    expect(hiddenByMute(ch({ unreadCount: 2 }), null)).toBe(true);
  });

  it("keeps a voice channel the caller reports occupied, but not an empty one", () => {
    muteChannel(1);
    setHideMutedChannels(true);
    const voice = ch({ type: "voice" });
    expect(hiddenByMute(voice, null)).toBe(true);
    expect(hiddenByMute(voice, null, () => false)).toBe(true);
    expect(hiddenByMute(voice, null, (id) => id === 1)).toBe(false);
    // The occupancy check is for voice rows only.
    expect(hiddenByMute(ch(), null, () => true)).toBe(true);
  });
});
