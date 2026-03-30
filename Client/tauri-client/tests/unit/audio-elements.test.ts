import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockLoadPref, mockSavePref } = vi.hoisted(() => ({
  mockLoadPref: vi.fn((_key: string, defaultVal: unknown) => defaultVal),
  mockSavePref: vi.fn(),
}));

vi.mock("@components/settings/helpers", () => ({
  loadPref: (key: string, defaultVal: unknown) => mockLoadPref(key, defaultVal),
  savePref: (key: string, val: unknown) => mockSavePref(key, val),
}));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("livekit-client", () => ({
  Track: {
    Source: {
      Microphone: "microphone",
      Camera: "camera",
      ScreenShare: "screenShare",
      ScreenShareAudio: "screenShareAudio",
    },
  },
}));

vi.mock("@lib/livekitSession", () => ({
  parseUserId: (identity: string) => {
    const match = identity.match(/^user-(\d+)$/);
    if (match !== null && match[1] !== undefined) return parseInt(match[1], 10);
    return 0;
  },
}));

import { AudioElements } from "../../src/lib/audioElements";

function createMockTrack(kind: string, sid: string) {
  const audioEl = document.createElement("audio");
  // The track passed to handleTrackSubscribedAudio is a RemoteTrack directly
  // (not wrapped in a publication), so detach/attach are on the top-level object
  const track = {
    kind,
    sid,
    detach: vi.fn(() => [audioEl]),
    attach: vi.fn(() => audioEl),
  };
  return { track, audioEl };
}

describe("AudioElements", () => {
  let elements: AudioElements;

  beforeEach(() => {
    vi.clearAllMocks();
    elements = new AudioElements();
  });

  describe("initial state", () => {
    it("has default output volume multiplier of 1.0", () => {
      expect(elements.getOutputVolumeMultiplier()).toBe(1.0);
    });

    it("returns effective volume with default multiplier", () => {
      expect(elements.getEffectiveVolume(1)).toBe(1.0);
    });
  });

  describe("setRoom", () => {
    it("accepts null without throwing", () => {
      expect(() => elements.setRoom(null)).not.toThrow();
    });
  });

  describe("handleTrackSubscribedAudio — mic", () => {
    it("attaches mic audio element to DOM", () => {
      const { track, audioEl } = createMockTrack("audio", "track-1");
      const publication = { source: "microphone" };
      const participant = { identity: "user-42", setVolume: vi.fn() };

      elements.handleTrackSubscribedAudio(track as any, publication as any, participant as any);

      expect(track.attach).toHaveBeenCalled();
      expect(audioEl.style.display).toBe("none");
      expect(participant.setVolume).toHaveBeenCalledWith(1.0);
    });
  });

  describe("handleTrackSubscribedAudio — screenshare", () => {
    it("attaches screenshare audio element to DOM", () => {
      const { track, audioEl } = createMockTrack("audio", "track-ss-1");
      const publication = { source: "screenShareAudio" };
      const participant = { identity: "user-42", setVolume: vi.fn() };

      elements.handleTrackSubscribedAudio(track as any, publication as any, participant as any);

      expect(track.attach).toHaveBeenCalled();
      expect(audioEl.volume).toBe(1);
    });

    it("inherits muted state from previous tracks", () => {
      elements.muteScreenshareAudio(42, true);

      const { track, audioEl } = createMockTrack("audio", "track-ss-2");
      const publication = { source: "screenShareAudio" };
      const participant = { identity: "user-42", setVolume: vi.fn() };

      elements.handleTrackSubscribedAudio(track as any, publication as any, participant as any);

      expect(audioEl.muted).toBe(true);
    });
  });

  describe("handleTrackUnsubscribedAudio", () => {
    it("removes mic audio element from tracking", () => {
      const { track } = createMockTrack("audio", "track-1");
      const publication = { source: "microphone" };
      const participant = { identity: "user-42", setVolume: vi.fn() };

      // Subscribe first
      elements.handleTrackSubscribedAudio(track as any, publication as any, participant as any);
      // Then unsubscribe
      elements.handleTrackUnsubscribedAudio(track as any, publication as any, participant as any);

      expect(track.detach).toHaveBeenCalled();
    });
  });

  describe("setUserVolume", () => {
    it("saves clamped volume to preferences", () => {
      elements.setUserVolume(42, 150);
      expect(mockSavePref).toHaveBeenCalledWith("userVolume_42", 150);
    });

    it("clamps to 0-200 range", () => {
      elements.setUserVolume(42, -10);
      expect(mockSavePref).toHaveBeenCalledWith("userVolume_42", 0);

      elements.setUserVolume(42, 250);
      expect(mockSavePref).toHaveBeenCalledWith("userVolume_42", 200);
    });

    it("applies volume to matching remote participant", () => {
      const mockParticipant = {
        identity: "user-42",
        setVolume: vi.fn(),
      };
      const mockRoom = {
        remoteParticipants: new Map([["user-42", mockParticipant]]),
      } as any;
      elements.setRoom(mockRoom);

      elements.setUserVolume(42, 80);

      expect(mockParticipant.setVolume).toHaveBeenCalledWith(0.8);
    });
  });

  describe("getUserVolume", () => {
    it("returns default volume of 100", () => {
      expect(elements.getUserVolume(42)).toBe(100);
    });
  });

  describe("setOutputVolume", () => {
    it("saves clamped volume to preferences", () => {
      elements.setOutputVolume(80);
      expect(mockSavePref).toHaveBeenCalledWith("outputVolume", 80);
    });

    it("clamps to 0-200 range", () => {
      elements.setOutputVolume(-10);
      expect(mockSavePref).toHaveBeenCalledWith("outputVolume", 0);

      elements.setOutputVolume(250);
      expect(mockSavePref).toHaveBeenCalledWith("outputVolume", 200);
    });

    it("updates screenshare audio element volumes", () => {
      const audioEl = document.createElement("audio");
      (elements as any).screenshareAudioElements = new Map([[42, new Set([audioEl])]]);

      elements.setOutputVolume(80);

      expect(audioEl.volume).toBe(0.8);
    });

    it("clamps screenshare volume to browser max of 1.0", () => {
      const audioEl = document.createElement("audio");
      (elements as any).screenshareAudioElements = new Map([[42, new Set([audioEl])]]);

      elements.setOutputVolume(150);

      expect(audioEl.volume).toBe(1);
    });
  });

  describe("screenshare audio", () => {
    it("setScreenshareAudioVolume does not throw for unknown userId", () => {
      expect(() => elements.setScreenshareAudioVolume(999, 0.5)).not.toThrow();
    });

    it("setScreenshareAudioVolume sets volume on tracked elements", () => {
      const audioEl = document.createElement("audio");
      (elements as any).screenshareAudioElements = new Map([[42, new Set([audioEl])]]);

      elements.setScreenshareAudioVolume(42, 0.7);
      expect(audioEl.volume).toBe(0.7);
    });

    it("setScreenshareAudioVolume clamps to 0-1 range", () => {
      const audioEl = document.createElement("audio");
      (elements as any).screenshareAudioElements = new Map([[42, new Set([audioEl])]]);

      elements.setScreenshareAudioVolume(42, -0.5);
      expect(audioEl.volume).toBe(0);

      elements.setScreenshareAudioVolume(42, 2.0);
      expect(audioEl.volume).toBe(1);
    });

    it("muteScreenshareAudio persists muted state", () => {
      elements.muteScreenshareAudio(42, true);
      expect(elements.getScreenshareAudioMuted(42)).toBe(true);
    });

    it("muteScreenshareAudio toggles back to unmuted", () => {
      elements.muteScreenshareAudio(42, true);
      elements.muteScreenshareAudio(42, false);
      expect(elements.getScreenshareAudioMuted(42)).toBe(false);
    });

    it("muteScreenshareAudio applies muted to tracked audio elements", () => {
      const audioEl = document.createElement("audio");
      (elements as any).screenshareAudioElements = new Map([[42, new Set([audioEl])]]);

      elements.muteScreenshareAudio(42, true);
      expect(audioEl.muted).toBe(true);

      elements.muteScreenshareAudio(42, false);
      expect(audioEl.muted).toBe(false);
    });

    it("getScreenshareAudioMuted returns false for unknown userId", () => {
      expect(elements.getScreenshareAudioMuted(999)).toBe(false);
    });

    it("getScreenshareAudioMuted reads from audio element when no persisted state", () => {
      const audioEl = document.createElement("audio");
      audioEl.muted = true;
      (elements as any).screenshareAudioElements = new Map([[42, new Set([audioEl])]]);
      // No call to muteScreenshareAudio, so no persisted state for user 42

      expect(elements.getScreenshareAudioMuted(42)).toBe(true);
    });

    it("getScreenshareAudioMuted returns false for empty audio element set", () => {
      (elements as any).screenshareAudioElements = new Map([[42, new Set()]]);

      expect(elements.getScreenshareAudioMuted(42)).toBe(false);
    });
  });

  describe("applyRemoteAudioSubscriptionState", () => {
    it("does not throw when no room is set", () => {
      expect(() => elements.applyRemoteAudioSubscriptionState(true)).not.toThrow();
    });

    it("unsubscribes all audio when deafened", () => {
      const mockPub = { setSubscribed: vi.fn() };
      const mockParticipant = {
        audioTrackPublications: new Map([["pub-1", mockPub]]),
      };
      const mockRoom = {
        remoteParticipants: new Map([["user-1", mockParticipant]]),
      } as any;
      elements.setRoom(mockRoom);

      elements.applyRemoteAudioSubscriptionState(true);

      expect(mockPub.setSubscribed).toHaveBeenCalledWith(false);
    });

    it("re-subscribes all audio when undeafened", () => {
      const mockPub = { setSubscribed: vi.fn() };
      const mockParticipant = {
        audioTrackPublications: new Map([["pub-1", mockPub]]),
      };
      const mockRoom = {
        remoteParticipants: new Map([["user-1", mockParticipant]]),
      } as any;
      elements.setRoom(mockRoom);

      elements.applyRemoteAudioSubscriptionState(false);

      expect(mockPub.setSubscribed).toHaveBeenCalledWith(true);
    });
  });

  describe("getEffectiveVolume", () => {
    it("returns 1.0 for default user with default multiplier", () => {
      expect(elements.getEffectiveVolume(42)).toBe(1.0);
    });

    it("returns outputVolumeMultiplier for userId <= 0", () => {
      // userId <= 0 uses default 100, so effective = (100/100) * multiplier
      expect(elements.getEffectiveVolume(0)).toBe(1.0);
      expect(elements.getEffectiveVolume(-1)).toBe(1.0);
    });

    it("scales with output volume multiplier", () => {
      elements.setOutputVolume(50);
      expect(elements.getEffectiveVolume(42)).toBe(0.5);
    });
  });

  describe("applyAllVolumes", () => {
    it("does not throw when no room is set", () => {
      expect(() => elements.applyAllVolumes()).not.toThrow();
    });

    it("applies effective volume to all remote participants", () => {
      const mockParticipant1 = { identity: "user-10", setVolume: vi.fn() };
      const mockParticipant2 = { identity: "user-20", setVolume: vi.fn() };
      const mockRoom = {
        remoteParticipants: new Map([
          ["user-10", mockParticipant1],
          ["user-20", mockParticipant2],
        ]),
      } as any;
      elements.setRoom(mockRoom);

      elements.applyAllVolumes();

      expect(mockParticipant1.setVolume).toHaveBeenCalledWith(1.0);
      expect(mockParticipant2.setVolume).toHaveBeenCalledWith(1.0);
    });
  });

  describe("handleTrackUnsubscribedAudio — screenshare", () => {
    it("removes screenshare audio elements and cleans up tracking", () => {
      const audioEl = document.createElement("audio");
      const { track } = createMockTrack("audio", "ss-track-1");
      track.detach = vi.fn(() => [audioEl]);
      const publication = { source: "screenShareAudio" };
      const participant = { identity: "user-42", setVolume: vi.fn() };

      // Set up screenshare elements manually
      (elements as any).screenshareAudioElements = new Map([[42, new Set([audioEl])]]);

      elements.handleTrackUnsubscribedAudio(track as any, publication as any, participant as any);

      expect(track.detach).toHaveBeenCalled();
      // Should clean up from tracking map
      expect((elements as any).screenshareAudioElements.has(42)).toBe(false);
    });

    it("handles screenshare unsubscribe when no audio elements are tracked", () => {
      const { track } = createMockTrack("audio", "ss-track-2");
      const publication = { source: "screenShareAudio" };
      const participant = { identity: "user-42", setVolume: vi.fn() };

      // No screenshare elements tracked
      expect(() => {
        elements.handleTrackUnsubscribedAudio(track as any, publication as any, participant as any);
      }).not.toThrow();
    });
  });

  describe("handleTrackSubscribedAudio — mic with undefined sid", () => {
    it("handles track with undefined sid gracefully", () => {
      const audioEl = document.createElement("audio");
      const track = {
        kind: "audio",
        sid: undefined,
        detach: vi.fn(() => [audioEl]),
        attach: vi.fn(() => audioEl),
      };
      const publication = { source: "microphone" };
      const participant = { identity: "user-42", setVolume: vi.fn() };

      expect(() => {
        elements.handleTrackSubscribedAudio(track as any, publication as any, participant as any);
      }).not.toThrow();
    });
  });

  describe("handleTrackSubscribedAudio — with saved output device", () => {
    it("calls setSinkId for mic audio when audioOutputDevice preference is set", () => {
      mockLoadPref.mockImplementation((key: string, defaultVal: unknown) => {
        if (key === "audioOutputDevice") return "device-123";
        return defaultVal;
      });

      const audioEl = document.createElement("audio");
      audioEl.setSinkId = vi.fn().mockResolvedValue(undefined);
      const track = {
        kind: "audio",
        sid: "track-dev-1",
        detach: vi.fn(() => [audioEl]),
        attach: vi.fn(() => audioEl),
      };
      const publication = { source: "microphone" };
      const participant = { identity: "user-42", setVolume: vi.fn() };

      elements.handleTrackSubscribedAudio(track as any, publication as any, participant as any);

      expect(audioEl.setSinkId).toHaveBeenCalledWith("device-123");
    });

    it("calls setSinkId for screenshare audio when audioOutputDevice preference is set", () => {
      mockLoadPref.mockImplementation((key: string, defaultVal: unknown) => {
        if (key === "audioOutputDevice") return "device-456";
        return defaultVal;
      });

      const audioEl = document.createElement("audio");
      audioEl.setSinkId = vi.fn().mockResolvedValue(undefined);
      const track = {
        kind: "audio",
        sid: "track-ss-dev-1",
        detach: vi.fn(() => [audioEl]),
        attach: vi.fn(() => audioEl),
      };
      const publication = { source: "screenShareAudio" };
      const participant = { identity: "user-42", setVolume: vi.fn() };

      elements.handleTrackSubscribedAudio(track as any, publication as any, participant as any);

      expect(audioEl.setSinkId).toHaveBeenCalledWith("device-456");
    });

    it("handles setSinkId failure gracefully for screenshare audio", () => {
      mockLoadPref.mockImplementation((key: string, defaultVal: unknown) => {
        if (key === "audioOutputDevice") return "bad-device";
        return defaultVal;
      });

      const audioEl = document.createElement("audio");
      audioEl.setSinkId = vi.fn().mockRejectedValue(new Error("Device not found"));
      const track = {
        kind: "audio",
        sid: "track-ss-err",
        detach: vi.fn(() => [audioEl]),
        attach: vi.fn(() => audioEl),
      };
      const publication = { source: "screenShareAudio" };
      const participant = { identity: "user-42", setVolume: vi.fn() };

      expect(() => {
        elements.handleTrackSubscribedAudio(track as any, publication as any, participant as any);
      }).not.toThrow();
    });

    it("handles setSinkId failure gracefully for mic audio", () => {
      mockLoadPref.mockImplementation((key: string, defaultVal: unknown) => {
        if (key === "audioOutputDevice") return "bad-device";
        return defaultVal;
      });

      const audioEl = document.createElement("audio");
      audioEl.setSinkId = vi.fn().mockRejectedValue(new Error("Device not found"));
      const track = {
        kind: "audio",
        sid: "track-mic-err",
        detach: vi.fn(() => [audioEl]),
        attach: vi.fn(() => audioEl),
      };
      const publication = { source: "microphone" };
      const participant = { identity: "user-42", setVolume: vi.fn() };

      expect(() => {
        elements.handleTrackSubscribedAudio(track as any, publication as any, participant as any);
      }).not.toThrow();
    });
  });

  describe("setUserVolume — without room", () => {
    it("saves volume even when no room is set", () => {
      elements.setUserVolume(42, 120);
      expect(mockSavePref).toHaveBeenCalledWith("userVolume_42", 120);
    });
  });

  describe("cleanupAllAudioElements", () => {
    it("does not throw when empty", () => {
      expect(() => elements.cleanupAllAudioElements()).not.toThrow();
    });

    it("removes all tracked audio elements", () => {
      const micEl = document.createElement("audio");
      const ssEl = document.createElement("audio");
      const removeMic = vi.spyOn(micEl, "remove");
      const removeSs = vi.spyOn(ssEl, "remove");

      (elements as any).remoteMicAudioElements = new Map([["track-1", micEl]]);
      (elements as any).screenshareAudioElements = new Map([[42, new Set([ssEl])]]);

      elements.cleanupAllAudioElements();

      expect(removeMic).toHaveBeenCalled();
      expect(removeSs).toHaveBeenCalled();
    });

    it("clears muted-by-user state", () => {
      elements.muteScreenshareAudio(42, true);
      elements.cleanupAllAudioElements();
      expect(elements.getScreenshareAudioMuted(42)).toBe(false);
    });
  });
});
