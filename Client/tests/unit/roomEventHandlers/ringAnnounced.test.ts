// Tests for the ring a participant reports for itself (voice_speaking): the
// listening side in src/features/voice/roomEventHandlers.ts and
// src/lib/voice/roomSpeakers.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mocks from "../../helpers/roomEventHandlersMocks";
import { Track } from "livekit-client";
import type { RemoteParticipant } from "livekit-client";
import { voiceStore, setSpeakers } from "@stores/voice.store";
import type { RingState } from "@lib/voice/ringAnnounce";
import {
  type Harness,
  build,
  join,
  muteMic,
  seedVoiceUsers,
  useRoomEventHandlersHarness,
} from "../../helpers/roomEventHandlersHarness";

vi.mock("@stores/voice.store", (importOriginal) => mocks.voiceStoreMock(importOriginal));

useRoomEventHandlersHarness();

const speaking = () => voiceStore.getState().voiceUsers.get(12)?.get(7)?.speaking;

/** User 7's report, as the server relays it. */
function announce(h: Harness, state: RingState, userId = 7): void {
  h.handlers.handleRingAnnounced(userId, state);
}

/** A call with user 7 in it. */
function call(): { h: Harness; u7: RemoteParticipant } {
  seedVoiceUsers(12, [3, 7]);
  const h = build();
  return { h, u7: join(h, "user-7:tok") };
}

describe("a ring a participant announces for itself", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lights the sender with no word from LiveKit", () => {
    const { h } = call();

    announce(h, true);

    expect(speaking()).toBe(true);
    expect(voiceStore.getState().voiceUsers.get(12)?.get(3)?.speaking).toBe(false);
  });

  it("goes dark on the announced stop at once, though LiveKit still lists the sender", () => {
    const { h, u7 } = call();
    h.handlers.handleActiveSpeakersChanged([u7]);
    announce(h, true);

    announce(h, false);

    expect(speaking()).toBe(false);
    h.handlers.handleActiveSpeakersChanged([u7]);
    expect(speaking()).toBe(false);
  });

  it("stays lit while LiveKit drops the sender mid-speech", () => {
    const { h, u7 } = call();
    h.handlers.handleActiveSpeakersChanged([u7]);
    announce(h, true);

    h.handlers.handleActiveSpeakersChanged([]);
    vi.advanceTimersByTime(500);

    expect(speaking()).toBe(true);
  });

  it("stays lit, and republishes nothing, while the sender repeats itself", () => {
    const { h } = call();
    announce(h, true);
    const published = vi.mocked(setSpeakers).mock.calls.length;

    for (let second = 0; second < 5; second++) {
      vi.advanceTimersByTime(1000);
      announce(h, true);
    }

    expect(speaking()).toBe(true);
    expect(vi.mocked(setSpeakers).mock.calls.length).toBe(published);
  });

  describe("a sender that falls silent without saying so", () => {
    it("goes dark once the lit ring was not repeated for 3 s", () => {
      const { h } = call();
      announce(h, true);

      vi.advanceTimersByTime(2999);
      expect(speaking()).toBe(true);
      vi.advanceTimersByTime(1);

      expect(speaking()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("counts 3 s from the last repeat", () => {
      const { h } = call();
      announce(h, true);
      vi.advanceTimersByTime(2000);
      announce(h, true);

      vi.advanceTimersByTime(2999);
      expect(speaking()).toBe(true);
      vi.advanceTimersByTime(1);

      expect(speaking()).toBe(false);
    });

    it("hands the sender back to LiveKit once the announcement ran out", () => {
      const { h, u7 } = call();
      h.handlers.handleActiveSpeakersChanged([u7]);
      announce(h, false);
      expect(speaking()).toBe(false);

      vi.advanceTimersByTime(3000);

      expect(speaking()).toBe(true);
    });
  });

  describe("a sender with no verdict of its own", () => {
    it("follows LiveKit when it never announced", () => {
      const { h, u7 } = call();

      h.handlers.handleActiveSpeakersChanged([u7]);

      expect(speaking()).toBe(true);
    });

    it("follows LiveKit again once it announces it has none", () => {
      const { h, u7 } = call();
      h.handlers.handleActiveSpeakersChanged([u7]);
      announce(h, false);

      announce(h, null);

      expect(speaking()).toBe(true);
    });

    it("publishes nothing for a 'none' from a sender that never announced", () => {
      const { h } = call();

      announce(h, null);

      expect(setSpeakers).not.toHaveBeenCalled();
    });
  });

  describe("a report that must not move a ring", () => {
    it("ignores a user who is not in the room", () => {
      const { h } = call();
      h.room.remoteParticipants.delete("user-7:tok");

      announce(h, true);

      expect(setSpeakers).not.toHaveBeenCalled();
    });

    it("ignores our own user id", () => {
      const { h } = call();

      announce(h, true, 1);

      expect(setSpeakers).not.toHaveBeenCalled();
    });

    it("lights only the user the server names", () => {
      const { h } = call();
      join(h, "user-3:tok");

      announce(h, true, 3);

      expect(speaking()).toBe(false);
      expect(voiceStore.getState().voiceUsers.get(12)?.get(3)?.speaking).toBe(true);
    });

    it("drops what a user reported before it rejoined under a new sid", () => {
      const { h } = call();
      announce(h, true);
      join(h, "user-7:tok", "PA_new");

      h.handlers.handleActiveSpeakersChanged([]);

      expect(speaking()).toBe(false);
    });

    it("does nothing when not in a channel", () => {
      seedVoiceUsers(12, [7]);
      const h = build({ getCurrentChannelId: () => null });
      join(h, "user-7:tok");

      announce(h, true);

      expect(speaking()).toBe(false);
    });
  });

  it("keeps a sender dark whose microphone is muted, whatever it announces", () => {
    const { h, u7 } = call();
    muteMic(h, u7, false);

    announce(h, true);

    expect(speaking()).toBe(false);
  });

  describe("a lit report that arrives before the sender's microphone is on", () => {
    it("lights the ring once the microphone is, with no word from LiveKit", () => {
      const { h, u7 } = call();
      const mic = u7.getTrackPublication(Track.Source.Microphone) as { isMuted: boolean };
      mic.isMuted = true;
      announce(h, true);
      expect(speaking()).toBe(false);

      mic.isMuted = false;
      vi.advanceTimersByTime(100);

      expect(speaking()).toBe(true);
    });

    it("publishes nothing while it waits, and stops looking once the report ran out", () => {
      const { h, u7 } = call();
      muteMic(h, u7, false);
      announce(h, true);
      const published = vi.mocked(setSpeakers).mock.calls.length;

      vi.advanceTimersByTime(2900);
      expect(vi.mocked(setSpeakers).mock.calls.length).toBe(published);
      vi.advanceTimersByTime(100);

      expect(speaking()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("keeps looking while the sender repeats itself", () => {
      const { h, u7 } = call();
      const mic = u7.getTrackPublication(Track.Source.Microphone) as { isMuted: boolean };
      mic.isMuted = true;
      announce(h, true);
      vi.advanceTimersByTime(1000);
      announce(h, true);

      mic.isMuted = false;
      vi.advanceTimersByTime(100);

      expect(speaking()).toBe(true);
    });
  });

  it("clears an announced ring when the sender mutes", () => {
    const { h, u7 } = call();
    announce(h, true);

    muteMic(h, u7);

    expect(speaking()).toBe(false);
  });

  it("clears an announced ring when the sender leaves, and forgets the announcement", () => {
    const { h, u7 } = call();
    announce(h, true);

    h.handlers.handleParticipantDisconnected(u7);

    expect(speaking()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops an announcement whose sender left without a word, at the next publish", () => {
    const { h } = call();
    announce(h, true);
    h.room.remoteParticipants.delete("user-7:tok");

    h.handlers.handleActiveSpeakersChanged([]);

    expect(speaking()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forgets every announcement when the room reconnects", () => {
    const { h, u7 } = call();
    announce(h, false);

    h.handlers.handleSdkReconnected();
    h.handlers.handleActiveSpeakersChanged([u7]);

    expect(speaking()).toBe(true);
  });

  it("leaves no timer behind when the session resets", () => {
    const { h } = call();
    announce(h, true);

    h.handlers.resetEncryptionRecovery();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("still runs the hold of a LiveKit speaker beside an announcing one", () => {
    const { h } = call();
    const u3 = join(h, "user-3:tok");
    h.handlers.handleActiveSpeakersChanged([u3]);
    announce(h, true);

    h.handlers.handleActiveSpeakersChanged([]);
    vi.advanceTimersByTime(199);
    expect(voiceStore.getState().voiceUsers.get(12)?.get(3)?.speaking).toBe(true);
    vi.advanceTimersByTime(1);

    expect(voiceStore.getState().voiceUsers.get(12)?.get(3)?.speaking).toBe(false);
    expect(speaking()).toBe(true);
  });
});
