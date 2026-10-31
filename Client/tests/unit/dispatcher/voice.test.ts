import { describe, it, expect, vi, beforeEach } from "vitest";
import * as dispatcherMocks from "../../helpers/dispatcherMocks";
import { expectConsole } from "../../helpers/console";
import { authStore } from "../../../src/stores/auth.store";
import { voiceStore } from "../../../src/stores/voice.store";
import { uiStore } from "../../../src/stores/ui.store";
import {
  leaveVoice as mockLeaveVoice,
  disableCamera as mockDisableCamera,
  disableScreenshare as mockDisableScreenshare,
  isVoiceSessionActive as mockIsVoiceSessionActive,
  handleParticipantLeft as mockHandleParticipantLeft,
  isAutoReconnecting as mockIsAutoReconnecting,
  failPendingRejoin as mockFailPendingRejoin,
} from "@lib/voice/livekitSession";
import { rollbackPendingVideo as mockRollbackPendingVideo } from "@lib/voice/screenShare";
import { takeVoiceMoved } from "../../../src/features/voice/moveHint";
import { noteJoinSent, takeJoinRefusal } from "../../../src/features/voice/joinRequest";
import {
  useDispatcherHarness,
  setMeUser,
  readyEvent,
  readyChannel,
  patchVoice,
  mock,
} from "../../helpers/dispatcherHarness";
import { signInAs } from "../../helpers/storeSeeds";

vi.mock("@lib/notifications", () => dispatcherMocks.notificationsMock());
vi.mock("@lib/voice/livekitSession", () => dispatcherMocks.livekitSessionMock());
vi.mock("@lib/voice/screenShare", () => dispatcherMocks.screenShareMock());
vi.mock("@lib/ui/toast", () => dispatcherMocks.toastMock());
vi.mock("@lib/net/identity", () => dispatcherMocks.identityMock());
vi.mock("../../../src/features/connection/dispatchContext", async (importOriginal) =>
  dispatcherMocks.dispatchContextMock(await importOriginal<object>()),
);

const { mockShowToast } = dispatcherMocks;

describe("WS Dispatcher", () => {
  useDispatcherHarness();

  it("wires voice_state to voice store", () => {
    mock.dispatch("voice_state", {
      channel_id: 2,
      user_id: 1,
      username: "alex",
      muted: true,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });

    const users = voiceStore.getState().voiceUsers.get(2);
    expect(users?.get(1)?.muted).toBe(true);
  });

  it("wires voice_state to the roster only when this device holds no call", () => {
    setMeUser();

    mock.dispatch("voice_state", {
      channel_id: 3,
      user_id: 5,
      username: "me",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });

    expect(voiceStore.getState().currentChannelId).toBeNull();
    expect(voiceStore.getState().voiceStatus).toBe("idle");
    expect(voiceStore.getState().voiceUsers.get(3)?.has(5)).toBe(true);
  });

  it("wires voice_state and adopts the channel if current user and this device is joining", () => {
    setMeUser();
    patchVoice({ voiceStatus: "joining" });

    mock.dispatch("voice_state", {
      channel_id: 3,
      user_id: 5,
      username: "me",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });

    expect(voiceStore.getState().currentChannelId).toBe(3);
  });

  it("wires voice_state does NOT auto-join for other users", () => {
    setMeUser();

    mock.dispatch("voice_state", {
      channel_id: 3,
      user_id: 99,
      username: "other",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });

    expect(voiceStore.getState().currentChannelId).toBeNull();
  });

  it("wires voice_leave and clears local voice state if current user kicked", () => {
    setMeUser();

    // First join voice
    patchVoice({ currentChannelId: 3 });

    mock.dispatch("voice_leave", {
      channel_id: 3,
      user_id: 5,
    });

    expect(voiceStore.getState().currentChannelId).toBeNull();
  });

  it("wires voice_leave does NOT clear local state for other users", () => {
    setMeUser();

    patchVoice({ currentChannelId: 3 });

    mock.dispatch("voice_leave", {
      channel_id: 3,
      user_id: 99,
    });

    expect(voiceStore.getState().currentChannelId).toBe(3);
  });

  // A server-initiated eviction (CONNECT_VOICE revocation sweep, channel
  // delete) has no companion teardown message — voice_leave for the local
  // user IS the signal that must also tear down the LiveKit session, or mic
  // publish + E2EE key material stay live while the UI shows not-in-voice.
  it("tears down the LiveKit session on a self voice_leave for the current channel", async () => {
    vi.mocked(mockLeaveVoice).mockClear();
    setMeUser();
    patchVoice({ currentChannelId: 3 });

    mock.dispatch("voice_leave", {
      channel_id: 3,
      user_id: 5,
    });
    await vi.runAllTimersAsync();

    expect(mockLeaveVoice).toHaveBeenCalledWith(false);
  });

  // P2-T5: while voice is reconnecting, a self voice_leave is the server
  // releasing the membership the reconnect loop is resuming — the loop
  // rejoins or gives up with its toast, so this frame must not end the call.
  it("leaves the session to the reconnect loop on a self voice_leave while reconnecting", async () => {
    vi.mocked(mockLeaveVoice).mockClear();
    vi.mocked(mockIsAutoReconnecting).mockReturnValueOnce(true);
    setMeUser();
    patchVoice({ currentChannelId: 3, voiceStatus: "reconnecting" });

    mock.dispatch("voice_leave", {
      channel_id: 3,
      user_id: 5,
    });
    await vi.runAllTimersAsync();

    expect(mockLeaveVoice).not.toHaveBeenCalled();
    expect(voiceStore.getState().currentChannelId).toBe(3);
    expect(voiceStore.getState().voiceUsers.get(3)?.has(5) ?? false).toBe(false);
  });

  // The badge also reads "reconnecting" while livekit-client retries on its
  // own inside a connected session (OC-0015); no reconnect loop owns that
  // session, so a server eviction must still tear it down.
  it("tears down on a self voice_leave while the SDK reconnects inside a connected session", async () => {
    vi.mocked(mockLeaveVoice).mockClear();
    setMeUser();
    patchVoice({ currentChannelId: 3, voiceStatus: "reconnecting" });

    mock.dispatch("voice_leave", {
      channel_id: 3,
      user_id: 5,
    });
    await vi.runAllTimersAsync();

    expect(mockLeaveVoice).toHaveBeenCalledWith(false);
    expect(voiceStore.getState().currentChannelId).toBeNull();
  });

  // A stale voice_leave for a channel we've already left (and rejoined
  // elsewhere) must not kill the newer join's live session.
  it("does not tear down the session for a stale voice_leave from a channel already left", async () => {
    vi.mocked(mockLeaveVoice).mockClear();
    setMeUser();
    // Currently in channel 9 (a newer join) — the incoming voice_leave is for
    // the old channel 3.
    patchVoice({ currentChannelId: 9 });

    mock.dispatch("voice_leave", {
      channel_id: 3,
      user_id: 5,
    });
    await vi.runAllTimersAsync();

    expect(mockLeaveVoice).not.toHaveBeenCalled();
  });

  // OC-0015: a channel switch optimistically moves currentChannelId to the
  // NEW channel (VoiceCallbacks.onVoiceJoin) before the server responds. The
  // server always leaves the OLD channel first, so the self voice_leave for
  // that old channel must not blank the store back to null — that would hide
  // the entire voice widget (mute/leave controls included) while a session
  // may still be live. Same guard as the LiveKit teardown above.
  it("does not blank voiceStore.currentChannelId on a self voice_leave for a channel mid-switch away from", async () => {
    setMeUser();
    // Optimistically already moved to the new channel (7); the incoming
    // voice_leave is for the old channel (3).
    patchVoice({ currentChannelId: 7 });

    mock.dispatch("voice_leave", {
      channel_id: 3,
      user_id: 5,
    });
    await vi.runAllTimersAsync();

    expect(voiceStore.getState().currentChannelId).toBe(7);
  });

  // OC-0283: a departing peer's roster entry is only ever removed by THIS
  // same voice_leave handler (removeVoiceUser below), so a roster read taken
  // at any point relative to that mutation — before or after — sees the
  // peer as "still present" on a genuine departure exactly as it would for
  // the OC-0213 stale-leave case. handleParticipantLeft must not be handed a
  // flag computed that way: E2EEManager.handleParticipantLeft used to accept
  // a `stillInRoster` second argument (OC-0239) that this dispatcher always
  // computed as true from a pre-mutation snapshot, permanently disabling the
  // OC-0020 departed-peer key retirement in production. Assert the call
  // shape directly so a future re-introduction of such a flag is caught here.
  it("does not pass a stale-leave roster snapshot to handleParticipantLeft on a genuine departure", async () => {
    vi.mocked(mockHandleParticipantLeft).mockClear();
    setMeUser();
    // Peer 7 is present in the roster right up until their own leave, just
    // as a real join (voice_state) would have left them — nothing removes
    // them from voiceUsers before this voice_leave is processed.
    patchVoice({
      currentChannelId: 3,
      voiceUsers: new Map([
        [
          3,
          new Map([
            [
              7,
              {
                userId: 7,
                username: "peer",
                muted: false,
                deafened: false,
                speaking: false,
                camera: false,
                screenshare: false,
                serverMuted: false,
                serverDeafened: false,
              },
            ],
          ]),
        ],
      ]),
    });

    mock.dispatch("voice_leave", {
      channel_id: 3,
      user_id: 7,
    });
    await vi.runAllTimersAsync();

    // Exactly one argument: no roster-derived flag riding along that could
    // suppress the departed peer's key retirement.
    expect(mockHandleParticipantLeft).toHaveBeenCalledWith(7);
  });

  // OC-0311: voice_leave is broadcast to channelReadAudience(channel), i.e.
  // everyone with READ_MESSAGES on THAT channel — not just its voice
  // participants. A client can read channel B (and so receive B's
  // voice_leave frames) while its own live voice session is in channel A.
  // Without a channel guard, a peer leaving a channel this client merely
  // reads mutates this client's own E2EE peer state (deletes the peer's key,
  // clears their verification badge, retires their key, and can trigger a
  // room-key rotation) for a call that peer was never part of.
  it("does not touch E2EE peer state for a voice_leave from a channel this client is not in", async () => {
    vi.mocked(mockHandleParticipantLeft).mockClear();
    setMeUser();
    // This client's live voice session is channel 3.
    patchVoice({ currentChannelId: 3 });

    // A peer leaves channel 99, which this client can merely read (hence
    // seeing the broadcast) but is not the client's own voice channel.
    mock.dispatch("voice_leave", {
      channel_id: 99,
      user_id: 7,
    });
    await vi.runAllTimersAsync();

    expect(mockHandleParticipantLeft).not.toHaveBeenCalled();
  });

  it("wires voice_moved to a leave + re-join of the destination channel", async () => {
    setMeUser();
    patchVoice({ currentChannelId: 3 });

    mock.dispatch("voice_moved", { to_channel_id: 7 });
    await vi.runAllTimersAsync();

    expect(voiceStore.getState().currentChannelId).toBe(7);
    expect(mock.ws.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "voice_join", payload: { channel_id: 7 } }),
    );
    // Its refusal is the one that may roll the re-join back.
    expect(takeJoinRefusal("FORBIDDEN", "test-id")).toBe(true);
    // The destination's connect plays the moved tone (uiSounds), not the join one.
    expect(takeVoiceMoved(7)).toBe(true);
  });

  it("wires voice_disconnected to clearing the local voice session", async () => {
    setMeUser();
    patchVoice({ currentChannelId: 3 });

    mock.dispatch("voice_disconnected", { channel_id: 3, reason: "kicked" });
    await vi.runAllTimersAsync();

    expect(voiceStore.getState().currentChannelId).toBeNull();
  });

  // OC-0031: voice_disconnected can arrive from behind a backed-up outbound
  // queue well after the kick already tore the LiveKit session down at the
  // SFU — by the time it's finally delivered, the user may have already
  // rejoined (this channel or another). Its sibling VOICE_LEAVE handler
  // guards on channel match for exactly this staleness; voice_disconnected
  // must too, or the stale frame kills the freshly established session.
  it("does not tear down a fresher voice session for a stale queued voice_disconnected", async () => {
    vi.mocked(mockLeaveVoice).mockClear();
    mockShowToast.mockClear();
    setMeUser();
    // A newer session is live in channel 9; the queued voice_disconnected is
    // for the old channel 3 the kick already evicted us from.
    patchVoice({ currentChannelId: 9 });

    mock.dispatch("voice_disconnected", { channel_id: 3, reason: "kicked" });
    await vi.runAllTimersAsync();

    expect(mockLeaveVoice).not.toHaveBeenCalled();
    expect(voiceStore.getState().currentChannelId).toBe(9);
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  // OC-0033: on the ordinary kick path, the server's finishVoiceLeave
  // broadcasts voice_leave to the leaver BEFORE handleVoiceModKickV2 ever
  // sends voice_disconnected, so the sibling VOICE_LEAVE handler above has
  // already nulled currentChannelId by the time this event lands. A cleared
  // store is not the same staleness OC-0031 guards against (a rejoin into a
  // *different* channel) and must not swallow the kick toast — it's the only
  // explanation the user gets for being dropped from the call.
  it("still surfaces the kick toast after the sibling voice_leave already cleared the store", async () => {
    mockShowToast.mockClear();
    setMeUser();
    // voice_leave for this same kick already cleared the store.
    patchVoice({ currentChannelId: null });

    mock.dispatch("voice_disconnected", { channel_id: 3, reason: "kicked by a moderator" });
    await vi.runAllTimersAsync();

    expect(mockShowToast).toHaveBeenCalledWith("kicked by a moderator", "error");
  });

  it("wires voice_config to voice store", () => {
    mock.dispatch("voice_config", {
      channel_id: 3,
      max_bitrate: 128000,
    });

    const configs = voiceStore.getState().voiceConfigs;
    expect(configs.get(3)).toBeDefined();
  });

  it("wires voice_token to handleVoiceToken", async () => {
    const { handleVoiceToken } = await import("@lib/voice/livekitSession");

    mock.dispatch("voice_token", {
      token: "lk-token",
      url: "wss://livekit.example.com",
      channel_id: 3,
      direct_url: "wss://direct.example.com",
    });

    // livekitSession is dynamically imported by the handler, so the call
    // lands after the import promise resolves.
    await vi.waitFor(() => {
      expect(handleVoiceToken).toHaveBeenCalledWith(
        "lk-token",
        "wss://livekit.example.com",
        3,
        "wss://direct.example.com",
        undefined,
      );
    });
  });

  it("voice_leave with no user in auth uses 0 as fallback userId", () => {
    authStore.setState(() => ({
      token: "t",
      user: null,
      serverName: null,
      motd: null,
      isAuthenticated: false,
    }));

    expect(() => {
      mock.dispatch("voice_leave", {
        channel_id: 3,
        user_id: 99,
      });
    }).not.toThrow();
  });

  it("ready leaves another device's call alone when this device is idle", () => {
    // This device holds no call: the self row is another device's, so there is
    // nothing to clean up and a voice_leave would end that call.
    patchVoice({ voiceStatus: "idle" });

    // Set up auth so the current user ID is 42
    signInAs(
      { id: 42, username: "ghost", avatar: null, role: "member" },
      { token: "test-token", serverName: "Test", motd: "" },
    );

    mock.dispatch(
      "ready",
      readyEvent({
        channels: [readyChannel({ category: "" })],
        voice_states: [{ user_id: 42, channel_id: 10, muted: false, deafened: false }],
        dm_channels: [],
      }),
    );

    expect(mock.ws.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "voice_leave" }));
    expect(voiceStore.getState().currentChannelId).toBeNull();
    expect(voiceStore.getState().voiceUsers.get(10)?.has(42)).toBe(true);
  });

  it("ready does NOT send voice_leave when LiveKit IS connected", () => {
    // A non-idle voice status means livekitSession is driving a live/pending
    // session (the lazily-loaded module's store-backed "connected" flag).
    patchVoice({ voiceStatus: "connected" });

    signInAs(
      { id: 42, username: "active", avatar: null, role: "member" },
      { token: "test-token", serverName: "Test", motd: "" },
    );

    mock.dispatch(
      "ready",
      readyEvent({
        channels: [readyChannel({ category: "" })],
        voice_states: [{ user_id: 42, channel_id: 10, muted: false, deafened: false }],
        dm_channels: [],
      }),
    );

    // voice_leave should NOT be sent — the LiveKit room is active
    const sendCalls = (mock.ws.send as ReturnType<typeof vi.fn>).mock.calls;
    const voiceLeaveSent = sendCalls.some(
      (args: unknown[]) => (args[0] as Record<string, unknown>)?.type === "voice_leave",
    );
    expect(voiceLeaveSent).toBe(false);
  });

  // WP 1C-8: an announce lost while the socket was down leaves the server's
  // camera/share flag behind what this session sends; `ready` checks it.
  it("ready hands the server's camera and share flags to the live voice session", async () => {
    patchVoice({ voiceStatus: "connected", currentChannelId: 10 });
    signInAs(
      { id: 42, username: "active", avatar: null, role: "member" },
      { token: "test-token", serverName: "Test", motd: "" },
    );
    const { reconcileVideoFlags } = await import("@lib/voice/livekitSession");
    vi.mocked(reconcileVideoFlags).mockClear();

    mock.dispatch(
      "ready",
      readyEvent({
        channels: [readyChannel({ category: "" })],
        voice_states: [
          { user_id: 42, channel_id: 10, muted: false, deafened: false, screenshare: true },
        ],
        dm_channels: [],
      }),
    );

    await vi.waitFor(() => expect(reconcileVideoFlags).toHaveBeenCalledWith(false, true));
  });

  it("ready does NOT send voice_leave when user is NOT in voice_states", () => {
    patchVoice({ voiceStatus: "idle" });

    signInAs(
      { id: 42, username: "notinvoice", avatar: null, role: "member" },
      { token: "test-token", serverName: "Test", motd: "" },
    );

    mock.dispatch(
      "ready",
      readyEvent({
        channels: [readyChannel({ category: "" })],
        voice_states: [{ user_id: 99, channel_id: 10, muted: false, deafened: false }],
        dm_channels: [],
      }),
    );

    // voice_leave should NOT be sent — user 42 is not in voice_states
    const sendCalls = (mock.ws.send as ReturnType<typeof vi.fn>).mock.calls;
    const voiceLeaveSent = sendCalls.some(
      (args: unknown[]) => (args[0] as Record<string, unknown>)?.type === "voice_leave",
    );
    expect(voiceLeaveSent).toBe(false);
  });

  // OC-0201: a full-ready resync that preserves a live voice session (the
  // LiveKit room outlived a WS drop) never replays voice_leave for anyone
  // who departed the channel while the socket was down — `ready` rebuilds
  // voiceUsers wholesale and stops. Without reconciliation, a departed peer
  // keeps a working room key forever (no rotation ever runs for them) and a
  // client newly elected key holder by the server-side re-registration never
  // self-elects, since only handleParticipantLeft runs the election.
  it("reconciles E2EE state for peers who left during a full-ready resync with a live voice session", async () => {
    vi.mocked(mockHandleParticipantLeft).mockClear();

    signInAs(
      { id: 42, username: "me", avatar: null, role: "member" },
      { token: "test-token", serverName: "Test", motd: "" },
    );

    // Before the resync: self (42) and peer (7) are both in channel 10 — the
    // live LiveKit session survived the WS drop.
    patchVoice({
      voiceStatus: "connected",
      currentChannelId: 10,
      voiceUsers: new Map([
        [
          10,
          new Map([
            [
              42,
              {
                userId: 42,
                username: "me",
                muted: false,
                deafened: false,
                speaking: false,
                camera: false,
                screenshare: false,
                serverMuted: false,
                serverDeafened: false,
              },
            ],
            [
              7,
              {
                userId: 7,
                username: "departed",
                muted: false,
                deafened: false,
                speaking: false,
                camera: false,
                screenshare: false,
                serverMuted: false,
                serverDeafened: false,
              },
            ],
          ]),
        ],
      ]),
    });

    // The full resync's voice_states shows peer 7 has left channel 10 while
    // we were disconnected — only self remains.
    mock.dispatch(
      "ready",
      readyEvent({
        channels: [readyChannel({ category: "" })],
        voice_states: [{ user_id: 42, channel_id: 10, muted: false, deafened: false }],
        dm_channels: [],
      }),
    );
    await vi.runAllTimersAsync();

    expect(mockHandleParticipantLeft).toHaveBeenCalledWith(7);
    // Must never be called for ourselves.
    expect(mockHandleParticipantLeft).not.toHaveBeenCalledWith(42);
  });

  // ─── Voice capacity refusals ────────────────────────────────────────────
  //
  // The server owns voice_max_users / voice_max_video and answers an over-limit
  // join with CHANNEL_FULL (or an over-limit camera with VIDEO_LIMIT). The
  // client deliberately does not pre-block the click — its participant list can
  // lag, and a refusal it invented would be uncorrectable — so the only thing
  // standing between the user and a silent no-op is this toast.

  describe("voice capacity errors", () => {
    beforeEach(() => {
      mockShowToast.mockClear();
    });

    it("surfaces CHANNEL_FULL as a toast with its catalog text, not the server's message", () => {
      mock.dispatch("error", { code: "CHANNEL_FULL", message: "voice channel is full" });
      expectConsole("error", /\[dispatcher\] Server error/);
      expect(mockShowToast).toHaveBeenCalledWith("That voice channel is full", "error");
    });

    it("surfaces VIDEO_LIMIT as a toast", () => {
      mock.dispatch("error", { code: "VIDEO_LIMIT", message: "" });
      expectConsole("error", /\[dispatcher\] Server error/);
      expect(mockShowToast).toHaveBeenCalledWith(
        "That voice channel has reached its video limit",
        "error",
      );
    });

    // max_video has no SFU-level enforcement — the server's VIDEO_LIMIT refusal
    // only rejects the DB write. Without a client-side rollback the refused
    // camera track keeps publishing (and streaming to everyone) while
    // voice_state says camera=false, so VIDEO_LIMIT is otherwise cosmetic.
    it("rolls back the local camera publish on VIDEO_LIMIT", async () => {
      mock.dispatch("error", { code: "VIDEO_LIMIT", message: "" });
      expectConsole("error", /\[dispatcher\] Server error/);
      await vi.runAllTimersAsync();

      expect(mockDisableCamera).toHaveBeenCalled();
    });

    // A capacity refusal is about the voice channel, not about the composer,
    // so it must not also land in the login screen's transient-error slot.
    it("does not set the transient error", () => {
      uiStore.setState((prev) => ({ ...prev, transientError: null }));
      mock.dispatch("error", { code: "CHANNEL_FULL", message: "full" });
      expectConsole("error", /\[dispatcher\] Server error/);
      expect(uiStore.getState().transientError).toBeNull();
    });

    // The sidebar/widget optimistically writes currentChannelId (voiceStatus
    // "joining") before the server answers. A first-time join has no prior
    // channel to leave, so no voice_leave ever arrives to clean that up —
    // without a rollback here, currentChannelId is stuck pointing at a
    // channel with no LiveKit session, and the sidebar's recovery click tears
    // down whatever *is* live instead.
    it("rolls back the optimistic join on a first-time CHANNEL_FULL", () => {
      patchVoice({ currentChannelId: 5, voiceStatus: "joining" });

      mock.dispatch("error", { code: "CHANNEL_FULL", message: "full" });
      expectConsole("error", /\[dispatcher\] Server error/);

      expect(voiceStore.getState().currentChannelId).toBeNull();
      expect(voiceStore.getState().voiceStatus).toBe("idle");
    });

    // A channel-*switch* refusal is different: the server leaves the old
    // channel first, whose self voice_leave already reset voiceStatus to
    // idle by the time this error lands — so the guard above is a no-op and
    // must not blow away a genuinely connected session.
    it("does not touch an already-established voice session on CHANNEL_FULL", () => {
      patchVoice({ currentChannelId: 5, voiceStatus: "connected" });

      mock.dispatch("error", { code: "CHANNEL_FULL", message: "full" });
      expectConsole("error", /\[dispatcher\] Server error/);

      expect(voiceStore.getState().currentChannelId).toBe(5);
      expect(voiceStore.getState().voiceStatus).toBe("connected");
    });

    // OC-0224: CHANNEL_FULL is not the only refusal voice_join can get back.
    // handleVoiceJoin also answers with VOICE_ERROR (LiveKit down/unconfigured),
    // FORBIDDEN (blocked / revoked CONNECT_VOICE), NOT_FOUND, BAD_REQUEST
    // (archived channel), RATE_LIMITED, ALREADY_JOINED, and INTERNAL (token
    // mint failure) — every one of those used to fall through to the
    // catch-all with no rollback, leaving voiceStatus stuck at "joining"
    // forever (setVoiceStatus("idle") only ever runs inside
    // LiveKitSession.leaveVoice(), and a refused first-time join gets no
    // voice_leave to trigger it).
    it("rolls back the optimistic join on a voice_join refusal other than CHANNEL_FULL", () => {
      patchVoice({ currentChannelId: 5, voiceStatus: "joining" });

      mock.dispatch("error", { code: "VOICE_ERROR", message: "voice is not configured" });
      expectConsole("error", /\[dispatcher\] Server error/);

      expect(voiceStore.getState().currentChannelId).toBeNull();
      expect(voiceStore.getState().voiceStatus).toBe("idle");
    });

    // P2-T5: a refused rejoin (a moderator removal the reconnect loop tried to
    // undo) ends the call through the session, which owns the voice-lost toast.
    it("hands a voice_join refusal to the session's pending reconnect rejoin", async () => {
      vi.mocked(mockFailPendingRejoin).mockClear();
      patchVoice({ currentChannelId: 5, voiceStatus: "joining" });

      mock.dispatch("error", {
        code: "FORBIDDEN",
        message: "You were removed from this voice channel",
      });
      expectConsole("error", /\[dispatcher\] Server error/);
      await vi.runAllTimersAsync();

      expect(mockFailPendingRejoin).toHaveBeenCalledTimes(1);
      expect(voiceStore.getState().currentChannelId).toBeNull();
      expect(voiceStore.getState().voiceStatus).toBe("idle");
    });

    it("rolls back the optimistic join on FORBIDDEN (revoked CONNECT_VOICE / blocked)", () => {
      patchVoice({ currentChannelId: 5, voiceStatus: "joining" });

      mock.dispatch("error", { code: "FORBIDDEN", message: "missing CONNECT_VOICE permission" });
      expectConsole("error", /\[dispatcher\] Server error/);

      expect(voiceStore.getState().currentChannelId).toBeNull();
      expect(voiceStore.getState().voiceStatus).toBe("idle");
    });

    // OC-0193: a channel *switch* refusal (precheck FORBIDDEN/BAD_REQUEST/
    // RATE_LIMITED — anything that lands before the server's self voice_leave
    // for the OLD channel) optimistically moved currentChannelId to the NEW
    // channel and voiceStatus to "joining", but the LiveKit room from the OLD
    // channel is still live — connected, mic published. The store-only
    // leaveVoiceChannel() rollback used to leave that session dangling: the
    // widget disappears (currentChannelId null hides it entirely) while audio
    // keeps flowing and the server still lists us in the old channel. The
    // rollback must also tear down the live LiveKit session so the media
    // state and the store agree.
    it("tears down a still-live LiveKit session when a channel-switch join is refused", async () => {
      vi.mocked(mockLeaveVoice).mockClear();
      // OC-0249: the dispatcher asks isVoiceSessionActive() (true for a live
      // "connected" room too, not just an in-flight "connecting" one) rather
      // than isVoiceConnected(), so a genuinely connected session is covered
      // by the same guard as the in-flight case exercised below.
      vi.mocked(mockIsVoiceSessionActive).mockReturnValue(true);
      patchVoice({ currentChannelId: 7, voiceStatus: "joining" });

      mock.dispatch("error", { code: "FORBIDDEN", message: "missing CONNECT_VOICE permission" });
      expectConsole("error", /\[dispatcher\] Server error/);
      await vi.runAllTimersAsync();

      expect(mockLeaveVoice).toHaveBeenCalledWith(true);
      expect(voiceStore.getState().currentChannelId).toBeNull();
      expect(voiceStore.getState().voiceStatus).toBe("idle");

      vi.mocked(mockIsVoiceSessionActive).mockReturnValue(false);
    });

    // A server that echoes the join's envelope id on its refusals lets the
    // rollback tell the join's own refusal from an error answering another
    // command, which must leave the join in flight.
    it("leaves a voice join in place on an unrelated error during it", () => {
      patchVoice({ currentChannelId: 5, voiceStatus: "joining" });
      noteJoinSent("join-1");

      mock.dispatch("error", { code: "FORBIDDEN", message: "cannot edit" }, "other");
      expectConsole("error", /\[dispatcher\] Server error/);

      expect(voiceStore.getState().currentChannelId).toBe(5);
      expect(voiceStore.getState().voiceStatus).toBe("joining");
    });

    it("rolls a voice join back on the refusal carrying its id", () => {
      patchVoice({ currentChannelId: 5, voiceStatus: "joining" });
      noteJoinSent("join-1");

      mock.dispatch("error", { code: "FORBIDDEN", message: "denied" }, "join-1");
      expectConsole("error", /\[dispatcher\] Server error/);

      expect(voiceStore.getState().currentChannelId).toBeNull();
      expect(voiceStore.getState().voiceStatus).toBe("idle");
    });
  });

  // A server refusal of voice_camera/voice_screenshare (FORBIDDEN,
  // RATE_LIMITED, INTERNAL, ...) other than VIDEO_LIMIT is otherwise
  // unhandled — the already-published track keeps streaming to every peer
  // while the store says it's off. Correlated by envelope id, exactly like
  // pendingSends/pendingReactions above, so an unrelated refusal on some
  // other action never touches video state.
  describe("voice video-enable refusal rollback", () => {
    beforeEach(() => {
      vi.mocked(mockRollbackPendingVideo).mockReset().mockReturnValue(undefined);
      vi.mocked(mockDisableCamera).mockClear();
      vi.mocked(mockDisableScreenshare).mockClear();
      uiStore.setState((prev) => ({ ...prev, transientError: null }));
      mockShowToast.mockClear();
    });

    // OC-0064: the catch-all now toasts in-app instead of latching
    // transientError (which only the login screen ever reads).
    it("rolls back the camera publish on a correlated refusal", async () => {
      vi.mocked(mockRollbackPendingVideo).mockReturnValue("camera");

      mock.dispatch(
        "error",
        { code: "FORBIDDEN", message: "missing CONNECT_VIDEO permission" },
        "vid-1",
      );
      expectConsole("error", /\[dispatcher\] Server error/);
      await vi.runAllTimersAsync();

      expect(mockRollbackPendingVideo).toHaveBeenCalledWith("vid-1");
      expect(mockDisableCamera).toHaveBeenCalled();
      expect(mockDisableScreenshare).not.toHaveBeenCalled();
      expect(mockShowToast).toHaveBeenCalledWith("You don't have permission to do that.", "error");
      expect(uiStore.getState().transientError).toBeNull();
    });

    it("rolls back the screenshare publish on a correlated refusal", async () => {
      vi.mocked(mockRollbackPendingVideo).mockReturnValue("screen");

      mock.dispatch("error", { code: "RATE_LIMITED", message: "" }, "vid-2");
      expectConsole("error", /\[dispatcher\] Server error/);
      await vi.runAllTimersAsync();

      expect(mockDisableScreenshare).toHaveBeenCalled();
      expect(mockDisableCamera).not.toHaveBeenCalled();
      expect(mockShowToast).toHaveBeenCalledWith("Too many requests. Try again later.", "error");
      expect(uiStore.getState().transientError).toBeNull();
    });

    it("leaves an uncorrelated refusal as a plain in-app toast — no rollback", () => {
      vi.mocked(mockRollbackPendingVideo).mockReturnValue(undefined);

      mock.dispatch("error", { code: "FORBIDDEN", message: "nope" }, "unrelated-id");
      expectConsole("error", /\[dispatcher\] Server error/);

      expect(mockDisableCamera).not.toHaveBeenCalled();
      expect(mockDisableScreenshare).not.toHaveBeenCalled();
      expect(mockShowToast).toHaveBeenCalledWith("Nope", "error");
      expect(uiStore.getState().transientError).toBeNull();
    });

    // OC-0032: voice_controls.go now routes a refused voice_screenshare
    // enable through the same enableVideoSlot cap check as the camera, so
    // VIDEO_LIMIT can correlate to a "screen" pending enable, not just
    // "camera". Rolling back the camera unconditionally would tear down a
    // working camera and leave the refused screen tracks published.
    it("rolls back the screenshare publish, not the camera, when VIDEO_LIMIT refuses a screenshare enable", async () => {
      vi.mocked(mockRollbackPendingVideo).mockReturnValue("screen");

      mock.dispatch("error", { code: "VIDEO_LIMIT", message: "" }, "vid-screen-1");
      expectConsole("error", /\[dispatcher\] Server error/);
      await vi.runAllTimersAsync();

      expect(mockRollbackPendingVideo).toHaveBeenCalledWith("vid-screen-1");
      expect(mockDisableScreenshare).toHaveBeenCalled();
      expect(mockDisableCamera).not.toHaveBeenCalled();
    });

    // OC-0035: a screenshare enable can be superseded (disable, re-enable)
    // before its VIDEO_LIMIT refusal arrives — registerPendingVideoEnable
    // deletes the prior entry for that kind, so rollbackPendingVideo(id)
    // returns undefined for the now-stale id. undefined means "roll back
    // nothing" (the refusal no longer correlates to anything pending), never
    // "it was the camera" — falling through to disableCamera() would tear
    // down a working camera the user never touched.
    it("does nothing when VIDEO_LIMIT correlates to a superseded id (kind undefined)", async () => {
      vi.mocked(mockRollbackPendingVideo).mockReturnValue(undefined);

      mock.dispatch("error", { code: "VIDEO_LIMIT", message: "" }, "vid-superseded-1");
      expectConsole("error", /\[dispatcher\] Server error/);
      await vi.runAllTimersAsync();

      expect(mockRollbackPendingVideo).toHaveBeenCalledWith("vid-superseded-1");
      expect(mockDisableCamera).not.toHaveBeenCalled();
      expect(mockDisableScreenshare).not.toHaveBeenCalled();
    });
  });
});
