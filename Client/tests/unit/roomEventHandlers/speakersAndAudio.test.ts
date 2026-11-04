// Tests for src/lib/voice/roomEventHandlers.ts, continued from tracks.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mocks from "../../helpers/roomEventHandlersMocks";
import { DisconnectReason, Track } from "livekit-client";
import type { Participant, RemoteParticipant, RemoteTrackPublication, Room } from "livekit-client";
import { voiceStore, setSpeakers, joinVoiceChannel } from "@stores/voice.store";
import type { VoiceUser } from "@stores/voice.store";
import { expectConsole } from "../../helpers/console";
import {
  Harness,
  build,
  pub,
  participant,
  useRoomEventHandlersHarness,
} from "../../helpers/roomEventHandlersHarness";

vi.mock("@stores/voice.store", (importOriginal) => mocks.voiceStoreMock(importOriginal));

useRoomEventHandlersHarness();

// ── handleActiveSpeakersChanged ────────────────────────────────────────────

function seedVoiceUsers(channelId: number, userIds: number[]): void {
  voiceStore.setState((prev) => {
    const users = new Map<number, VoiceUser>(
      userIds.map((id) => [
        id,
        {
          userId: id,
          username: `u${id}`,
          muted: false,
          deafened: false,
          speaking: false,
          camera: false,
          screenshare: false,
        },
      ]),
    );
    return { ...prev, currentChannelId: channelId, voiceUsers: new Map([[channelId, users]]) };
  });
}

describe("handleActiveSpeakersChanged", () => {
  /** A remote participant in the room, microphone published and unmuted. */
  function join(h: Harness, identity: string, sid = `PA_${identity}`): RemoteParticipant {
    const mic = { source: Track.Source.Microphone, isMuted: false };
    const p = {
      identity,
      sid,
      getTrackPublication: (source: Track.Source) =>
        source === Track.Source.Microphone ? mic : undefined,
    } as unknown as RemoteParticipant;
    h.room.remoteParticipants.set(identity, p);
    return p;
  }

  const speaking = () => voiceStore.getState().voiceUsers.get(12)?.get(7)?.speaking;

  it("marks the reported users as speaking", () => {
    seedVoiceUsers(12, [3, 7]);
    const h = build();

    h.handlers.handleActiveSpeakersChanged([join(h, "user-7:tok")]);

    const users = voiceStore.getState().voiceUsers.get(12);
    expect(users?.get(7)?.speaking).toBe(true);
    expect(users?.get(3)?.speaking).toBe(false);
  });

  describe("anti-flicker hold", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("keeps a dropped speaker lit for 200 ms, then clears them", () => {
      seedVoiceUsers(12, [7]);
      const h = build();
      h.handlers.handleActiveSpeakersChanged([join(h, "user-7:tok")]);

      h.handlers.handleActiveSpeakersChanged([]);
      expect(speaking()).toBe(true);
      vi.advanceTimersByTime(199);
      expect(speaking()).toBe(true);
      vi.advanceTimersByTime(1);
      expect(speaking()).toBe(false);
    });

    it("never goes dark for a speaker who returns within the hold", () => {
      seedVoiceUsers(12, [7]);
      const h = build();
      const u7 = join(h, "user-7:tok");
      h.handlers.handleActiveSpeakersChanged([u7]);
      h.handlers.handleActiveSpeakersChanged([]);
      vi.advanceTimersByTime(100);

      h.handlers.handleActiveSpeakersChanged([u7]);
      vi.advanceTimersByTime(500);

      expect(speaking()).toBe(true);
    });

    it("does not relight a channel the client has left", () => {
      seedVoiceUsers(12, [3, 7]);
      const h = build();
      const u3 = join(h, "user-3:tok");
      const u7 = join(h, "user-7:tok");
      h.handlers.handleActiveSpeakersChanged([u3, u7]);
      h.handlers.handleActiveSpeakersChanged([u7]);

      joinVoiceChannel(99);
      vi.advanceTimersByTime(500);
      expect(speaking()).toBe(false);

      h.handlers.handleActiveSpeakersChanged([u7]);
      expect(speaking()).toBe(false);
    });

    it("drops the pending hold when the session resets", () => {
      seedVoiceUsers(12, [7]);
      const h = build();
      h.handlers.handleActiveSpeakersChanged([join(h, "user-7:tok")]);
      h.handlers.handleActiveSpeakersChanged([]);

      h.handlers.resetEncryptionRecovery();

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  // livekit-client never prunes a participant who left from its speaker list:
  // the SFU's "stopped" update for them names a sid it no longer knows, and
  // it skips it. Every later ActiveSpeakersChanged lists them again.
  describe("a speaker who can no longer be talking", () => {
    it("ignores a speaker LiveKit still lists after they left the room", () => {
      seedVoiceUsers(12, [7]);
      const h = build();
      const u7 = join(h, "user-7:tok");
      h.room.remoteParticipants.delete("user-7:tok");

      h.handlers.handleActiveSpeakersChanged([u7]);

      expect(speaking()).toBe(false);
    });

    it("ignores the old session of a user who rejoined under a new sid", () => {
      seedVoiceUsers(12, [7]);
      const h = build();
      const old = join(h, "user-7:tok", "PA_old");
      join(h, "user-7:tok", "PA_new");

      h.handlers.handleActiveSpeakersChanged([old]);

      expect(speaking()).toBe(false);
    });

    it("clears a speaker who leaves the room at once, without the hold", () => {
      seedVoiceUsers(12, [7]);
      const h = build();
      const u7 = join(h, "user-7:tok");
      h.handlers.handleActiveSpeakersChanged([u7]);
      h.room.remoteParticipants.delete("user-7:tok");

      h.handlers.handleParticipantDisconnected(u7);

      expect(speaking()).toBe(false);
      h.handlers.handleActiveSpeakersChanged([u7]);
      expect(speaking()).toBe(false);
    });

    it("clears a speaker who mutes at once, and keeps them dark while muted", () => {
      seedVoiceUsers(12, [7]);
      const h = build();
      const u7 = join(h, "user-7:tok");
      h.handlers.handleActiveSpeakersChanged([u7]);
      const mic = u7.getTrackPublication(Track.Source.Microphone) as { isMuted: boolean };
      mic.isMuted = true;

      h.handlers.handleTrackMuted(mic as unknown as RemoteTrackPublication, u7);

      expect(speaking()).toBe(false);
      // The SFU's own "stopped" update trails the mute by a detection window.
      h.handlers.handleActiveSpeakersChanged([u7]);
      expect(speaking()).toBe(false);
    });

    it("keeps a speaker whose camera, not microphone, was muted", () => {
      seedVoiceUsers(12, [7]);
      const h = build();
      const u7 = join(h, "user-7:tok");
      h.handlers.handleActiveSpeakersChanged([u7]);

      h.handlers.handleTrackMuted(pub(Track.Source.Camera), u7);

      expect(speaking()).toBe(true);
    });
  });

  // A resumed or replaced room never hears the "stopped" updates the SFU sent
  // while it was cut off.
  describe("a room that reconnects", () => {
    it("clears every ring and LiveKit's speaker list when the SDK reconnects", () => {
      seedVoiceUsers(12, [7]);
      const h = build();
      const u7 = join(h, "user-7:tok");
      h.room.activeSpeakers = [u7];
      h.handlers.handleActiveSpeakersChanged([u7]);

      h.handlers.handleSdkReconnected();

      expect(speaking()).toBe(false);
      expect(h.room.activeSpeakers).toEqual([]);
    });

    it("clears every ring when the room is dropped for the app's own reconnect", () => {
      seedVoiceUsers(12, [7]);
      const h = build();
      h.handlers.handleActiveSpeakersChanged([join(h, "user-7:tok")]);

      h.handlers.handleDisconnected(DisconnectReason.SERVER_SHUTDOWN);

      expect(h.spies.attemptAutoReconnect).toHaveBeenCalled();
      expect(speaking()).toBe(false);
    });
  });

  it("ignores participants with an unparseable identity", () => {
    seedVoiceUsers(12, [7]);
    const h = build();

    h.handlers.handleActiveSpeakersChanged([join(h, "garbage"), join(h, "user-7:tok")]);

    expect(speaking()).toBe(true);
  });

  it("does nothing when not in a channel", () => {
    seedVoiceUsers(12, [7]);
    const h = build({ getCurrentChannelId: () => null });

    h.handlers.handleActiveSpeakersChanged([join(h, "user-7:tok")]);

    expect(speaking()).toBe(false);
  });
});

// ── handleAudioPlaybackChanged ─────────────────────────────────────────────

describe("handleAudioPlaybackChanged", () => {
  it("does nothing without a room", () => {
    const h = build({ getRoom: () => null });

    expect(() => {
      h.handlers.handleAudioPlaybackChanged();
    }).not.toThrow();
  });

  it("registers a click-to-unlock listener when playback is blocked", async () => {
    const h = build();
    h.room.canPlaybackAudio = false;

    h.handlers.handleAudioPlaybackChanged();
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expectConsole("warn", /\[roomEventHandlers\] Audio playback blocked by browser/);
    // The browser blocks autoplay until a user gesture; without this the user
    // joins a call and hears nothing at all.
    await vi.waitFor(() => {
      expect(h.room.startAudio).toHaveBeenCalled();
    });
  });

  it("does not register a listener when playback is allowed", () => {
    const h = build();
    h.room.canPlaybackAudio = true;

    h.handlers.handleAudioPlaybackChanged();
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(h.room.startAudio).not.toHaveBeenCalled();
  });

  it("replaces a previous unlock listener rather than stacking them", async () => {
    const h = build();
    h.room.canPlaybackAudio = false;

    h.handlers.handleAudioPlaybackChanged();
    h.handlers.handleAudioPlaybackChanged();
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await vi.waitFor(() => {
      expect(h.room.startAudio).toHaveBeenCalledTimes(1);
    });
    expectConsole("warn", /\[roomEventHandlers\] Audio playback blocked by browser/);
    expectConsole("warn", /\[roomEventHandlers\] Audio playback blocked by browser/);
  });

  it("removeAutoplayUnlock drops the pending listener", () => {
    const h = build();
    h.room.canPlaybackAudio = false;
    h.handlers.handleAudioPlaybackChanged();

    h.handlers.removeAutoplayUnlock();
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expectConsole("warn", /\[roomEventHandlers\] Audio playback blocked by browser/);
    expect(h.room.startAudio).not.toHaveBeenCalled();
  });

  it("removeAutoplayUnlock is safe with nothing registered", () => {
    const h = build();

    expect(() => {
      h.handlers.removeAutoplayUnlock();
      h.handlers.removeAutoplayUnlock();
    }).not.toThrow();
  });

  it("a later allowed-playback event clears the pending listener", () => {
    const h = build();
    h.room.canPlaybackAudio = false;
    h.handlers.handleAudioPlaybackChanged();

    h.room.canPlaybackAudio = true;
    h.handlers.handleAudioPlaybackChanged();
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expectConsole("warn", /\[roomEventHandlers\] Audio playback blocked by browser/);
    expect(h.room.startAudio).not.toHaveBeenCalled();
  });

  it("the unlock handler tolerates the room disappearing first", () => {
    let room: Room | null = { canPlaybackAudio: false } as unknown as Room;
    const h = build({ getRoom: () => room });

    h.handlers.handleAudioPlaybackChanged();
    expectConsole("warn", /\[roomEventHandlers\] Audio playback blocked by browser/);
    room = null; // user left voice before clicking

    expect(() => {
      document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }).not.toThrow();
  });
});

// ── speaker lists ──────────────────────────────────────────────────────────

describe("published speaker lists", () => {
  function remote(h: Harness, identity: string): RemoteParticipant {
    const mic = { source: Track.Source.Microphone, isMuted: false };
    const p = {
      identity,
      sid: `PA_${identity}`,
      getTrackPublication: (source: Track.Source) =>
        source === Track.Source.Microphone ? mic : undefined,
    } as unknown as RemoteParticipant;
    h.room.remoteParticipants.set(identity, p);
    return p;
  }

  const seed = (userIds: number[]): void => seedVoiceUsers(12, userIds);

  const speaking = (id: number) => voiceStore.getState().voiceUsers.get(12)?.get(id)?.speaking;
  const lastPublished = () => vi.mocked(setSpeakers).mock.calls.at(-1)?.[0];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(setSpeakers).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists speakers in ascending user id order", () => {
    seed([3, 7, 9]);
    const h = build();

    h.handlers.handleActiveSpeakersChanged([
      remote(h, "user-9:tok"),
      remote(h, "user-3:tok"),
      remote(h, "user-7:tok"),
    ]);

    expect(lastPublished()).toEqual({ channel_id: 12, speakers: [3, 7, 9] });
  });

  it("lists a held speaker together with the live ones, in order", () => {
    seed([3, 7, 9]);
    const h = build();
    const u9 = remote(h, "user-9:tok");
    const u3 = remote(h, "user-3:tok");
    const u7 = remote(h, "user-7:tok");
    h.handlers.handleActiveSpeakersChanged([u9, u3, u7]);

    h.handlers.handleActiveSpeakersChanged([u7, u3]);

    expect(lastPublished()).toEqual({ channel_id: 12, speakers: [3, 7, 9] });
  });

  it("leaves an unparseable identity out of the list", () => {
    seed([7]);
    const h = build();

    h.handlers.handleActiveSpeakersChanged([remote(h, "garbage"), remote(h, "user-7:tok")]);

    expect(lastPublished()).toEqual({ channel_id: 12, speakers: [7] });
  });

  it("shows the local user as speaking when LiveKit lists them", () => {
    seed([1, 7]);
    const h = build();
    const me = { identity: "user-1:tok", sid: "PA_me" } as unknown as Participant;

    h.handlers.handleActiveSpeakersChanged([me]);

    expect(lastPublished()).toEqual({ channel_id: 12, speakers: [1] });
    expect(speaking(1)).toBe(true);
  });

  it("keeps the local user's ring when their own microphone mutes", () => {
    seed([1]);
    const h = build();
    const me = { identity: "user-1:tok", sid: "PA_me" } as unknown as Participant;
    h.handlers.handleActiveSpeakersChanged([me]);
    vi.mocked(setSpeakers).mockClear();

    h.handlers.handleTrackMuted(pub(Track.Source.Microphone), me);

    expect(setSpeakers).not.toHaveBeenCalled();
    expect(speaking(1)).toBe(true);
  });

  it("schedules nothing when no speaker is on hold", () => {
    seed([7]);
    const h = build();

    h.handlers.handleActiveSpeakersChanged([remote(h, "user-7:tok")]);

    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the hold of the speaker whose hold ends first", () => {
    seed([7, 8]);
    const h = build();
    const u7 = remote(h, "user-7:tok");
    const u8 = remote(h, "user-8:tok");
    h.handlers.handleActiveSpeakersChanged([u7, u8]);

    h.handlers.handleActiveSpeakersChanged([u8]); // 7 held until 200
    vi.advanceTimersByTime(100);
    const schedule = vi.spyOn(globalThis, "setTimeout");
    h.handlers.handleActiveSpeakersChanged([]); // 8 held until 300
    // The next wake-up is when the earliest hold ends, 100 ms from now.
    expect(schedule.mock.calls.at(-1)?.[1]).toBe(100);
    schedule.mockRestore();

    vi.advanceTimersByTime(99);
    expect(speaking(7)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(speaking(7)).toBe(false);
    expect(speaking(8)).toBe(true);
    vi.advanceTimersByTime(100);
    expect(speaking(8)).toBe(false);
  });

  it("does not republish when a participant who was not speaking leaves or mutes", () => {
    seed([7, 9]);
    const h = build();
    const u7 = remote(h, "user-7:tok");
    h.handlers.handleActiveSpeakersChanged([u7]);
    vi.mocked(setSpeakers).mockClear();

    h.handlers.handleParticipantDisconnected(participant("user-9:tok"));
    h.handlers.handleTrackMuted(pub(Track.Source.Microphone), participant("user-9:tok"));

    expect(setSpeakers).not.toHaveBeenCalled();
    expect(speaking(7)).toBe(true);
  });

  it("clears a speaker on hold at once when they leave", () => {
    seed([7]);
    const h = build();
    const u7 = remote(h, "user-7:tok");
    h.handlers.handleActiveSpeakersChanged([u7]);
    h.handlers.handleActiveSpeakersChanged([]);
    expect(speaking(7)).toBe(true);

    h.handlers.handleParticipantDisconnected(u7);

    expect(speaking(7)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears a speaker on hold at once when they mute", () => {
    seed([7]);
    const h = build();
    const u7 = remote(h, "user-7:tok");
    h.handlers.handleActiveSpeakersChanged([u7]);
    h.handlers.handleActiveSpeakersChanged([]);

    h.handlers.handleTrackMuted(pub(Track.Source.Microphone), u7);

    expect(speaking(7)).toBe(false);
  });

  it("forgets live speakers when the SDK reconnects", () => {
    seed([7]);
    const h = build();
    h.handlers.handleActiveSpeakersChanged([remote(h, "user-7:tok")]);

    h.handlers.handleSdkReconnected();
    h.handlers.handleActiveSpeakersChanged([]);

    expect(speaking(7)).toBe(false);
  });

  it("forgets a speaker on hold when the SDK reconnects", () => {
    seed([7]);
    const h = build();
    h.handlers.handleActiveSpeakersChanged([remote(h, "user-7:tok")]);
    h.handlers.handleActiveSpeakersChanged([]);

    h.handlers.handleSdkReconnected();
    h.handlers.handleActiveSpeakersChanged([]);

    expect(speaking(7)).toBe(false);
  });

  it("forgets a speaker on hold when the session resets", () => {
    seed([7]);
    const h = build();
    h.handlers.handleActiveSpeakersChanged([remote(h, "user-7:tok")]);
    h.handlers.handleActiveSpeakersChanged([]);

    h.handlers.resetEncryptionRecovery();
    h.handlers.handleActiveSpeakersChanged([]);

    expect(speaking(7)).toBe(false);
  });
});

// ── autoplay unlock listener ───────────────────────────────────────────────

describe("autoplay unlock listener lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers one one-shot click listener while playback is blocked", () => {
    const add = vi.spyOn(document, "addEventListener");
    const h = build();
    h.room.canPlaybackAudio = false;

    h.handlers.handleAudioPlaybackChanged();
    expectConsole("warn", /Audio playback blocked by browser/);

    const clicks = add.mock.calls.filter(([type]) => type === "click");
    expect(clicks).toHaveLength(1);
    expect(clicks[0]?.[2]).toEqual({ once: true });
    h.handlers.removeAutoplayUnlock();
  });

  it("removes the listener itself once the click has been handled", () => {
    const remove = vi.spyOn(document, "removeEventListener");
    const h = build();
    h.room.canPlaybackAudio = false;
    h.handlers.handleAudioPlaybackChanged();
    expectConsole("warn", /Audio playback blocked by browser/);
    remove.mockClear();

    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(remove.mock.calls.filter(([type]) => type === "click")).toHaveLength(1);
  });

  it("leaves no stray listener behind when the blocked event repeats", () => {
    const h = build();
    h.room.canPlaybackAudio = false;
    h.handlers.handleAudioPlaybackChanged();
    h.handlers.handleAudioPlaybackChanged();
    expectConsole("warn", /Audio playback blocked by browser/);
    expectConsole("warn", /Audio playback blocked by browser/);

    h.handlers.removeAutoplayUnlock();
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(h.room.startAudio).not.toHaveBeenCalled();
  });

  it("drops a pending listener when the room is abandoned for the reconnect loop", () => {
    const h = build();
    h.room.canPlaybackAudio = false;
    h.handlers.handleAudioPlaybackChanged();
    expectConsole("warn", /Audio playback blocked by browser/);

    h.handlers.handleDisconnected(DisconnectReason.SERVER_SHUTDOWN);
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(h.spies.attemptAutoReconnect).toHaveBeenCalled();
    expect(h.room.startAudio).not.toHaveBeenCalled();
  });
});
