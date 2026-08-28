import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const {
  mockVoiceStoreGetState,
  mockJoinVoiceChannel,
  mockLeaveVoiceChannel,
  mockVoiceSessionLeave,
  mockSetMuted,
  mockSetDeafened,
  mockEnableCamera,
  mockDisableCamera,
  mockEnableScreenshare,
  mockDisableScreenshare,
  mockUiGetState,
} = vi.hoisted(() => ({
  mockVoiceStoreGetState: vi.fn(),
  mockJoinVoiceChannel: vi.fn(),
  mockLeaveVoiceChannel: vi.fn(),
  mockVoiceSessionLeave: vi.fn(),
  mockSetMuted: vi.fn(),
  mockSetDeafened: vi.fn(),
  mockEnableCamera: vi.fn(() => Promise.resolve()),
  mockDisableCamera: vi.fn(() => Promise.resolve()),
  mockEnableScreenshare: vi.fn(() => Promise.resolve()),
  mockDisableScreenshare: vi.fn(() => Promise.resolve()),
  mockUiGetState: vi.fn(() => ({ connectionStatus: "connected" })),
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
}));

vi.mock("@stores/ui.store", () => ({
  uiStore: { getState: mockUiGetState },
}));

vi.mock("@lib/livekitSession", () => ({
  leaveVoice: mockVoiceSessionLeave,
  setMuted: mockSetMuted,
  setDeafened: mockSetDeafened,
  enableCamera: mockEnableCamera,
  disableCamera: mockDisableCamera,
  enableScreenshare: mockEnableScreenshare,
  disableScreenshare: mockDisableScreenshare,
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
  localServerMuted: boolean;
  localServerDeafened: boolean;
}

function makeVoiceState(overrides: Partial<VoiceStateStub> = {}): VoiceStateStub {
  return {
    currentChannelId: 10,
    localMuted: false,
    localDeafened: false,
    localCamera: false,
    localScreenshare: false,
    localServerMuted: false,
    localServerDeafened: false,
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
    mockUiGetState.mockReturnValue({ connectionStatus: "connected" });
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

    it("does not send over a down socket while reconnecting", () => {
      mockUiGetState.mockReturnValue({ connectionStatus: "reconnecting" });
      const ws = makeWs();
      const cbs = createVoiceWidgetCallbacks(ws, makeLimiters());

      cbs.onDisconnect();

      expect(mockVoiceSessionLeave).not.toHaveBeenCalled();
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

    it("does not send voice_deafen{deafened:false} on unmute while server-deafened (OC-0216)", () => {
      // Mirrors onDeafenToggle's localServerMuted guard (OC-0179): a
      // moderator-imposed deafen is not ours to lift, so unmuting must not
      // spend a doomed voice_deafen round-trip that the server will refuse
      // with SERVER_DEAFENED.
      mockVoiceStoreGetState.mockReturnValue(
        makeVoiceState({ localMuted: true, localDeafened: true, localServerDeafened: true }),
      );
      const ws = makeWs();
      const cbs = createVoiceWidgetCallbacks(ws, makeLimiters());

      cbs.onMuteToggle();

      // The unmute itself still goes through...
      expect(mockSetMuted).toHaveBeenCalledWith(false);
      expect(ws.send).toHaveBeenCalledWith({ type: "voice_mute", payload: { muted: false } });
      // ...but the undeafen must be suppressed while the server deafen stands.
      expect(mockSetDeafened).not.toHaveBeenCalled();
      expect(ws.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "voice_deafen" }));
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

    it("does not send voice_mute{muted:false} on undeafen while server-muted (OC-0179)", () => {
      // Mirrors onMuteToggle's localServerMuted guard: a moderator-imposed
      // mute is not ours to lift, so undeafening must not spend a doomed
      // voice_mute round-trip that the server will refuse with SERVER_MUTED.
      mockVoiceStoreGetState.mockReturnValue(
        makeVoiceState({ localDeafened: true, localMuted: true, localServerMuted: true }),
      );
      const ws = makeWs();
      const cbs = createVoiceWidgetCallbacks(ws, makeLimiters());

      cbs.onDeafenToggle();

      // The deafen clear itself still goes through...
      expect(mockSetDeafened).toHaveBeenCalledWith(false);
      expect(ws.send).toHaveBeenCalledWith({ type: "voice_deafen", payload: { deafened: false } });
      // ...but the unmute must be suppressed while the server mute stands.
      expect(mockSetMuted).not.toHaveBeenCalled();
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

      expect(mockEnableScreenshare).toHaveBeenCalled();
      expect(mockDisableScreenshare).not.toHaveBeenCalled();
    });

    it("disables screenshare when on", () => {
      mockVoiceStoreGetState.mockReturnValue(makeVoiceState({ localScreenshare: true }));
      const ws = makeWs();
      const cbs = createVoiceWidgetCallbacks(ws, makeLimiters());

      cbs.onScreenshareToggle();

      expect(mockDisableScreenshare).toHaveBeenCalled();
      expect(mockEnableScreenshare).not.toHaveBeenCalled();
    });

    it("respects video rate limiter", () => {
      const ws = makeWs();
      const cbs = createVoiceWidgetCallbacks(ws, makeLimiters(true, false));

      cbs.onScreenshareToggle();

      expect(mockEnableScreenshare).not.toHaveBeenCalled();
      expect(mockDisableScreenshare).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Sidebar Voice Callbacks
// ---------------------------------------------------------------------------

describe("createSidebarVoiceCallbacks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUiGetState.mockReturnValue({ connectionStatus: "connected" });
    mockVoiceStoreGetState.mockReturnValue(makeVoiceState({ currentChannelId: null }));
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

  it("onVoiceJoin is a no-op when already in the requested voice channel (OC-0289)", () => {
    // A redial into a live call (e.g. DM "Start a call" clicked again to
    // nudge a callee who hasn't answered) must not re-send voice_join for the
    // channel this client already occupies -- the server refuses a
    // same-channel re-join with ALREADY_JOINED, which the dispatcher's
    // catch-all turns into a user-facing error toast.
    mockVoiceStoreGetState.mockReturnValue(makeVoiceState({ currentChannelId: 42 }));
    const ws = makeWs();
    const cbs = createSidebarVoiceCallbacks(ws);

    cbs.onVoiceJoin(42);

    expect(mockJoinVoiceChannel).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("onVoiceLeave sends voice_leave and cleans up", () => {
    const ws = makeWs();
    const cbs = createSidebarVoiceCallbacks(ws);

    cbs.onVoiceLeave();

    expect(mockVoiceSessionLeave).toHaveBeenCalledWith(false);
    expect(mockLeaveVoiceChannel).toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith({ type: "voice_leave", payload: {} });
  });

  it("onVoiceJoin does not send over a down socket", () => {
    mockUiGetState.mockReturnValue({ connectionStatus: "disconnected" });
    const ws = makeWs();
    const cbs = createSidebarVoiceCallbacks(ws);

    cbs.onVoiceJoin(42);

    expect(mockJoinVoiceChannel).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("onVoiceLeave does not send over a down socket", () => {
    mockUiGetState.mockReturnValue({ connectionStatus: "reconnecting" });
    const ws = makeWs();
    const cbs = createSidebarVoiceCallbacks(ws);

    cbs.onVoiceLeave();

    expect(mockVoiceSessionLeave).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();
  });
});
