import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAuth } from "@stores/auth.store";
import { joinVoiceChannel, leaveVoiceChannel, voiceStore } from "@stores/voice.store";
import { isDmKeptForCall, keepDmForCall, releaseKeptDm, resetKeptCallDms } from "./keptCallDms";

beforeEach(() => {
  leaveVoiceChannel();
  voiceStore.flush();
  resetKeptCallDms();
});

afterEach(() => {
  leaveVoiceChannel();
  voiceStore.flush();
  resetKeptCallDms();
});

describe("keptCallDms", () => {
  it("keeps a closed DM only while its call is the live voice session", () => {
    joinVoiceChannel(7);
    voiceStore.flush();
    keepDmForCall(7);
    expect(isDmKeptForCall(7)).toBe(true);
    expect(isDmKeptForCall(8)).toBe(false);
  });

  it("ignores a DM that is not the live call (a group leave never records one)", () => {
    joinVoiceChannel(7);
    keepDmForCall(8);
    expect(isDmKeptForCall(8)).toBe(false);
  });

  it("drops the entry when voice leaves the channel", () => {
    joinVoiceChannel(7);
    voiceStore.flush();
    keepDmForCall(7);
    leaveVoiceChannel();
    voiceStore.flush();
    expect(isDmKeptForCall(7)).toBe(false);
    // After the flushed leave pruned the entry, a new join of channel 7 finds nothing kept.
    joinVoiceChannel(7);
    voiceStore.flush();
    expect(isDmKeptForCall(7)).toBe(false);
  });

  it("drops the entry when the session moves to another channel", () => {
    joinVoiceChannel(7);
    voiceStore.flush();
    keepDmForCall(7);
    joinVoiceChannel(9);
    voiceStore.flush();
    expect(isDmKeptForCall(7)).toBe(false);
  });

  it("releases an entry on demand (the server refused the close)", () => {
    joinVoiceChannel(7);
    voiceStore.flush();
    keepDmForCall(7);
    releaseKeptDm(7);
    expect(isDmKeptForCall(7)).toBe(false);
  });

  it("is cleared on sign-out", () => {
    joinVoiceChannel(7);
    voiceStore.flush();
    keepDmForCall(7);
    clearAuth();
    // No flush: the voice prune never sees the sign-out's leave, because the
    // rejoin lands in the same batch (7 to 7). Only the auth hook can clear it.
    joinVoiceChannel(7);
    expect(isDmKeptForCall(7)).toBe(false);
  });
});

/** Wraps the store's subscription so a test can count subscribes and unsubscribes. */
function watchSubscriptions(): { subscribed: () => number; unsubscribed: () => number } {
  const original = voiceStore.subscribeSelector.bind(voiceStore);
  const unsubscribes: Array<ReturnType<typeof vi.fn>> = [];
  const spy = vi
    .spyOn(voiceStore, "subscribeSelector")
    .mockImplementation((...args: Parameters<typeof original>) => {
      const stop = original(...args);
      const wrapped = vi.fn(stop);
      unsubscribes.push(wrapped);
      return wrapped;
    });
  return {
    subscribed: () => spy.mock.calls.length,
    unsubscribed: () => unsubscribes.filter((u) => u.mock.calls.length > 0).length,
  };
}

describe("keptCallDms pruning", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never remembers a DM that was not the live call when it was closed", () => {
    joinVoiceChannel(7);
    voiceStore.flush();
    keepDmForCall(8);
    joinVoiceChannel(8);
    voiceStore.flush();
    expect(isDmKeptForCall(8)).toBe(false);
  });

  it("stops treating a kept DM as live the moment voice leaves, before the store notifies", () => {
    joinVoiceChannel(7);
    voiceStore.flush();
    keepDmForCall(7);
    leaveVoiceChannel();
    expect(isDmKeptForCall(7)).toBe(false);
  });

  it("subscribes once however many DMs are kept", () => {
    const watch = watchSubscriptions();
    joinVoiceChannel(7);
    voiceStore.flush();
    keepDmForCall(7);
    keepDmForCall(7);
    expect(watch.subscribed()).toBe(1);
  });

  it("unsubscribes once nothing is kept, and prunes again for the next kept DM", () => {
    const watch = watchSubscriptions();
    joinVoiceChannel(7);
    voiceStore.flush();
    keepDmForCall(7);
    leaveVoiceChannel();
    voiceStore.flush();
    expect(watch.unsubscribed()).toBe(1);

    joinVoiceChannel(9);
    voiceStore.flush();
    keepDmForCall(9);
    expect(watch.subscribed()).toBe(2);
    leaveVoiceChannel();
    voiceStore.flush();
    joinVoiceChannel(9);
    voiceStore.flush();
    expect(isDmKeptForCall(9)).toBe(false);
  });

  it("keeps listening while another DM is still the live call, and prunes only the others", () => {
    const watch = watchSubscriptions();
    joinVoiceChannel(7);
    voiceStore.flush();
    keepDmForCall(7);
    // The session moves to 8 and 8 is closed in the same batch.
    joinVoiceChannel(8);
    keepDmForCall(8);
    voiceStore.flush();

    expect(isDmKeptForCall(8)).toBe(true);
    expect(watch.unsubscribed()).toBe(0);
    leaveVoiceChannel();
    voiceStore.flush();
    expect(watch.unsubscribed()).toBe(1);
    joinVoiceChannel(7);
    voiceStore.flush();
    expect(isDmKeptForCall(7)).toBe(false);
  });
});
