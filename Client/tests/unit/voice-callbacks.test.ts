import { describe, it, expect, vi, beforeEach } from "vitest";
import { loggerMock } from "../helpers/loggerMock";
import * as voiceSession from "../helpers/voiceSessionMock";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const {
  mockVoiceStoreGetState,
  mockJoinVoiceChannel,
  mockLeaveVoiceChannel,
  mockSetMutedBeforeDeafen,
  mockSaveSelfVoiceState,
  mockVoiceSessionLeave,
  mockSetMuted,
  mockSetDeafened,
  mockEnableCamera,
  mockDisableCamera,
  mockEnableScreenshare,
  mockDisableScreenshare,
  mockUiGetState,
  mockShowToast,
} = vi.hoisted(() => ({
  mockVoiceStoreGetState: vi.fn(),
  mockJoinVoiceChannel: vi.fn(),
  mockLeaveVoiceChannel: vi.fn(),
  mockSetMutedBeforeDeafen: vi.fn(),
  mockSaveSelfVoiceState: vi.fn(),
  mockVoiceSessionLeave: vi.fn(),
  mockSetMuted: vi.fn(),
  mockSetDeafened: vi.fn(),
  mockEnableCamera: vi.fn(() => Promise.resolve()),
  mockDisableCamera: vi.fn(() => Promise.resolve()),
  mockEnableScreenshare: vi.fn(() => Promise.resolve()),
  mockDisableScreenshare: vi.fn(() => Promise.resolve()),
  mockUiGetState: vi.fn(() => ({ connectionStatus: "connected" })),
  mockShowToast: vi.fn(),
}));

vi.mock("@lib/logger", () => loggerMock());

vi.mock("@stores/voice.store", async (importOriginal) => ({
  voiceStore: { getState: mockVoiceStoreGetState },
  joinVoiceChannel: mockJoinVoiceChannel,
  leaveVoiceChannel: mockLeaveVoiceChannel,
  setMutedBeforeDeafen: mockSetMutedBeforeDeafen,
  saveSelfVoiceState: mockSaveSelfVoiceState,
  isSelfMuted: (await importOriginal<typeof import("@stores/voice.store")>()).isSelfMuted,
}));

vi.mock("@lib/ui/toast", () => ({ showToast: mockShowToast }));

vi.mock("@stores/ui.store", () => ({
  uiStore: { getState: mockUiGetState },
}));

vi.mock("@lib/voice/livekitSession", () =>
  voiceSession.withOverrides({
    leaveVoice: mockVoiceSessionLeave,
    setMuted: mockSetMuted,
    setDeafened: mockSetDeafened,
    enableCamera: mockEnableCamera,
    disableCamera: mockDisableCamera,
    enableScreenshare: mockEnableScreenshare,
    disableScreenshare: mockDisableScreenshare,
  }),
);

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import {
  createVoiceWidgetCallbacks,
  createSidebarVoiceCallbacks,
} from "../../src/pages/main-page/VoiceCallbacks";
import type { WsClient } from "../../src/lib/ws";
import { noteJoinFailed, noteJoinSucceeded } from "../../src/features/voice/joinBackoff";
import { takeJoinRefusal } from "../../src/features/voice/joinRequest";

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
  pttGated?: boolean;
  voiceStatus?: string;
  mutedBeforeDeafen?: boolean;
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

/** Widget callbacks over a fresh socket; `state` replaces the voice store snapshot when given. */
function widgetWith(state?: VoiceStateStub, limiters = makeLimiters()) {
  if (state !== undefined) mockVoiceStoreGetState.mockReturnValue(state);
  const ws = makeWs();
  return { ws, cbs: createVoiceWidgetCallbacks(ws, limiters) };
}

function sidebarCallbacks() {
  const ws = makeWs();
  return { ws, cbs: createSidebarVoiceCallbacks(ws) };
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
      const { ws, cbs } = widgetWith();

      cbs.onDisconnect();

      expect(mockVoiceSessionLeave).toHaveBeenCalledWith(false);
      expect(mockLeaveVoiceChannel).toHaveBeenCalled();
      expect(ws.send).toHaveBeenCalledWith({ type: "voice_leave", payload: {} });
    });

    it("does nothing when not in a voice channel", () => {
      const { ws, cbs } = widgetWith(makeVoiceState({ currentChannelId: null }));

      cbs.onDisconnect();

      expect(ws.send).not.toHaveBeenCalled();
    });

    it("hangs up locally without sending over a down socket while reconnecting", () => {
      mockUiGetState.mockReturnValue({ connectionStatus: "reconnecting" });
      const { ws, cbs } = widgetWith();

      cbs.onDisconnect();

      expect(mockVoiceSessionLeave).toHaveBeenCalledWith(false);
      expect(mockLeaveVoiceChannel).toHaveBeenCalled();
      expect(ws.send).not.toHaveBeenCalled();
    });
  });

  describe("onMuteToggle", () => {
    it("mutes when unmuted", () => {
      const { ws, cbs } = widgetWith();

      cbs.onMuteToggle();

      expect(mockSetMuted).toHaveBeenCalledWith(true);
      expect(ws.send).toHaveBeenCalledWith({ type: "voice_mute", payload: { muted: true } });
      expect(mockSaveSelfVoiceState).toHaveBeenCalledOnce();
    });

    // WP 1D-1: outside a call the toggle changes the local (saved) state only;
    // the next join restates it to the server.
    it("mutes and unmutes outside a call without sending anything", () => {
      const { ws, cbs } = widgetWith(makeVoiceState({ currentChannelId: null }));

      cbs.onMuteToggle();
      expect(mockSetMuted).toHaveBeenLastCalledWith(true);

      mockVoiceStoreGetState.mockReturnValue(
        makeVoiceState({ currentChannelId: null, localMuted: true, localDeafened: true }),
      );
      cbs.onMuteToggle();
      expect(mockSetMuted).toHaveBeenLastCalledWith(false);
      expect(mockSetDeafened).toHaveBeenLastCalledWith(false);

      expect(ws.send).not.toHaveBeenCalled();
      expect(mockSaveSelfVoiceState).toHaveBeenCalledTimes(2);
    });

    it("does not save a refused unmute under a moderator's mute", () => {
      mockVoiceStoreGetState.mockReturnValue(
        makeVoiceState({ localMuted: true, localServerMuted: true }),
      );
      const cbs = createVoiceWidgetCallbacks(makeWs(), makeLimiters());

      cbs.onMuteToggle();

      expect(mockSetMuted).not.toHaveBeenCalled();
      expect(mockSaveSelfVoiceState).not.toHaveBeenCalled();
    });

    it("unmutes and undeafens when muted+deafened", () => {
      const { ws, cbs } = widgetWith(makeVoiceState({ localMuted: true, localDeafened: true }));

      cbs.onMuteToggle();

      expect(mockSetMuted).toHaveBeenCalledWith(false);
      expect(mockSetDeafened).toHaveBeenCalledWith(false);
      expect(ws.send).toHaveBeenCalledWith({ type: "voice_deafen", payload: { deafened: false } });
      expect(ws.send).toHaveBeenCalledWith({ type: "voice_mute", payload: { muted: false } });
    });

    it("respects rate limiter", () => {
      const { cbs } = widgetWith(undefined, makeLimiters(false));

      cbs.onMuteToggle();

      expect(mockSetMuted).not.toHaveBeenCalled();
    });

    it("does not send voice_deafen{deafened:false} on unmute while server-deafened", () => {
      // Mirrors onDeafenToggle's localServerMuted guard (OC-0179): a
      // moderator-imposed deafen is not ours to lift, so unmuting must not
      // spend a doomed voice_deafen round-trip that the server will refuse
      // with SERVER_DEAFENED.
      const { ws, cbs } = widgetWith(
        makeVoiceState({ localMuted: true, localDeafened: true, localServerDeafened: true }),
      );

      cbs.onMuteToggle();

      // The unmute itself still goes through...
      expect(mockSetMuted).toHaveBeenCalledWith(false);
      expect(ws.send).toHaveBeenCalledWith({ type: "voice_mute", payload: { muted: false } });
      // ...but the undeafen must be suppressed while the server deafen stands.
      expect(mockSetDeafened).not.toHaveBeenCalled();
      expect(ws.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "voice_deafen" }));
    });

    // Rewritten: PTT no longer owns a mute, so a toggle with the key up is an
    // ordinary mute/unmute of the user's own state.
    it("mutes outright when clicked with the push-to-talk key up and the user unmuted", () => {
      const { ws, cbs } = widgetWith(makeVoiceState({ localMuted: false, pttGated: true }));

      cbs.onMuteToggle();

      expect(mockSetMuted).toHaveBeenCalledWith(true);
      expect(ws.send).toHaveBeenCalledWith({ type: "voice_mute", payload: { muted: true } });
    });

    it("unmutes the user's own mute directly while the push-to-talk key is up", () => {
      // The gate inside the mic processor keeps the mic closed until a press.
      const { ws, cbs } = widgetWith(makeVoiceState({ localMuted: true, pttGated: true }));

      cbs.onMuteToggle();

      expect(mockSetMuted).toHaveBeenCalledWith(false);
      expect(ws.send).toHaveBeenCalledWith({ type: "voice_mute", payload: { muted: false } });
    });
    // Deleted "lifts the mute outright where no press can arrive": that is now the only path.
  });

  describe("while the chat socket is down", () => {
    beforeEach(() => {
      mockUiGetState.mockReturnValue({ connectionStatus: "reconnecting" });
    });

    it("mutes locally and sends nothing", () => {
      const { ws, cbs } = widgetWith();

      cbs.onMuteToggle();

      expect(mockSetMuted).toHaveBeenCalledWith(true);
      expect(ws.send).not.toHaveBeenCalled();
    });

    it("unmutes and undeafens locally and sends nothing", () => {
      const { ws, cbs } = widgetWith(makeVoiceState({ localMuted: true, localDeafened: true }));

      cbs.onMuteToggle();

      expect(mockSetMuted).toHaveBeenCalledWith(false);
      expect(mockSetDeafened).toHaveBeenCalledWith(false);
      expect(ws.send).not.toHaveBeenCalled();
    });

    it("deafens locally and sends nothing", () => {
      const { ws, cbs } = widgetWith();

      cbs.onDeafenToggle();

      expect(mockSetDeafened).toHaveBeenCalledWith(true);
      expect(mockSetMuted).toHaveBeenCalledWith(true);
      expect(ws.send).not.toHaveBeenCalled();
    });
  });

  describe("onDeafenToggle", () => {
    it("deafens and mutes when undeafened", () => {
      const { cbs } = widgetWith();

      cbs.onDeafenToggle();

      expect(mockSetDeafened).toHaveBeenCalledWith(true);
      expect(mockSetMuted).toHaveBeenCalledWith(true);
      expect(mockSaveSelfVoiceState).toHaveBeenCalledOnce();
    });

    it("deafens outside a call without sending anything", () => {
      const { ws, cbs } = widgetWith(makeVoiceState({ currentChannelId: null }));

      cbs.onDeafenToggle();

      expect(mockSetMutedBeforeDeafen).toHaveBeenCalledWith(false);
      expect(mockSetDeafened).toHaveBeenCalledWith(true);
      expect(mockSetMuted).toHaveBeenCalledWith(true);
      expect(ws.send).not.toHaveBeenCalled();
      expect(mockSaveSelfVoiceState).toHaveBeenCalledOnce();
    });

    it("undeafens and unmutes when deafened", () => {
      const { cbs } = widgetWith(makeVoiceState({ localDeafened: true, localMuted: true }));

      cbs.onDeafenToggle();

      expect(mockSetDeafened).toHaveBeenCalledWith(false);
      expect(mockSetMuted).toHaveBeenCalledWith(false);
    });

    it("deafen then undeafen after a prior mute stays muted", () => {
      const { ws, cbs } = widgetWith(makeVoiceState({ localMuted: true }));

      cbs.onDeafenToggle();
      expect(mockSetMutedBeforeDeafen).toHaveBeenLastCalledWith(true);

      mockVoiceStoreGetState.mockReturnValue(
        makeVoiceState({ localMuted: true, localDeafened: true, mutedBeforeDeafen: true }),
      );
      vi.clearAllMocks();
      cbs.onDeafenToggle();

      expect(mockSetDeafened).toHaveBeenCalledWith(false);
      expect(mockSetMuted).not.toHaveBeenCalled();
      expect(ws.send).toHaveBeenCalledWith({ type: "voice_deafen", payload: { deafened: false } });
      expect(ws.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "voice_mute" }));
    });

    it("records that the user was not muted when deafening", () => {
      const { cbs } = widgetWith();

      cbs.onDeafenToggle();

      expect(mockSetMutedBeforeDeafen).toHaveBeenLastCalledWith(false);
    });

    it("clears the remembered mute on undeafen", () => {
      mockVoiceStoreGetState.mockReturnValue(
        makeVoiceState({ localMuted: true, localDeafened: true, mutedBeforeDeafen: true }),
      );
      const cbs = createVoiceWidgetCallbacks(makeWs(), makeLimiters());

      cbs.onDeafenToggle();

      expect(mockSetMutedBeforeDeafen).toHaveBeenLastCalledWith(false);
    });

    it("does not double-mute when already muted", () => {
      const { ws, cbs } = widgetWith(makeVoiceState({ localMuted: true }));

      cbs.onDeafenToggle();

      // Should deafen but not send another mute since already muted
      expect(mockSetDeafened).toHaveBeenCalledWith(true);
      expect(mockSetMuted).not.toHaveBeenCalled();
      expect(ws.send).toHaveBeenCalledWith({ type: "voice_deafen", payload: { deafened: true } });
      expect(ws.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "voice_mute" }));
    });

    it("does not send voice_mute{muted:false} on undeafen while server-muted", () => {
      // Mirrors onMuteToggle's localServerMuted guard: a moderator-imposed
      // mute is not ours to lift, so undeafening must not spend a doomed
      // voice_mute round-trip that the server will refuse with SERVER_MUTED.
      const { ws, cbs } = widgetWith(
        makeVoiceState({ localDeafened: true, localMuted: true, localServerMuted: true }),
      );

      cbs.onDeafenToggle();

      // The deafen clear itself still goes through...
      expect(mockSetDeafened).toHaveBeenCalledWith(false);
      expect(ws.send).toHaveBeenCalledWith({ type: "voice_deafen", payload: { deafened: false } });
      // ...but the unmute must be suppressed while the server mute stands.
      expect(mockSetMuted).not.toHaveBeenCalled();
      expect(ws.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "voice_mute" }));
    });

    it("undeafen while the push-to-talk key is up unmutes directly (the gate keeps the mic closed)", () => {
      const { ws, cbs } = widgetWith(
        makeVoiceState({ localDeafened: true, localMuted: true, pttGated: true }),
      );

      cbs.onDeafenToggle();

      expect(mockSetDeafened).toHaveBeenCalledWith(false);
      expect(mockSetMuted).toHaveBeenCalledWith(false);
      expect(ws.send).toHaveBeenCalledWith({ type: "voice_mute", payload: { muted: false } });
    });
  });

  describe("onCameraToggle", () => {
    it("enables camera when off", () => {
      const { cbs } = widgetWith();

      cbs.onCameraToggle();

      expect(mockEnableCamera).toHaveBeenCalled();
    });

    it("disables camera when on", () => {
      const { cbs } = widgetWith(makeVoiceState({ localCamera: true }));

      cbs.onCameraToggle();

      expect(mockDisableCamera).toHaveBeenCalled();
    });

    it("respects video rate limiter", () => {
      const { cbs } = widgetWith(undefined, makeLimiters(true, false));

      cbs.onCameraToggle();

      expect(mockEnableCamera).not.toHaveBeenCalled();
    });
  });

  describe("onScreenshareToggle", () => {
    it("enables screenshare when off", () => {
      const { cbs } = widgetWith();

      cbs.onScreenshareToggle();

      expect(mockEnableScreenshare).toHaveBeenCalled();
      expect(mockDisableScreenshare).not.toHaveBeenCalled();
    });

    it("disables screenshare when on", () => {
      const { cbs } = widgetWith(makeVoiceState({ localScreenshare: true }));

      cbs.onScreenshareToggle();

      expect(mockDisableScreenshare).toHaveBeenCalled();
      expect(mockEnableScreenshare).not.toHaveBeenCalled();
    });

    it("respects video rate limiter", () => {
      const { cbs } = widgetWith(undefined, makeLimiters(true, false));

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
    noteJoinSucceeded();
  });

  it("onVoiceJoin sends voice_join and updates store", () => {
    const { ws, cbs } = sidebarCallbacks();

    cbs.onVoiceJoin(42);

    expect(mockJoinVoiceChannel).toHaveBeenCalledWith(42);
    expect(ws.send).toHaveBeenCalledWith({
      type: "voice_join",
      payload: { channel_id: 42, user_initiated: true },
    });
  });

  it("onVoiceJoin records the join's envelope id so only its refusal rolls it back", () => {
    const ws = { send: vi.fn(() => "join-42") } as unknown as WsClient;
    const cbs = createSidebarVoiceCallbacks(ws);

    cbs.onVoiceJoin(42);

    expect(takeJoinRefusal("FORBIDDEN", "other")).toBe(false);
    expect(takeJoinRefusal("FORBIDDEN", "join-42")).toBe(true);
  });

  it("onVoiceJoin is a no-op when already in the requested voice channel", () => {
    // A redial into a live call (e.g. DM "Start a call" clicked again to
    // nudge a callee who hasn't answered) must not re-send voice_join for the
    // channel this client already occupies -- the server refuses a
    // same-channel re-join with ALREADY_JOINED, which the dispatcher's
    // catch-all turns into a user-facing error toast.
    mockVoiceStoreGetState.mockReturnValue(makeVoiceState({ currentChannelId: 42 }));
    const { ws, cbs } = sidebarCallbacks();

    cbs.onVoiceJoin(42);

    expect(mockJoinVoiceChannel).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("onVoiceLeave sends voice_leave and cleans up", () => {
    const { ws, cbs } = sidebarCallbacks();

    cbs.onVoiceLeave();

    expect(mockVoiceSessionLeave).toHaveBeenCalledWith(false);
    expect(mockLeaveVoiceChannel).toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith({ type: "voice_leave", payload: {} });
  });

  it("onVoiceJoin waits out the backoff after a failed join instead of re-sending voice_join", () => {
    // A join that keeps failing must never cycle voice_join/voice_leave
    // several times a second, however fast the row is clicked.
    noteJoinFailed();
    const { ws, cbs } = sidebarCallbacks();

    cbs.onVoiceJoin(42);

    expect(mockJoinVoiceChannel).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalledWith("Voice join failed — try again in 2 s", "error");
  });

  it("a switch away from a join still in flight backs off the next one", () => {
    // Alternating channels while a join is joining/securing would otherwise
    // cycle pre-SFU voice_join/voice_leave pairs at the server's join limit.
    const { ws, cbs } = sidebarCallbacks();
    mockVoiceStoreGetState.mockReturnValue(
      makeVoiceState({ currentChannelId: 10, voiceStatus: "securing" }),
    );

    cbs.onVoiceJoin(42);
    expect(ws.send).toHaveBeenCalledWith({
      type: "voice_join",
      payload: { channel_id: 42, user_initiated: true },
    });

    mockVoiceStoreGetState.mockReturnValue(
      makeVoiceState({ currentChannelId: 42, voiceStatus: "joining" }),
    );
    cbs.onVoiceJoin(10);
    expect(ws.send).toHaveBeenCalledOnce();
    expect(mockShowToast).toHaveBeenCalledWith(
      "Please wait 2 s before switching voice channels",
      "error",
    );
  });

  it("a switch from a connected call is not backed off", () => {
    const { ws, cbs } = sidebarCallbacks();
    mockVoiceStoreGetState.mockReturnValue(
      makeVoiceState({ currentChannelId: 10, voiceStatus: "connected" }),
    );
    cbs.onVoiceJoin(42);
    mockVoiceStoreGetState.mockReturnValue(
      makeVoiceState({ currentChannelId: 42, voiceStatus: "joining" }),
    );
    cbs.onVoiceJoin(10);
    expect(ws.send).toHaveBeenCalledTimes(2);
  });

  it("onVoiceJoin does not send over a down socket", () => {
    mockUiGetState.mockReturnValue({ connectionStatus: "disconnected" });
    const { ws, cbs } = sidebarCallbacks();

    cbs.onVoiceJoin(42);

    expect(mockJoinVoiceChannel).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("onVoiceLeave hangs up locally without sending over a down socket", () => {
    mockUiGetState.mockReturnValue({ connectionStatus: "reconnecting" });
    const { ws, cbs } = sidebarCallbacks();

    cbs.onVoiceLeave();

    expect(mockVoiceSessionLeave).toHaveBeenCalledWith(false);
    expect(mockLeaveVoiceChannel).toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();
  });
});
