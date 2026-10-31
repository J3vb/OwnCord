import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as voiceSession from "../helpers/voiceSessionMock";

const { mockLoadPref, mockSavePref } = vi.hoisted(() => ({
  mockLoadPref: vi.fn((_key: string, defaultVal: unknown) => defaultVal),
  mockSavePref: vi.fn(),
}));

vi.mock("@lib/prefs/preferences", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lib/prefs/preferences")>()),
  STORAGE_PREFIX: "owncord:settings:",
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
  RoomEvent: { ActiveDeviceChanged: "activeDeviceChanged" },
  Track: {
    Source: {
      Microphone: "microphone",
      Camera: "camera",
      ScreenShare: "screenShare",
      ScreenShareAudio: "screenShareAudio",
    },
  },
}));

const mockVoiceStoreState = {
  localDeafened: false,
  currentChannelId: null as number | null,
};

vi.mock("@stores/voice.store", () => ({
  voiceStore: {
    getState: () => mockVoiceStoreState,
  },
}));

vi.mock("@lib/voice/livekitSession", () =>
  voiceSession.withOverrides({
    parseUserId: (identity: string) => {
      const match = identity.match(/^user-(\d+)$/);
      if (match !== null && match[1] !== undefined) return parseInt(match[1], 10);
      return 0;
    },
  }),
);

import { AudioElements, setAudioVolumeHost } from "../../src/lib/voice/audioElements";

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
    mockVoiceStoreState.localDeafened = false;
    mockVoiceStoreState.currentChannelId = null;
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

  describe("volume ceiling of 200%", () => {
    afterEach(() => {
      mockLoadPref.mockImplementation((_key: string, defaultVal: unknown) => defaultVal);
    });

    it("applies a saved 161% per-user volume as 1.0 without a gain node so the join does not throw", () => {
      mockLoadPref.mockImplementation((key: string, def: unknown) =>
        key === "userVolume_42" ? 161 : def,
      );
      const { track } = createMockTrack("audio", "track-1");
      const participant = {
        identity: "user-42",
        // LiveKit without webAudioMix sets HTMLMediaElement.volume, which throws above 1.
        setVolume: vi.fn((v: number) => {
          if (v > 1) throw new DOMException("volume out of range", "IndexSizeError");
        }),
      };

      expect(() =>
        elements.handleTrackSubscribedAudio(
          track as any,
          { source: "microphone" } as any,
          participant as any,
        ),
      ).not.toThrow();
      expect(participant.setVolume).toHaveBeenCalledWith(1);
      expect(elements.getUserVolume(42)).toBe(161);
    });

    it("loads a saved per-user volume above 200% as 200%", () => {
      mockLoadPref.mockImplementation((key: string, def: unknown) =>
        key === "userVolume_42" ? 250 : def,
      );
      expect(elements.getUserVolume(42)).toBe(200);
    });

    it("reads a saved output volume of 150% as a 1.5 multiplier", () => {
      mockLoadPref.mockImplementation((key: string, def: unknown) =>
        key === "outputVolume" ? 150 : def,
      );
      expect(new AudioElements().getEffectiveVolume(42)).toBe(1.5);
    });

    it("clamps a saved output volume above 200% when read", () => {
      mockLoadPref.mockImplementation((key: string, def: unknown) =>
        key === "outputVolume" ? 300 : def,
      );
      expect(new AudioElements().getEffectiveVolume(42)).toBe(2);
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

    it("does not leak the previously-attached element into the tracking set on a fast re-subscribe", () => {
      // LiveKit can fire TrackSubscribed for an already-attached screenshare-
      // audio track before the old TrackUnsubscribed lands (fast reconnect).
      // The same underlying track's detach() then returns the element from
      // the prior attach(), which the handler removes from the DOM but must
      // also drop from screenshareAudioElements — otherwise it lives on in
      // the Set forever.
      let lastEl: HTMLAudioElement | null = null;
      const track = {
        kind: "audio",
        sid: "track-ss-resub",
        attach: vi.fn(() => {
          const el = document.createElement("audio");
          lastEl = el;
          return el;
        }),
        detach: vi.fn(() => (lastEl === null ? [] : [lastEl])),
      };
      const publication = { source: "screenShareAudio" };
      const participant = { identity: "user-42", setVolume: vi.fn() };

      elements.handleTrackSubscribedAudio(track as any, publication as any, participant as any);
      const firstEl = lastEl as unknown as HTMLAudioElement;

      // Re-fire subscribe for the same track before any unsubscribe arrives.
      elements.handleTrackSubscribedAudio(track as any, publication as any, participant as any);
      const secondEl = lastEl as unknown as HTMLAudioElement;

      const trackedEls = (elements as any).screenshareAudioElements.get(
        42,
      ) as Set<HTMLAudioElement>;
      expect(trackedEls.has(firstEl)).toBe(false);
      expect(trackedEls.has(secondEl)).toBe(true);
      expect(trackedEls.size).toBe(1);
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
      elements.setUserVolume(42, 70);
      expect(mockSavePref).toHaveBeenCalledWith("userVolume_42", 70);
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

  describe("per-user volume — host scoping", () => {
    afterEach(() => {
      // currentHost is module-level state that outlives a single test.
      setAudioVolumeHost(null);
    });

    it("falls back to the legacy unscoped key when no host is set", () => {
      elements.setUserVolume(42, 70);
      expect(mockSavePref).toHaveBeenCalledWith("userVolume_42", 70);
    });

    it("scopes the saved-volume key to the current host", () => {
      setAudioVolumeHost("a.example.com");
      elements.setUserVolume(42, 70);
      expect(mockSavePref).toHaveBeenCalledWith("userVolume_42:a.example.com", 70);
    });

    it("reads the volume back under the scoped key, not the unscoped one", () => {
      setAudioVolumeHost("a.example.com");
      elements.getUserVolume(42);
      expect(mockLoadPref).toHaveBeenCalledWith("userVolume_42:a.example.com", 100);
    });

    it("does not leak a volume set on one host onto another", () => {
      // Regression for B3-6: a mute (volume 0) set for user 7 on server A
      // must not silence user 7 on server B.
      mockLoadPref.mockImplementation((key: string, defaultVal: unknown) => {
        if (key === "userVolume_7:a.example.com") return 0;
        return defaultVal;
      });

      setAudioVolumeHost("a.example.com");
      expect(elements.getUserVolume(7)).toBe(0);

      setAudioVolumeHost("b.example.com");
      expect(elements.getUserVolume(7)).toBe(100);
    });

    /** loadPref as the real one behaves, so the scoped copies the migration
     *  writes straight to localStorage read back. */
    function loadPrefFromStorage(key: string, defaultVal: unknown): unknown {
      const raw = localStorage.getItem(`owncord:settings:${key}`);
      return raw === null ? defaultVal : (JSON.parse(raw) as unknown);
    }

    function clearVolumeKeys(): void {
      for (const key of [
        "owncord:settings:userVolume_7",
        "owncord:settings:userVolume_7:a.example.com",
        "owncord:settings:userVolume_7:b.example.com",
        "owncord:legacy-claim:owncord:settings:userVolume_7",
      ]) {
        localStorage.removeItem(key);
      }
    }

    it("migrates a pre-scoping legacy volume through to the scoped key without leaking to a different host", () => {
      // A save made before host-scoping existed lives at the bare
      // `userVolume_7` key. It must still apply once a host is set, and the
      // migration must write under THAT host's scoped key specifically —
      // not clobber a different host's own explicit choice.
      localStorage.setItem("owncord:settings:userVolume_7", "30");
      localStorage.setItem("owncord:settings:userVolume_7:b.example.com", "80");
      mockLoadPref.mockImplementation(loadPrefFromStorage);

      try {
        setAudioVolumeHost("a.example.com");
        expect(elements.getUserVolume(7)).toBe(30);
        expect(localStorage.getItem("owncord:settings:userVolume_7:a.example.com")).toBe("30");

        setAudioVolumeHost("b.example.com");
        expect(elements.getUserVolume(7)).toBe(80);
      } finally {
        clearVolumeKeys();
      }
    });

    it("consumes the legacy key on migration so a later host does not inherit it", () => {
      // The pre-scoping `userVolume_7` value must reach the first host
      // exactly once. A later brand-new host has no scoped value of its own
      // and must fall through to the 100 default — not adopt server A's
      // volume (a 0 here is a silenced, unrelated user 7 on server B).
      localStorage.setItem("owncord:settings:userVolume_7", "0");
      mockLoadPref.mockImplementation(loadPrefFromStorage);

      try {
        setAudioVolumeHost("a.example.com");
        expect(elements.getUserVolume(7)).toBe(0);
        expect(localStorage.getItem("owncord:settings:userVolume_7:a.example.com")).toBe("0");
        expect(localStorage.getItem("owncord:settings:userVolume_7")).toBeNull();

        setAudioVolumeHost("b.example.com");
        expect(elements.getUserVolume(7)).toBe(100);
        expect(localStorage.getItem("owncord:settings:userVolume_7:b.example.com")).toBeNull();
      } finally {
        clearVolumeKeys();
      }
    });

    it("binds the legacy key to the first host when the scoped copy could not be written", () => {
      // Storage at quota: the scoped write throws. The value was read fine,
      // so it must still apply, and the legacy key must survive for a later
      // attempt — bound to server A, so the unrelated user 7 on server B
      // neither inherits nor consumes it in the meantime.
      localStorage.setItem("owncord:settings:userVolume_7", "0");
      mockLoadPref.mockImplementation(loadPrefFromStorage);
      const realSetItem = Storage.prototype.setItem;
      const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
        this: Storage,
        key: string,
        value: string,
      ) {
        if (key === "owncord:settings:userVolume_7:a.example.com") {
          throw new DOMException("quota exceeded", "QuotaExceededError");
        }
        realSetItem.call(this, key, value);
      });

      try {
        setAudioVolumeHost("a.example.com");
        expect(elements.getUserVolume(7)).toBe(0);
        expect(localStorage.getItem("owncord:settings:userVolume_7:a.example.com")).toBeNull();
        expect(localStorage.getItem("owncord:settings:userVolume_7")).toBe("0");
        expect(localStorage.getItem("owncord:legacy-claim:owncord:settings:userVolume_7")).toBe(
          "owncord:settings:userVolume_7:a.example.com",
        );

        setAudioVolumeHost("b.example.com");
        expect(elements.getUserVolume(7)).toBe(100);
        expect(localStorage.getItem("owncord:settings:userVolume_7:b.example.com")).toBeNull();
        expect(localStorage.getItem("owncord:settings:userVolume_7")).toBe("0");

        // Quota relieved: server A's next read completes the migration.
        setItem.mockRestore();
        setAudioVolumeHost("a.example.com");
        expect(elements.getUserVolume(7)).toBe(0);
        expect(localStorage.getItem("owncord:settings:userVolume_7:a.example.com")).toBe("0");
        expect(localStorage.getItem("owncord:settings:userVolume_7")).toBeNull();
        expect(
          localStorage.getItem("owncord:legacy-claim:owncord:settings:userVolume_7"),
        ).toBeNull();
      } finally {
        setItem.mockRestore();
        clearVolumeKeys();
      }
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

    it("getScreenshareAudioVolume defaults to 1 and reflects stored value", () => {
      expect(elements.getScreenshareAudioVolume(42)).toBe(1);
      elements.setScreenshareAudioVolume(42, 0.4);
      expect(elements.getScreenshareAudioVolume(42)).toBe(0.4);
    });

    it("volume chosen before the track attaches applies on attach", () => {
      elements.setScreenshareAudioVolume(42, 0.25);

      const { track, audioEl } = createMockTrack("audio", "track-ss-early");
      const publication = { source: "screenShareAudio" };
      const participant = { identity: "user-42", setVolume: vi.fn() };
      elements.handleTrackSubscribedAudio(track as any, publication as any, participant as any);

      expect(audioEl.volume).toBe(0.25);
    });

    it("setOutputVolume preserves per-user screenshare volume", () => {
      const audioEl = document.createElement("audio");
      (elements as any).screenshareAudioElements = new Map([[42, new Set([audioEl])]]);

      elements.setScreenshareAudioVolume(42, 0.5);
      elements.setOutputVolume(50);

      expect(audioEl.volume).toBe(0.25); // 0.5 user * 0.5 master
    });

    it("setScreenshareAudioVolume scales by the master output multiplier", () => {
      const audioEl = document.createElement("audio");
      (elements as any).screenshareAudioElements = new Map([[42, new Set([audioEl])]]);

      elements.setOutputVolume(50);
      elements.setScreenshareAudioVolume(42, 0.8);

      expect(audioEl.volume).toBe(0.4); // 0.8 user * 0.5 master
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

    it("getScreenshareAudioMuted does not read a deafen-muted element as the tile's own mute", () => {
      // The element's muted flag also carries deafen, so it is not the
      // user's choice; only muteScreenshareAudio sets that.
      const audioEl = document.createElement("audio");
      audioEl.muted = true;
      (elements as any).screenshareAudioElements = new Map([[42, new Set([audioEl])]]);

      expect(elements.getScreenshareAudioMuted(42)).toBe(false);
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

    it("unsubscribes voice audio when deafened", () => {
      const mockPub = { source: "microphone", setSubscribed: vi.fn() };
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

    it("re-subscribes voice audio when undeafened", () => {
      const mockPub = { source: "microphone", setSubscribed: vi.fn() };
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

    it("does not re-subscribe a voice published without end-to-end encryption on undeafen", () => {
      const mockPub = {
        source: "microphone",
        setSubscribed: vi.fn(),
        // Encryption_Type.NONE
        trackInfo: { encryption: 0 },
      };
      const mockRoom = {
        remoteParticipants: new Map([
          ["user-1", { audioTrackPublications: new Map([["pub-1", mockPub]]) }],
        ]),
      } as never;
      elements.setRoom(mockRoom);

      elements.applyRemoteAudioSubscriptionState(false);

      expect(mockPub.setSubscribed).not.toHaveBeenCalled();
    });

    it("keeps screenshare audio subscribed when deafened (it is muted, not unsubscribed)", () => {
      // Deafen silences stream audio by muting its elements, so undeafen
      // brings it back without a resubscribe.
      const micPub = { source: "microphone", setSubscribed: vi.fn() };
      const streamPub = { source: "screenShareAudio", setSubscribed: vi.fn() };
      const mockParticipant = {
        audioTrackPublications: new Map([
          ["pub-mic", micPub],
          ["pub-stream", streamPub],
        ]),
      };
      const mockRoom = {
        remoteParticipants: new Map([["user-1", mockParticipant]]),
      } as any;
      elements.setRoom(mockRoom);

      elements.applyRemoteAudioSubscriptionState(true);

      expect(micPub.setSubscribed).toHaveBeenCalledWith(false);
      expect(streamPub.setSubscribed).not.toHaveBeenCalled();
    });
  });

  describe("deafen silences stream audio", () => {
    function attachStream(userId: number): HTMLAudioElement {
      const { track, audioEl } = createMockTrack("audio", `track-ss-${userId}`);
      const publication = { source: "screenShareAudio", setSubscribed: vi.fn() };
      const participant = { identity: `user-${userId}`, setVolume: vi.fn() };
      elements.handleTrackSubscribedAudio(track as any, publication as any, participant as any);
      return audioEl;
    }

    it("deafen mutes the stream element and undeafen unmutes it", () => {
      const audioEl = attachStream(42);
      expect(audioEl.muted).toBe(false);

      mockVoiceStoreState.localDeafened = true;
      elements.applyRemoteAudioSubscriptionState(true);
      expect(audioEl.muted).toBe(true);

      mockVoiceStoreState.localDeafened = false;
      elements.applyRemoteAudioSubscriptionState(false);
      expect(audioEl.muted).toBe(false);
    });

    it("undeafen restores each stream to its own mute state", () => {
      const mutedEl = attachStream(42);
      const openEl = attachStream(43);
      elements.muteScreenshareAudio(42, true);

      mockVoiceStoreState.localDeafened = true;
      elements.applyRemoteAudioSubscriptionState(true);
      expect(mutedEl.muted).toBe(true);
      expect(openEl.muted).toBe(true);

      mockVoiceStoreState.localDeafened = false;
      elements.applyRemoteAudioSubscriptionState(false);
      expect(mutedEl.muted).toBe(true);
      expect(openEl.muted).toBe(false);
      expect(elements.getScreenshareAudioMuted(42)).toBe(true);
      expect(elements.getScreenshareAudioMuted(43)).toBe(false);
    });

    it("unmuting a stream tile while deafened keeps it silent until undeafen", () => {
      const audioEl = attachStream(42);
      elements.muteScreenshareAudio(42, true);
      mockVoiceStoreState.localDeafened = true;
      elements.applyRemoteAudioSubscriptionState(true);

      elements.muteScreenshareAudio(42, false);
      expect(audioEl.muted).toBe(true);
      expect(elements.getScreenshareAudioMuted(42)).toBe(false);

      mockVoiceStoreState.localDeafened = false;
      elements.applyRemoteAudioSubscriptionState(false);
      expect(audioEl.muted).toBe(false);
    });

    it("a stream that attaches while deafened starts muted", () => {
      mockVoiceStoreState.localDeafened = true;
      const audioEl = attachStream(42);
      expect(audioEl.muted).toBe(true);
      expect(elements.getScreenshareAudioMuted(42)).toBe(false);
    });

    it("the native room's stream gain is 0 while deafened and is told on each change", () => {
      const listener = vi.fn();
      elements.setScreenshareGainListener(listener);
      expect(elements.getScreenshareGain(42)).toBe(1);

      mockVoiceStoreState.localDeafened = true;
      elements.applyRemoteAudioSubscriptionState(true);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(elements.getScreenshareGain(42)).toBe(0);

      mockVoiceStoreState.localDeafened = false;
      elements.applyRemoteAudioSubscriptionState(false);
      expect(listener).toHaveBeenCalledTimes(2);
      expect(elements.getScreenshareGain(42)).toBe(1);
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
      elements.setUserVolume(42, 80);
      expect(mockSavePref).toHaveBeenCalledWith("userVolume_42", 80);
    });
  });

  describe("deafen guard — handleTrackSubscribedAudio", () => {
    it("does not attach mic audio when locally deafened", () => {
      mockVoiceStoreState.localDeafened = true;

      const { track } = createMockTrack("audio", "track-deaf-1");
      const publication = { source: "microphone", setSubscribed: vi.fn() };
      const participant = { identity: "user-42", setVolume: vi.fn() };

      elements.handleTrackSubscribedAudio(track as any, publication as any, participant as any);

      // Should NOT attach any audio element
      expect(track.attach).not.toHaveBeenCalled();
      // Should unsubscribe the publication
      expect(publication.setSubscribed).toHaveBeenCalledWith(false);
    });

    it("attaches screenshare audio muted when locally deafened", () => {
      // Stream audio stays subscribed while deafened and plays muted, so
      // undeafen needs no resubscribe.
      mockVoiceStoreState.localDeafened = true;

      const { track, audioEl } = createMockTrack("audio", "track-deaf-ss");
      const publication = { source: "screenShareAudio", setSubscribed: vi.fn() };
      const participant = { identity: "user-42", setVolume: vi.fn() };

      elements.handleTrackSubscribedAudio(track as any, publication as any, participant as any);

      expect(track.attach).toHaveBeenCalled();
      expect(publication.setSubscribed).not.toHaveBeenCalled();
      expect(audioEl.muted).toBe(true);
    });

    it("attaches mic audio normally when not deafened", () => {
      mockVoiceStoreState.localDeafened = false;

      const { track } = createMockTrack("audio", "track-ok-1");
      const publication = { source: "microphone", setSubscribed: vi.fn() };
      const participant = { identity: "user-42", setVolume: vi.fn() };

      elements.handleTrackSubscribedAudio(track as any, publication as any, participant as any);

      expect(track.attach).toHaveBeenCalled();
      expect(publication.setSubscribed).not.toHaveBeenCalled();
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

    it("preserves muted-by-user state for reconnecting tracks", () => {
      elements.muteScreenshareAudio(42, true);
      elements.cleanupAllAudioElements();
      expect(elements.getScreenshareAudioMuted(42)).toBe(true);
    });

    it("clears muted-by-user state with full cleanup", () => {
      elements.muteScreenshareAudio(42, true);
      elements.cleanupAllAudioElementsFull();
      expect(elements.getScreenshareAudioMuted(42)).toBe(false);
    });
  });

  describe("gain node above 100%", () => {
    class FakeGain {
      gain = { value: 1 };
      connect = vi.fn();
      disconnect = vi.fn();
    }
    class FakeSource {
      connect = vi.fn();
      disconnect = vi.fn();
    }
    class FakeAudioContext {
      static instances: FakeAudioContext[] = [];
      static initialState = "running";
      state = FakeAudioContext.initialState;
      destination = {};
      gains: FakeGain[] = [];
      sources: FakeSource[] = [];
      setSinkId = vi.fn(async () => undefined);
      resume = vi.fn(async () => undefined);
      private stateListeners: Array<() => void> = [];
      addEventListener = vi.fn((_type: string, fn: () => void) => this.stateListeners.push(fn));
      setState(state: string): void {
        this.state = state;
        for (const fn of this.stateListeners) fn();
      }
      close = vi.fn(async () => {
        this.state = "closed";
      });
      constructor() {
        FakeAudioContext.instances.push(this);
      }
      createMediaStreamSource(): FakeSource {
        const src = new FakeSource();
        this.sources.push(src);
        return src;
      }
      createGain(): FakeGain {
        const g = new FakeGain();
        this.gains.push(g);
        return g;
      }
    }

    function makeRoom(
      participants: Array<{ identity: string; setVolume: ReturnType<typeof vi.fn> }>,
    ) {
      const listeners = new Map<string, (...args: unknown[]) => void>();
      return {
        remoteParticipants: new Map(participants.map((p) => [p.identity, p])),
        on: vi.fn((event: string, fn: (...args: unknown[]) => void) => listeners.set(event, fn)),
        off: vi.fn(),
        emit: (event: string, ...args: unknown[]) => listeners.get(event)?.(...args),
      };
    }

    function webParticipant(identity: string) {
      return {
        identity,
        setVolume: vi.fn((v: number) => {
          if (v > 1) throw new DOMException("volume out of range", "IndexSizeError");
        }),
      };
    }

    beforeEach(() => {
      FakeAudioContext.instances = [];
      FakeAudioContext.initialState = "running";
      vi.stubGlobal("AudioContext", FakeAudioContext);
      vi.stubGlobal(
        "MediaStream",
        class {
          constructor(public tracks: unknown[]) {}
        },
      );
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      mockLoadPref.mockImplementation((_key: string, defaultVal: unknown) => defaultVal);
    });

    function subscribe(participant: { identity: string }, sid = "mic-1") {
      const { track, audioEl } = createMockTrack("audio", sid);
      (track as any).mediaStreamTrack = { id: sid };
      elements.handleTrackSubscribedAudio(
        track as any,
        { source: "microphone" } as any,
        participant as any,
      );
      return { track, audioEl };
    }

    it("at or below 100% the element plays the voice and no context opens", () => {
      const participant = webParticipant("user-42");
      elements.setRoom(makeRoom([participant]) as any);
      const { audioEl } = subscribe(participant);

      elements.setUserVolume(42, 80);

      expect(FakeAudioContext.instances).toHaveLength(0);
      expect(participant.setVolume).toHaveBeenLastCalledWith(0.8);
      expect(audioEl.muted).toBe(false);
    });

    it("user 150% plays through a gain node at 1.5 with the element muted", () => {
      const participant = webParticipant("user-42");
      elements.setRoom(makeRoom([participant]) as any);
      const { audioEl } = subscribe(participant);
      participant.setVolume.mockClear();

      elements.setUserVolume(42, 150);

      const ctx = FakeAudioContext.instances[0]!;
      expect(ctx.gains[0]!.gain.value).toBe(1.5);
      expect(audioEl.muted).toBe(true);
      expect(participant.setVolume).not.toHaveBeenCalled();
    });

    it("back at 100% the track returns to its element", () => {
      const participant = webParticipant("user-42");
      elements.setRoom(makeRoom([participant]) as any);
      const { audioEl } = subscribe(participant);
      elements.setUserVolume(42, 150);
      const gain = FakeAudioContext.instances[0]!.gains[0]!;

      elements.setUserVolume(42, 100);

      expect(gain.disconnect).toHaveBeenCalled();
      expect(audioEl.muted).toBe(false);
      expect(participant.setVolume).toHaveBeenLastCalledWith(1);
    });

    it("a saved boost routes a newly subscribed track through its gain node", () => {
      mockLoadPref.mockImplementation((key: string, def: unknown) =>
        key === "userVolume_42" ? 150 : def,
      );
      const participant = webParticipant("user-42");
      elements.setRoom(makeRoom([participant]) as any);
      const { audioEl } = subscribe(participant);

      expect(FakeAudioContext.instances[0]!.gains[0]!.gain.value).toBe(1.5);
      expect(audioEl.muted).toBe(true);
    });

    it("diagnostics report the gain node's level, not the muted element's", () => {
      const participant = { ...webParticipant("user-42"), getVolume: vi.fn(() => 1) };
      elements.setRoom(makeRoom([participant]) as any);
      expect(elements.getPlayingVolume(participant as any)).toBe(1);
      subscribe(participant);
      elements.setUserVolume(42, 150);
      expect(elements.getPlayingVolume(participant as any)).toBe(1.5);
    });

    it("keeps a graph-routed element silent after Room.startAudio() unmutes it", () => {
      const participant = webParticipant("user-42");
      elements.setRoom(makeRoom([participant]) as any);
      const { audioEl } = subscribe(participant);
      elements.setUserVolume(42, 150);

      // What livekit's startAudio does to every attached element without webAudioMix.
      audioEl.muted = false;

      expect(audioEl.volume).toBe(0);
    });

    it("moves a boosted track onto its gain node once a suspended context starts running", () => {
      FakeAudioContext.initialState = "suspended";
      mockLoadPref.mockImplementation((key: string, def: unknown) =>
        key === "userVolume_42" ? 150 : def,
      );
      const participant = webParticipant("user-42");
      elements.setRoom(makeRoom([participant]) as any);
      const { audioEl } = subscribe(participant);
      const ctx = FakeAudioContext.instances[0]!;
      expect(ctx.gains).toHaveLength(0);
      expect(participant.setVolume).toHaveBeenLastCalledWith(1);

      ctx.setState("running");

      expect(ctx.gains).toHaveLength(1);
      expect(ctx.gains[0]!.gain.value).toBe(1.5);
      expect(audioEl.muted).toBe(true);
    });

    it("hands tracks back to their elements when a running context suspends", () => {
      const participant = webParticipant("user-42");
      elements.setRoom(makeRoom([participant]) as any);
      const { audioEl } = subscribe(participant);
      elements.setUserVolume(42, 150);
      const ctx = FakeAudioContext.instances[0]!;
      expect(audioEl.muted).toBe(true);

      ctx.setState("suspended");

      expect(ctx.gains[0]!.disconnect).toHaveBeenCalled();
      expect(audioEl.muted).toBe(false);
      expect(participant.setVolume).toHaveBeenLastCalledWith(1);
    });

    it("a running context leaves a user at 100% on their element while another is boosted", () => {
      FakeAudioContext.initialState = "suspended";
      mockLoadPref.mockImplementation((key: string, def: unknown) =>
        key === "userVolume_42" ? 150 : def,
      );
      const boosted = webParticipant("user-42");
      const plain = webParticipant("user-7");
      elements.setRoom(makeRoom([boosted, plain]) as any);
      subscribe(boosted, "mic-42");
      const { audioEl } = subscribe(plain, "mic-7");
      const ctx = FakeAudioContext.instances[0]!;

      ctx.setState("running");

      expect(ctx.gains).toHaveLength(1);
      expect(ctx.gains[0]!.gain.value).toBe(1.5);
      expect(audioEl.muted).toBe(false);
      expect(plain.setVolume).toHaveBeenLastCalledWith(1);
    });

    it("a context opened after a device fallback plays on the room's active output", () => {
      mockLoadPref.mockImplementation((key: string, def: unknown) => {
        if (key === "audioOutputDevice") return "unplugged-headset";
        return key === "userVolume_42" ? 150 : def;
      });
      const participant = webParticipant("user-42");
      const room = { ...makeRoom([participant]), getActiveDevice: vi.fn(() => "default") };
      elements.setRoom(room as any);
      subscribe(participant);

      expect(FakeAudioContext.instances[0]!.setSinkId).toHaveBeenCalledWith("");
    });

    it("keeps boosted voice on its element while the context cannot reach the chosen output", async () => {
      mockLoadPref.mockImplementation((key: string, def: unknown) => {
        if (key === "audioOutputDevice") return "headset-1";
        return key === "userVolume_42" ? 150 : def;
      });
      vi.stubGlobal(
        "AudioContext",
        class extends FakeAudioContext {
          override setSinkId = vi.fn(async () => {
            throw new Error("no such device");
          });
        },
      );
      const participant = webParticipant("user-42");
      elements.setRoom(makeRoom([participant]) as any);
      const { audioEl } = subscribe(participant);
      const ctx = FakeAudioContext.instances[0]!;

      // The switch is still pending: the element plays, at most 100%.
      expect(ctx.gains).toHaveLength(0);
      expect(participant.setVolume).toHaveBeenLastCalledWith(1);
      expect(audioEl.muted).toBe(false);
      await Promise.resolve();
      await Promise.resolve();
      expect(ctx.gains).toHaveLength(0);
    });

    it("moves boosted voice onto its gain node once the chosen output is set", async () => {
      mockLoadPref.mockImplementation((key: string, def: unknown) => {
        if (key === "audioOutputDevice") return "headset-1";
        return key === "userVolume_42" ? 150 : def;
      });
      const participant = webParticipant("user-42");
      elements.setRoom(makeRoom([participant]) as any);
      const { audioEl } = subscribe(participant);
      const ctx = FakeAudioContext.instances[0]!;
      expect(ctx.gains).toHaveLength(0);

      await Promise.resolve();
      await Promise.resolve();

      expect(ctx.gains).toHaveLength(1);
      expect(ctx.gains[0]!.gain.value).toBe(1.5);
      expect(audioEl.muted).toBe(true);
    });

    it("never boosts on a context that cannot change output while another one is chosen", () => {
      mockLoadPref.mockImplementation((key: string, def: unknown) => {
        if (key === "audioOutputDevice") return "headset-1";
        return key === "userVolume_42" ? 150 : def;
      });
      vi.stubGlobal(
        "AudioContext",
        class extends FakeAudioContext {
          override setSinkId = undefined as unknown as FakeAudioContext["setSinkId"];
        },
      );
      const participant = webParticipant("user-42");
      elements.setRoom(makeRoom([participant]) as any);
      subscribe(participant);

      expect(FakeAudioContext.instances[0]!.gains).toHaveLength(0);
      expect(participant.setVolume).toHaveBeenLastCalledWith(1);
    });

    it("caps user 200% × output 200% at a gain of 2", () => {
      const participant = webParticipant("user-42");
      elements.setRoom(makeRoom([participant]) as any);
      subscribe(participant);

      elements.setUserVolume(42, 200);
      elements.setOutputVolume(200);

      expect(FakeAudioContext.instances[0]!.gains[0]!.gain.value).toBe(2);
    });

    it("never calls a web participant's setVolume above 1 when the context is not running", () => {
      FakeAudioContext.initialState = "suspended";
      const participant = webParticipant("user-42");
      elements.setRoom(makeRoom([participant]) as any);
      mockLoadPref.mockImplementation((key: string, def: unknown) =>
        key === "userVolume_42" ? 150 : def,
      );

      const { audioEl } = subscribe(participant);

      expect(participant.setVolume).toHaveBeenCalledWith(1);
      expect(audioEl.muted).toBe(false);
    });

    it("gives the native mixer an unclamped gain", () => {
      const participant = { identity: "user-42", setVolume: vi.fn() };
      const room = { ...makeRoom([participant]), nativePlayout: true };
      elements.setRoom(room as any);
      subscribe(participant);

      elements.setUserVolume(42, 150);

      expect(participant.setVolume).toHaveBeenLastCalledWith(1.5);
      expect(FakeAudioContext.instances).toHaveLength(0);
    });

    it("Mute silences the voice, keeps the volume, and unmute restores it", () => {
      const store = new Map<string, unknown>();
      mockLoadPref.mockImplementation((key: string, def: unknown) =>
        store.has(key) ? store.get(key) : def,
      );
      mockSavePref.mockImplementation((key: string, val: unknown) => store.set(key, val));
      const participant = webParticipant("user-42");
      elements.setRoom(makeRoom([participant]) as any);
      const { audioEl } = subscribe(participant);
      elements.setUserVolume(42, 150);
      const boosted = FakeAudioContext.instances[0]!.gains[0]!;

      elements.setUserLocalMute(42, true);
      expect(participant.setVolume).toHaveBeenLastCalledWith(0);
      expect(boosted.disconnect).toHaveBeenCalled();
      expect(audioEl.muted).toBe(false);
      expect(elements.getUserLocalMute(42)).toBe(true);
      expect(elements.getUserVolume(42)).toBe(150);

      elements.setUserLocalMute(42, false);
      const ctx = FakeAudioContext.instances[0]!;
      expect(ctx.gains.at(-1)!.gain.value).toBe(1.5);
      mockSavePref.mockReset();
    });

    it("announces a Mute change on the window", () => {
      const seen: unknown[] = [];
      const onChange = (e: Event): void => {
        seen.push((e as CustomEvent).detail);
      };
      window.addEventListener("owncord:user-local-mute-changed", onChange);
      elements.setUserLocalMute(7, true);
      window.removeEventListener("owncord:user-local-mute-changed", onChange);
      expect(seen).toEqual([{ userId: 7 }]);
    });

    it("scopes the Mute pref to the current host", () => {
      setAudioVolumeHost("a.example:8443");
      try {
        elements.setUserLocalMute(7, true);
        expect(mockSavePref).toHaveBeenCalledWith("userLocalMute_7:a.example:8443", true);
      } finally {
        setAudioVolumeHost(null);
      }
    });

    it("unsubscribe and cleanup disconnect the gain graph", () => {
      mockLoadPref.mockImplementation((key: string, def: unknown) =>
        key === "userVolume_42" ? 150 : def,
      );
      const participant = webParticipant("user-42");
      elements.setRoom(makeRoom([participant]) as any);
      const { track } = subscribe(participant);
      const ctx = FakeAudioContext.instances[0]!;

      elements.handleTrackUnsubscribedAudio(
        track as any,
        { source: "microphone" } as any,
        participant as any,
      );
      expect(ctx.sources[0]!.disconnect).toHaveBeenCalled();
      expect(ctx.gains[0]!.disconnect).toHaveBeenCalled();

      subscribe(participant, "mic-2");
      elements.cleanupAllAudioElements();
      expect(ctx.gains[1]!.disconnect).toHaveBeenCalled();
    });

    it("a fast re-subscribe drops the old graph before building a new one", () => {
      mockLoadPref.mockImplementation((key: string, def: unknown) =>
        key === "userVolume_42" ? 150 : def,
      );
      const participant = webParticipant("user-42");
      elements.setRoom(makeRoom([participant]) as any);
      subscribe(participant);
      subscribe(participant);
      const ctx = FakeAudioContext.instances[0]!;
      expect(ctx.gains[0]!.disconnect).toHaveBeenCalled();
      expect(ctx.gains[1]!.disconnect).not.toHaveBeenCalled();
    });

    it("the context follows the saved and switched output device", () => {
      mockLoadPref.mockImplementation((key: string, def: unknown) => {
        if (key === "audioOutputDevice") return "speakers-1";
        return key === "userVolume_42" ? 150 : def;
      });
      const participant = webParticipant("user-42");
      const room = makeRoom([participant]);
      elements.setRoom(room as any);
      subscribe(participant);
      const ctx = FakeAudioContext.instances[0]!;
      expect(ctx.setSinkId).toHaveBeenCalledWith("speakers-1");

      room.emit("activeDeviceChanged", "audiooutput", "headset-2");
      expect(ctx.setSinkId).toHaveBeenLastCalledWith("headset-2");

      room.emit("activeDeviceChanged", "audiooutput", "default");
      expect(ctx.setSinkId).toHaveBeenLastCalledWith("");

      room.emit("activeDeviceChanged", "audioinput", "mic-9");
      expect(ctx.setSinkId).toHaveBeenCalledTimes(3);
    });

    it("leaving closes the context", () => {
      const participant = webParticipant("user-42");
      elements.setRoom(makeRoom([participant]) as any);
      subscribe(participant);
      elements.setUserVolume(42, 150);
      const ctx = FakeAudioContext.instances[0]!;
      elements.setRoom(null);
      expect(ctx.close).toHaveBeenCalled();
    });
  });
});
