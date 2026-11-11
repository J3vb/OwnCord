import { describe, it, expect, vi, afterEach } from "vitest";
import { createRingController } from "@lib/voice/callRing";
import type { VoiceState } from "@stores/voice.store";
import { syncCallsWithVoice } from "./callVoiceSync";

function voiceState(currentChannelId: number | null, roster: readonly number[]): VoiceState {
  return {
    currentChannelId,
    voiceStatus: "idle",
    voiceUsers: new Map([[77, new Map(roster.map((id) => [id, {}]))]]),
    localCamera: false,
  } as unknown as VoiceState;
}

function ringing() {
  const onMissed = vi.fn();
  const ringCtrl = createRingController({
    onRingStateChange: () => {},
    onChime: () => {},
    onAccept: () => {},
    onDecline: () => {},
    onMissed,
  });
  ringCtrl.incoming({ channelId: 77, fromUserId: 2, fromUsername: "bob" });
  return { ringCtrl, onMissed };
}

const host = (ringCtrl: ReturnType<typeof ringing>["ringCtrl"]) => ({
  ringCtrl,
  outgoingCall: null,
  cameraOnJoin: null,
});

describe("an incoming ring answered on another device of the account", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops ringing, without a missed call, once the account's own row is in the room", () => {
    vi.useFakeTimers();
    const { ringCtrl, onMissed } = ringing();
    syncCallsWithVoice(voiceState(null, [1, 2]), host(ringCtrl), () => 1);
    expect(ringCtrl.current()).toBeNull();
    vi.advanceTimersByTime(30_000);
    expect(onMissed).not.toHaveBeenCalled();
  });

  it("keeps ringing while only other people are in the room", () => {
    vi.useFakeTimers();
    const { ringCtrl, onMissed } = ringing();
    syncCallsWithVoice(voiceState(null, [2, 3]), host(ringCtrl), () => 1);
    expect(ringCtrl.current()).not.toBeNull();
    vi.advanceTimersByTime(30_000);
    expect(onMissed).toHaveBeenCalledTimes(1);
  });
});
