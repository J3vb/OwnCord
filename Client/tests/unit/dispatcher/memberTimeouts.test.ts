import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as dispatcherMocks from "../../helpers/dispatcherMocks";
import { memberTimeoutsStore, setMemberTimeouts } from "../../../src/features/moderation/store";
import { voiceStore } from "../../../src/stores/voice.store";
import {
  setMuted as mockSetMuted,
  setDeafened as mockSetDeafened,
} from "@lib/voice/livekitSession";
import {
  useDispatcherHarness,
  type DispatcherMock,
  setMeUser,
  readyEvent,
  readyMember,
  patchVoice,
} from "../../helpers/dispatcherHarness";

vi.mock("@lib/notifications", () => dispatcherMocks.notificationsMock());
vi.mock("@lib/voice/livekitSession", () => dispatcherMocks.livekitSessionMock());
vi.mock("@lib/voice/screenShare", () => dispatcherMocks.screenShareMock());
vi.mock("@lib/ui/toast", () => dispatcherMocks.toastMock());
vi.mock("@lib/net/identity", () => dispatcherMocks.identityMock());
vi.mock("../../../src/features/connection/dispatchContext", async (importOriginal) =>
  dispatcherMocks.dispatchContextMock(await importOriginal<object>()),
);

describe("WS Dispatcher", () => {
  let cleanup: () => void;
  let mock: DispatcherMock;

  useDispatcherHarness({
    wired: (m, c) => {
      mock = m;
      cleanup = c;
    },
    currentCleanup: () => cleanup,
  });

  // OC-0014: a moderator deafen/mute has no SFU equivalent — the client is
  // the only place it takes effect (via setDeafened/setMuted, which gate
  // remote-audio subscription). The VOICE_STATE handler enforces this, but a
  // full-ready resync (a WS drop that outlives the LiveKit session, followed
  // by a mustFullResync reconnect) only ever delivers the mute/deafen via
  // `ready`'s voice_states, never a voice_state the client can miss. Without
  // enforcement on this path too, the widget shows the user as deafened while
  // every remote publication stays subscribed and audible.
  it("enforces a moderator server-deafen/mute from the ready (full-resync) payload", async () => {
    setMeUser();
    // The LiveKit session survived the WS drop (nothing tears voice down on a
    // socket drop alone) — voiceStatus is NOT idle, so the "stale voice
    // state" defense-in-depth branch below must not fire and swallow this.
    patchVoice({ currentChannelId: 3, voiceStatus: "connected" });

    mock.dispatch(
      "ready",
      readyEvent({
        members: [readyMember({ id: 5, username: "me" })],
        voice_states: [
          {
            channel_id: 3,
            user_id: 5,
            muted: true,
            deafened: true,
            server_muted: true,
            server_deafened: true,
          },
        ],
      }),
    );
    await vi.runAllTimersAsync();

    expect(vi.mocked(mockSetDeafened)).toHaveBeenCalledWith(true);
    expect(vi.mocked(mockSetMuted)).toHaveBeenCalledWith(true);
  });

  // The same resync path with the flags absent/false: `ready` restates our
  // voice state on every full resync, so reading it as a moderator action
  // would silently deafen a session nobody moderated (and there is no
  // server-side undo — deafen only ever exists on this client).
  it("leaves local audio alone on a ready whose self voice_state has no moderator flags", async () => {
    vi.mocked(mockSetDeafened).mockClear();
    vi.mocked(mockSetMuted).mockClear();
    setMeUser();
    patchVoice({ currentChannelId: 3, voiceStatus: "connected" });

    mock.dispatch(
      "ready",
      readyEvent({
        members: [readyMember({ id: 5, username: "me" })],
        voice_states: [
          {
            channel_id: 3,
            user_id: 5,
            muted: false,
            deafened: false,
            server_muted: false,
            server_deafened: false,
          },
        ],
      }),
    );
    await vi.runAllTimersAsync();

    expect(vi.mocked(mockSetDeafened)).not.toHaveBeenCalled();
    expect(vi.mocked(mockSetMuted)).not.toHaveBeenCalled();
  });

  // (21) the member menu's timeout view (WP 3C-3, data half of 3C-7c)
  describe("member timeouts", () => {
    const emptyReady = { channels: [], members: [], voice_states: [], roles: [], dm_channels: [] };

    afterEach(() => setMemberTimeouts(undefined));

    it("fills the store from ready.member_timeouts, replacing the previous map", () => {
      mock.dispatch("ready", {
        ...emptyReady,
        member_timeouts: [{ user_id: 4, expires_at: "2099-01-01T00:00:00Z" }],
      });
      expect(memberTimeoutsStore.getState()).toEqual(new Map([[4, "2099-01-01T00:00:00Z"]]));

      mock.dispatch("ready", {
        ...emptyReady,
        member_timeouts: [{ user_id: 9, expires_at: "2099-02-02T00:00:00Z" }],
      });
      expect(memberTimeoutsStore.getState()).toEqual(new Map([[9, "2099-02-02T00:00:00Z"]]));
    });

    it("sets the store to null when ready carries no member_timeouts (an older server)", () => {
      mock.dispatch("ready", {
        ...emptyReady,
        member_timeouts: [{ user_id: 4, expires_at: "2099-01-01T00:00:00Z" }],
      });
      mock.dispatch("ready", emptyReady);
      expect(memberTimeoutsStore.getState()).toBeNull();
    });

    it("replaces the whole map on a member_timeouts frame", () => {
      mock.dispatch("ready", {
        ...emptyReady,
        member_timeouts: [{ user_id: 4, expires_at: "2099-01-01T00:00:00Z" }],
      });
      mock.dispatch("member_timeouts", {
        timeouts: [{ user_id: 5, expires_at: "2099-03-03T00:00:00Z" }],
      });
      expect(memberTimeoutsStore.getState()).toEqual(new Map([[5, "2099-03-03T00:00:00Z"]]));

      mock.dispatch("member_timeouts", { timeouts: [] });
      expect(memberTimeoutsStore.getState()).toEqual(new Map());
    });
  });

  it("mirrors a moderator mute/deafen into the local flags and honors it", async () => {
    setMeUser();
    patchVoice({ voiceStatus: "joining" });

    mock.dispatch("voice_state", {
      channel_id: 3,
      user_id: 5,
      username: "me",
      muted: true,
      deafened: true,
      speaking: false,
      camera: false,
      screenshare: false,
      server_muted: true,
      server_deafened: true,
    });

    const state = voiceStore.getState();
    expect(state.localServerMuted).toBe(true);
    expect(state.localServerDeafened).toBe(true);

    // Deafen is client-enforced: the session must stop playing remote audio.
    await vi.runAllTimersAsync();
    expect(vi.mocked(mockSetDeafened)).toHaveBeenCalledWith(true);
    expect(vi.mocked(mockSetMuted)).toHaveBeenCalledWith(true);
  });

  // server_muted and server_deafened are independent flags and each one is
  // enforced separately: applying the pair whenever either is set would mute
  // a user no moderator muted, and re-applying one the client has already
  // honoured would fight the local toggle on every restated voice_state.
  describe("moderator audio enforcement is scoped to the flags actually set", () => {
    beforeEach(() => {
      vi.mocked(mockSetDeafened).mockClear();
      vi.mocked(mockSetMuted).mockClear();
      setMeUser();
      patchVoice({ voiceStatus: "joining" });
    });

    function dispatchSelfVoiceState(flags: {
      server_muted?: boolean;
      server_deafened?: boolean;
    }): void {
      mock.dispatch("voice_state", {
        channel_id: 3,
        user_id: 5,
        username: "me",
        muted: false,
        deafened: false,
        speaking: false,
        camera: false,
        screenshare: false,
        ...flags,
      });
    }

    const cases = [
      { name: "only server_deafened is set", flags: { server_deafened: true }, deafen: 1, mute: 0 },
      { name: "only server_muted is set", flags: { server_muted: true }, deafen: 0, mute: 1 },
      { name: "neither flag is present", flags: {}, deafen: 0, mute: 0 },
      {
        name: "both flags are explicitly false",
        flags: { server_muted: false, server_deafened: false },
        deafen: 0,
        mute: 0,
      },
    ] as const;

    for (const c of cases) {
      it(`calls setDeafened ${c.deafen}x and setMuted ${c.mute}x when ${c.name}`, async () => {
        dispatchSelfVoiceState(c.flags);
        await vi.runAllTimersAsync();

        expect(vi.mocked(mockSetDeafened)).toHaveBeenCalledTimes(c.deafen);
        expect(vi.mocked(mockSetMuted)).toHaveBeenCalledTimes(c.mute);
      });
    }

    it("does not re-apply a moderator mute/deafen the client already honoured", async () => {
      patchVoice({ localMuted: true, localDeafened: true });

      dispatchSelfVoiceState({ server_muted: true, server_deafened: true });
      await vi.runAllTimersAsync();

      expect(vi.mocked(mockSetDeafened)).not.toHaveBeenCalled();
      expect(vi.mocked(mockSetMuted)).not.toHaveBeenCalled();
    });

    // OC-0246: enforceModeratorAudioState only ever applies a restriction —
    // once a moderator lifts server_muted/server_deafened, the client must
    // release the local mute/deafen it applied earlier, or the user stays
    // silent/deaf forever while every peer's roster (and localServerMuted/
    // localServerDeafened, which gate the widget's own controls) say they
    // are no longer restricted.
    it("releases a moderator mute/deafen once the server lifts it", async () => {
      patchVoice({
        localMuted: true,
        localDeafened: true,
        moderatorDeafened: true,
        localServerMuted: true,
        localServerDeafened: true,
      });

      dispatchSelfVoiceState({ server_muted: false, server_deafened: false });
      await vi.runAllTimersAsync();

      expect(voiceStore.getState().localServerMuted).toBe(false);
      expect(voiceStore.getState().localServerDeafened).toBe(false);
      expect(vi.mocked(mockSetMuted)).toHaveBeenCalledWith(false);
      expect(vi.mocked(mockSetDeafened)).toHaveBeenCalledWith(false);
    });

    // The release must not fire on every restated voice_state showing
    // server_muted/server_deafened already false — only on the falling edge
    // (previously true, now false) — or an unrelated voice_state (e.g. from a
    // camera toggle) that happens to arrive while the user is NOT moderator
    // restricted would repeatedly no-op through the livekit calls. More
    // importantly, a moderator flag that was never true must never release a
    // mute the user applied themselves.
    it("does not release a self-applied mute when no moderator restriction was ever in effect", async () => {
      patchVoice({
        localMuted: true,
        localDeafened: false,
        localServerMuted: false,
        localServerDeafened: false,
      });

      dispatchSelfVoiceState({ server_muted: false, server_deafened: false });
      await vi.runAllTimersAsync();

      expect(vi.mocked(mockSetMuted)).not.toHaveBeenCalled();
      expect(vi.mocked(mockSetDeafened)).not.toHaveBeenCalled();
    });
  });

  it("does not set the local moderator flags from another user's voice_state", () => {
    setMeUser();

    mock.dispatch("voice_state", {
      channel_id: 3,
      user_id: 99,
      username: "other",
      muted: true,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
      server_muted: true,
    });

    expect(voiceStore.getState().localServerMuted).not.toBe(true);
    expect(voiceStore.getState().voiceUsers.get(3)?.get(99)?.serverMuted).toBe(true);
  });
});
