import { afterEach, describe, expect, it } from "vitest";
import {
  registerSessionReset,
  listSessionResets,
  runSessionResets,
} from "../../src/lib/sessionRegistry";
import { joinVoiceChannel, leaveVoiceChannel, voiceStore } from "../../src/stores/voice.store";

afterEach(() => {
  leaveVoiceChannel();
  voiceStore.flush();
});

describe("kept call DMs and the session reset", () => {
  it("registers its reset in the session phase, ahead of the voice and domain resets", async () => {
    const kept = await import("../../src/features/direct-messages/keptCallDms");
    const stopVoice = registerSessionReset("test:voice-probe", () => {}, { phase: "voice" });
    const stopDomain = registerSessionReset("test:domain-probe", () => {});
    try {
      const order = listSessionResets();
      expect(order).toContain("dm:kept-calls");
      expect(order.indexOf("dm:kept-calls")).toBeLessThan(order.indexOf("test:voice-probe"));
      expect(order.indexOf("test:voice-probe")).toBeLessThan(order.indexOf("test:domain-probe"));
      expect(kept.isDmKeptForCall(1)).toBe(false);
    } finally {
      stopVoice();
      stopDomain();
    }
  });

  it("forgets every kept DM when the session resets", async () => {
    const kept = await import("../../src/features/direct-messages/keptCallDms");
    joinVoiceChannel(7);
    voiceStore.flush();
    kept.keepDmForCall(7);
    expect(kept.isDmKeptForCall(7)).toBe(true);

    expect(runSessionResets("user")).toEqual([]);

    expect(kept.isDmKeptForCall(7)).toBe(false);
    kept.resetKeptCallDms();
  });
});
