import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeChannel } from "../helpers/channelFactory";
import {
  hiddenByMute,
  isHideMutedChannels,
  mutedRowHidden,
  setHideMutedChannels,
} from "../../src/lib/prefs/hideMutedChannels";
import { invalidateMuteCache, muteChannel } from "../../src/lib/prefs/channelMutes";

const ch = makeChannel;

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

describe("mutedRowHidden", () => {
  it("agrees with hiddenByMute over preference, mute, active, mention and occupancy", () => {
    for (const hide of [false, true]) {
      for (const muted of [false, true]) {
        for (const active of [false, true]) {
          for (const mention of [0, 2]) {
            for (const type of ["text", "voice"] as const) {
              for (const occupied of [false, true]) {
                localStorage.clear();
                invalidateMuteCache();
                if (muted) muteChannel(1);
                setHideMutedChannels(hide);
                const channel = ch({ type, mentionCount: mention });
                const label = `${hide}/${muted}/${active}/${mention}/${type}/${occupied}`;
                expect(
                  mutedRowHidden(channel, active ? 1 : null, hide, muted, occupied),
                  label,
                ).toBe(hiddenByMute(channel, active ? 1 : null, () => occupied));
              }
            }
          }
        }
      }
    }
  });
});
