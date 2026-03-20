import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const {
  mockVoiceStoreGetState,
  mockJoinVoiceChannel,
  mockLeaveVoiceChannel,
  mockSetLocalScreenshare,
  mockVoiceSessionLeave,
  mockSetMuted,
  mockSetDeafened,
  mockEnableCamera,
  mockDisableCamera,
} = vi.hoisted(() => ({
  mockVoiceStoreGetState: vi.fn(),
  mockJoinVoiceChannel: vi.fn(),
  mockLeaveVoiceChannel: vi.fn(),
  mockSetLocalScreenshare: vi.fn(),
  mockVoiceSessionLeave: vi.fn(),
  mockSetMuted: vi.fn(),
  mockSetDeafened: vi.fn(),
  mockEnableCamera: vi.fn(() => Promise.resolve()),
  mockDisableCamera: vi.fn(() => Promise.resolve()),
}));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("@stores/voice.store", () => ({
  voiceStore: { getState: mockVoiceStoreGetState },
  joinVoiceChannel: mockJoinVoiceChannel,
  leaveVoiceChannel: mockLeaveVoiceChannel,
  setLocalScreenshare: mockSetLocalScreenshare,
}));

vi.mock("@lib/voiceSession", () => ({
  leaveVoice: mockVoiceSessionLeave,
  setMuted: mockSetMuted,
  setDeafened: mockSetDeafened,
  enableCamera: mockEnableCamera,
  disableCamera: mockDisableCamera,
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import {
  createVoiceWidgetCallbacks,
  createSidebarVoiceCallbacks,
} from "../../src/pages/main-page/VoiceCallbacks";
import type { WsClient } from "../../src/lib/ws";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWs(): WsClient {
  return { send: vi.fn() } as unknown as WsClient;
}

function makeLimiters(voiceAllowed = true, videoAllowed = true) {
  return {
    voice: { tryConsume: vi.fn(() => voiceAllowed) },
    voiceVideo: { tryConsume: vi.fn(() => videoAllowed) },
  };
}

interface VoiceStateStub {
  currentChannelId: number | null;
  localMuted: boolean;
  localDeafened: boolean;
  localCamera: boolean;
  localScreenshare: boolean;
}

function makeVoiceState(overrides: Partial<VoiceStateStub> = {}): VoiceStateStub {
  return {
    currentChannelId: 10,
    localMuted: false,
    localDeafened: false,
    localCamera: false,
    localScreenshare: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Voice Widget Callbacks
// ---------------------------------------------------------------------------

describe("createVoiceWidgetCallbacks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVoiceStoreGetState.mockReturnValue(makeVoiceState());
  });

  describe("onDisconnect", () => {
    it("sends voice_leave and cleans up", () => {
      const ws = makeWs();
      const cbs = createVoiceWidgetCallbacks(ws, makeLimiters());

      cbs.onDisconnect();

      expect(mockVoiceSessionLeave).toHaveBeenCalledWith(false);
      expect(mockLeaveVoiceChannel).toHaveBeenCalled();
      expect(ws.send).toHaveBeenCalledWith({ type: "voice_leave", payload: {} });
    });

    it("does nothing when not in a voice channel", () => {
      mockVoiceStoreGetState.mockReturnValue(makeVoiceState({ currentChannelId: null }));
      const ws = makeWs();
      const cbs = createVoiceWidgetCallbacks(ws, makeLimiters());

      cbs.onDisconnect();

      expect(ws.send).not.toHaveBeenCalled();
    });
  });

  describe("onMuteToggle", () => {
    it("mutes when unmuted", () => {
      const ws = makeWs();
      const cbs = createVoiceWidgetCallbacks(ws, makeLimiters());

      cbs.onMuteToggle();

      expect(mockSetMuted).toHaveBeenCalledWith(true);
      expect(ws.send).toHaveBeenCalledWith({ type: "voice_mute", payload: { muted: true } });
    });

    it("unmutes and undeafens when muted+deafened", () => {
      mockVoiceStoreGetState.mockReturnValue(
        makeVoiceState({ localMuted: true, localDeafened: true }),
      );
      const ws = makeWs();
      const cbs = createVoiceWidgetCallbacks(ws, makeLimiters());

      cbs.onMuteToggle();

      expect(mockSetMuted).toHaveBeenCalledWith(false);
      expect(mockSetDeafened).toHaveBeenCalledWith(false);
      expect(ws.send).toHaveBeenCalledWith({ type: "voice_deafen", payload: { deafened: false } });
      expect(ws.send).toHaveBeenCalledWith({ type: "voice_mute", payload: { muted: false } });
    });

    it("respects rate limiter", () => {
      const ws = makeWs();
      const cbs = createVoiceWidgetCallbacks(ws, makeLimiters(false));

      cbs.onMuteToggle();

      expect(mockSetMuted).not.toHaveBeenCalled();
    });
  });

  describe("onDeafenToggle", () => {
    it("deafens and mutes when undeafened", () => {
      const ws = makeWs();
      const cbs = createVoiceWidgetCallbacks(ws, makeLimiters());

      cbs.onDeafenToggle();

      expect(mockSetDeafened).toHaveBeenCalledWith(true);
      expect(mockSetMuted).toHaveBeenCalledWith(true);
    });

    it("undeafens and unmutes when deafened", () => {
      mockVoiceStoreGetState.mockReturnValue(
        makeVoiceState({ localDeafened: true, localMuted: true }),
      );
      const ws = makeWs();
      const cbs = createVoiceWidgetCallbacks(ws, makeLimiters());

      cbs.onDeafenToggle();

      expect(mockSetDeafened).toHaveBeenCalledWith(false);
      expect(mockSetMuted).toHaveBeenCalledWith(false);
    });

    it("does not double-mute when already muted", () => {
      mockVoiceStoreGetState.mockReturnValue(makeVoiceState({ localMuted: true }));
      const ws = makeWs();
      const cbs = createVoiceWidgetCallbacks(ws, makeLimiters());

      cbs.onDeafenToggle();

      // Should deafen but not send another mute since already muted
      expect(mockSetDeafened).toHaveBeenCalledWith(true);
      expect(mockSetMuted).not.toHaveBeenCalled();
      expect(ws.send).toHaveBeenCalledWith({ type: "voice_deafen", payload: { deafened: true } });
      expect(ws.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "voice_mute" }));
    });
  });

  describe("onCameraToggle", () => {
    it("enables camera when off", () => {
      const ws = makeWs();
      const cbs = createVoiceWidgetCallbacks(ws, makeLimiters());

      cbs.onCameraToggle();

      expect(mockEnableCamera).toHaveBeenCalled();
    });

    it("disables camera when on", () => {
      mockVoiceStoreGetState.mockReturnValue(makeVoiceState({ localCamera: true }));
      const ws = makeWs();
      const cbs = createVoiceWidgetCallbacks(ws, makeLimiters());

      cbs.onCameraToggle();

      expect(mockDisableCamera).toHaveBeenCalled();
    });

    it("respects video rate limiter", () => {
      const ws = makeWs();
      const cbs = createVoiceWidgetCallbacks(ws, makeLimiters(true, false));

      cbs.onCameraToggle();

      expect(mockEnableCamera).not.toHaveBeenCalled();
    });
  });

  describe("onScreenshareToggle", () => {
    it("enables screenshare when off", () => {
      const ws = makeWs();
      const cbs = createVoiceWidgetCallbacks(ws, makeLimiters());

      cbs.onScreenshareToggle();

      expect(mockSetLocalScreenshare).toHaveBeenCalledWith(true);
      expect(ws.send).toHaveBeenCalledWith({
        type: "voice_screenshare",
        payload: { enabled: true },
      });
    });

    it("disables screenshare when on", () => {
      mockVoiceStoreGetState.mockReturnValue(makeVoiceState({ localScreenshare: true }));
      const ws = makeWs();
      const cbs = createVoiceWidgetCallbacks(ws, makeLimiters());

      cbs.onScreenshareToggle();

      expect(mockSetLocalScreenshare).toHaveBeenCalledWith(false);
    });

    it("respects video rate limiter", () => {
      const ws = makeWs();
      const cbs = createVoiceWidgetCallbacks(ws, makeLimiters(true, false));

      cbs.onScreenshareToggle();

      expect(mockSetLocalScreenshare).not.toHaveBeenCalled();
      expect(ws.send).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Sidebar Voice Callbacks
// ---------------------------------------------------------------------------

describe("createSidebarVoiceCallbacks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("onVoiceJoin sends voice_join and updates store", () => {
    const ws = makeWs();
    const cbs = createSidebarVoiceCallbacks(ws);

    cbs.onVoiceJoin(42);

    expect(mockJoinVoiceChannel).toHaveBeenCalledWith(42);
    expect(ws.send).toHaveBeenCalledWith({
      type: "voice_join",
      payload: { channel_id: 42 },
    });
  });

  it("onVoiceLeave sends voice_leave and cleans up", () => {
    const ws = makeWs();
    const cbs = createSidebarVoiceCallbacks(ws);

    cbs.onVoiceLeave();

    expect(mockVoiceSessionLeave).toHaveBeenCalledWith(false);
    expect(mockLeaveVoiceChannel).toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith({ type: "voice_leave", payload: {} });
  });
});
