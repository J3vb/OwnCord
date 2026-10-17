import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
