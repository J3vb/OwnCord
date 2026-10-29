import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleVoiceDisconnected,
  handleVoiceE2eeAnnounce,
  handleVoiceE2eeOffer,
  handleVoiceError,
  handleVoiceJoinRollback,
  handleVoiceLeave,
  handleVoiceMoved,
  handleVoiceState,
  handleVoiceWatching,
  handleVoiceWatchError,
  rollbackVideoOnError,
  snapshotReadyVoice,
} from "./wsHandlers";
import {
  voiceStore,
  resetVoiceStore,
  joinVoiceChannel,
  leaveVoiceChannel,
  setVoiceStatus,
  setLocalDeafened,
  clearPeerVerifications,
  streamViewers,
  isWatchingResync,
  clearPeerWatching,
  setPeerWatching,
  setPeerVideoDecode,
} from "../../stores/voice.store";
import { authStore } from "../../stores/auth.store";
import { channelsStore } from "../../stores/channels.store";
import { membersStore } from "../../stores/members.store";
import { noteWatchSent, resetWatchRequest } from "../../lib/watchRequest";
import { clearAfkMove } from "./moveHint";
import { joinRetryInMs, noteJoinSucceeded } from "./joinBackoff";
import { noteJoinSent, resetJoinRequest } from "./joinRequest";
import type { Payload, ReconnectClock } from "../connection/dispatchContext";

vi.mock("../../lib/livekitSession", () => ({
  setMuted: vi.fn(),
  setDeafened: vi.fn(),
  leaveVoice: vi.fn(),
  handleParticipantLeft: vi.fn(async () => {}),
  handleE2EEAnnounce: vi.fn(async () => {}),
  handleE2EEOffer: vi.fn(async () => {}),
  disableCamera: vi.fn(),
  disableScreenshare: vi.fn(),
  isVoiceSessionActive: vi.fn(() => false),
  isAutoReconnecting: vi.fn(() => false),
  failPendingRejoin: vi.fn(),
  reconcileVideoFlags: vi.fn(),
  resendWatching: vi.fn(),
  retryWatching: vi.fn(),
}));
vi.mock("../../lib/toast", () => ({ showToast: vi.fn() }));
vi.mock("../../lib/screenShare", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/screenShare")>();
  return { ...actual, rollbackPendingVideo: vi.fn() };
});
import {
  setMuted,
  setDeafened,
  leaveVoice,
  handleParticipantLeft,
  handleE2EEAnnounce,
  handleE2EEOffer,
  disableCamera,
  disableScreenshare,
  isVoiceSessionActive,
  failPendingRejoin,
  reconcileVideoFlags,
  resendWatching,
  retryWatching,
} from "../../lib/livekitSession";
import { rollbackPendingVideo } from "../../lib/screenShare";
import { expectConsole } from "../../../tests/helpers/console";
import { captureLogs } from "../../../tests/helpers/log-capture";
import { showToast } from "../../lib/toast";

function voiceState(overrides: Partial<Payload<"voice_state">>): Payload<"voice_state"> {
  return {
    channel_id: 4,
    user_id: 9,
    username: "me",
    muted: false,
    deafened: false,
    speaking: false,
    ...overrides,
  } as Payload<"voice_state">;
}

const clockStub = (): ReconnectClock => ({ voiceRejoinChannelId: null }) as ReconnectClock;
const socketStub = () => ({ send: vi.fn(), disconnect: vi.fn() });
const readyWith = (voiceStates: Payload<"voice_state">[]) =>
  ({ voice_states: voiceStates }) as unknown as Payload<"ready">;

beforeEach(() => {
  resetVoiceStore();
  authStore.setState((prev) => ({
    ...prev,
    user: { id: 9, username: "me", avatar: null, role: "member" },
  }));
  vi.clearAllMocks();
});

describe("snapshotReadyVoice", () => {
  it("leaves another device's call alone: no voice_leave, the roster keeps the user", () => {
    const socket = socketStub();
    const apply = snapshotReadyVoice();

    apply(socket, readyWith([voiceState({})]));

    expect(socket.send).not.toHaveBeenCalled();
    expect(voiceStore.getState().currentChannelId).toBeNull();
    expect(voiceStore.getState().voiceStatus).toBe("idle");
    expect(voiceStore.getState().voiceUsers.get(4)?.has(9)).toBe(true);
    expect(resendWatching).not.toHaveBeenCalled();
  });

  it("does not apply a moderator mute from another device's self row", async () => {
    snapshotReadyVoice()(socketStub(), readyWith([voiceState({ server_muted: true })]));
    await Promise.resolve();

    expect(setMuted).not.toHaveBeenCalled();
    expect(voiceStore.getState().localServerMuted).toBe(false);
  });

  it("reconciles only the peers who left the snapshotted channel during the outage", async () => {
    joinVoiceChannel(4);
    setVoiceStatus("connected");
    voiceStore.setState((prev) => ({
      ...prev,
      voiceUsers: new Map([
        [
          4,
          new Map([
            [7, {} as never],
            [8, {} as never],
          ]),
        ],
      ]),
    }));
    const apply = snapshotReadyVoice();

    apply(socketStub(), readyWith([voiceState({}), voiceState({ user_id: 8 })]));

    await vi.waitFor(() => expect(handleParticipantLeft).toHaveBeenCalledWith(7));
    expect(handleParticipantLeft).toHaveBeenCalledTimes(1);
  });

  it("re-sends our watch set after a full resync that keeps us in voice", async () => {
    joinVoiceChannel(4);
    setVoiceStatus("connected");
    snapshotReadyVoice()(socketStub(), readyWith([voiceState({})]));

    await vi.waitFor(() => expect(resendWatching).toHaveBeenCalledTimes(1));
    expect(isWatchingResync()).toBe(true);
  });

  it("restates a mute toggled while the socket was down", () => {
    joinVoiceChannel(4);
    setVoiceStatus("connected");
    voiceStore.setState((prev) => ({ ...prev, localMuted: true }));
    const socket = socketStub();
    const apply = snapshotReadyVoice();

    apply(socket, readyWith([voiceState({ muted: false })]));

    expect(socket.send).toHaveBeenCalledWith({ type: "voice_mute", payload: { muted: true } });
  });

  it("does not restate a mute the server already holds", () => {
    joinVoiceChannel(4);
    setVoiceStatus("connected");
    voiceStore.setState((prev) => ({ ...prev, localMuted: true }));
    const socket = socketStub();
    const apply = snapshotReadyVoice();

    apply(socket, readyWith([voiceState({ muted: true })]));

    expect(socket.send).not.toHaveBeenCalled();
  });

  it("does not fight the release of a moderator mute lifted while disconnected", () => {
    joinVoiceChannel(4);
    setVoiceStatus("connected");
    voiceStore.setState((prev) => ({ ...prev, localServerMuted: true, localMuted: true }));
    const socket = socketStub();
    const apply = snapshotReadyVoice();

    apply(socket, readyWith([voiceState({ server_muted: false })]));

    expect(socket.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "voice_mute" }));
  });

  it("releases a moderator mute lifted while disconnected, using the pre-ready flags", async () => {
    joinVoiceChannel(4);
    setVoiceStatus("connected");
    voiceStore.setState((prev) => ({ ...prev, localServerMuted: true, localMuted: true }));
    const apply = snapshotReadyVoice();

    apply(socketStub(), readyWith([voiceState({ server_muted: false })]));

    await vi.waitFor(() => expect(setMuted).toHaveBeenCalledWith(false));
  });
});

describe("handleVoiceState moderator enforcement", () => {
  // These run on the device that holds the call; an idle device is covered below.
  beforeEach(() => {
    setVoiceStatus("joining");
  });

  it("applies a moderator mute and deafen to this client", async () => {
    handleVoiceState(socketStub(), voiceState({ server_muted: true, server_deafened: true }));

    await vi.waitFor(() => expect(setDeafened).toHaveBeenCalledWith(true));
    expect(setMuted).toHaveBeenCalledWith(true);
  });

  it("releases a moderator mute on its falling edge only", async () => {
    handleVoiceState(socketStub(), voiceState({ server_muted: true }));
    await vi.waitFor(() => expect(setMuted).toHaveBeenCalledWith(true));
    voiceStore.setState((prev) => ({ ...prev, localMuted: true }));

    handleVoiceState(socketStub(), voiceState({ server_muted: false }));
    await vi.waitFor(() => expect(setMuted).toHaveBeenCalledWith(false));
  });

  it("keeps a member deafened who had deafened themselves before the moderator did", async () => {
    // The member deafened themselves; a moderator deafens, then undeafens.
    voiceStore.setState((prev) => ({ ...prev, localDeafened: true, localMuted: true }));
    const socket = socketStub();
    handleVoiceState(socket, voiceState({ muted: true, deafened: true, server_deafened: true }));
    // The lift clears the row's deafen along with the moderator's.
    handleVoiceState(socket, voiceState({ muted: true, deafened: false, server_deafened: false }));
    await new Promise((r) => setTimeout(r, 0));

    expect(setDeafened).not.toHaveBeenCalledWith(false);
    expect(socket.send).toHaveBeenCalledWith({
      type: "voice_deafen",
      payload: { deafened: true },
    });
  });

  it("releases a deafen only the moderator applied", async () => {
    const socket = socketStub();
    handleVoiceState(socket, voiceState({ deafened: true, server_deafened: true }));
    await vi.waitFor(() => expect(setDeafened).toHaveBeenCalledWith(true));
    voiceStore.setState((prev) => ({ ...prev, localDeafened: true }));

    handleVoiceState(socket, voiceState({ deafened: false, server_deafened: false }));

    await vi.waitFor(() => expect(setDeafened).toHaveBeenCalledWith(false));
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("releases a moderator's deafen lifted after a moderator move", async () => {
    // A moderator deafens a member who had not deafened themselves.
    joinVoiceChannel(4);
    const socket = socketStub();
    handleVoiceState(socket, voiceState({ deafened: true, server_deafened: true }));
    await vi.waitFor(() => expect(setDeafened).toHaveBeenCalledWith(true));
    setLocalDeafened(true);
    // The move: the server's voice_leave for the old channel clears the
    // session's moderator flags, and the re-join restates them.
    leaveVoiceChannel();
    joinVoiceChannel(5);
    handleVoiceState(socket, voiceState({ channel_id: 5, deafened: true, server_deafened: true }));
    vi.mocked(setDeafened).mockClear();

    handleVoiceState(
      socket,
      voiceState({ channel_id: 5, deafened: false, server_deafened: false }),
    );

    await vi.waitFor(() => expect(setDeafened).toHaveBeenCalledWith(false));
    expect(socket.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "voice_deafen" }));
  });

  it("does nothing to local audio for another user's voice state", async () => {
    handleVoiceState(socketStub(), voiceState({ user_id: 10, server_muted: true }));
    await Promise.resolve();
    expect(setMuted).not.toHaveBeenCalled();
  });
});

describe("handleVoiceState on a device without the call", () => {
  it("only updates the roster: no channel, no LiveKit call, no moderator enforcement", async () => {
    const socket = socketStub();

    handleVoiceState(socket, voiceState({ server_muted: true, server_deafened: true }));
    await Promise.resolve();

    const state = voiceStore.getState();
    expect(state.voiceUsers.get(4)?.has(9)).toBe(true);
    expect(state.currentChannelId).toBeNull();
    expect(state.voiceStatus).toBe("idle");
    expect(state.localServerMuted).toBe(false);
    expect(setMuted).not.toHaveBeenCalled();
    expect(setDeafened).not.toHaveBeenCalled();
    expect(socket.send).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("behaves as before for a device whose own join is in flight", () => {
    joinVoiceChannel(4);
    expect(voiceStore.getState().voiceStatus).toBe("joining");

    handleVoiceState(socketStub(), voiceState({ server_muted: true }));

    const state = voiceStore.getState();
    expect(state.currentChannelId).toBe(4);
    expect(state.voiceStatus).toBe("joining");
    expect(state.localServerMuted).toBe(true);
  });
});

describe("handleVoiceLeave on a device without the call", () => {
  it("removes the roster row and tears nothing down", async () => {
    handleVoiceState(socketStub(), voiceState({}));
    expect(voiceStore.getState().voiceUsers.get(4)?.has(9)).toBe(true);

    handleVoiceLeave({ channel_id: 4, user_id: 9 }, clockStub());
    await Promise.resolve();

    expect(voiceStore.getState().voiceUsers.get(4)?.has(9) ?? false).toBe(false);
    expect(voiceStore.getState().voiceStatus).toBe("idle");
    expect(leaveVoice).not.toHaveBeenCalled();
  });
});

describe("handleVoiceDisconnected for a moved call", () => {
  it("tears the call down and shows the reason", async () => {
    joinVoiceChannel(4);
    setVoiceStatus("connected");

    handleVoiceDisconnected({ channel_id: 4, reason: "Call moved to another device" }, clockStub());

    await vi.waitFor(() => expect(leaveVoice).toHaveBeenCalledWith(false));
    expect(voiceStore.getState().voiceStatus).toBe("idle");
    expect(voiceStore.getState().currentChannelId).toBeNull();
    expect(showToast).toHaveBeenCalledWith("Call moved to another device", "error");
  });
});

const refusal = (code: Payload<"error">["code"]): Payload<"error"> => ({ code, message: "" });

describe("handleVoiceJoinRollback", () => {
  beforeEach(() => {
    resetJoinRequest();
  });

  it("rolls back an outstanding join", () => {
    joinVoiceChannel(4);
    expect(voiceStore.getState().voiceStatus).toBe("joining");

    handleVoiceJoinRollback(refusal("CHANNEL_FULL"), undefined);

    expect(voiceStore.getState().currentChannelId).toBeNull();
  });

  it("backs off the next join after a refusal before any voice token", () => {
    // CHANNEL_FULL / FORBIDDEN / VOICE_ERROR / RATE_LIMITED land here with no
    // token issued; without arming the backoff every click re-sent voice_join.
    noteJoinSucceeded();
    joinVoiceChannel(4);
    handleVoiceJoinRollback(refusal("FORBIDDEN"), undefined);
    expect(joinRetryInMs()).toBeGreaterThan(0);
    noteJoinSucceeded();
  });

  it("does not back off an error that lands with no join outstanding", () => {
    noteJoinSucceeded();
    handleVoiceJoinRollback(refusal("FORBIDDEN"), undefined);
    expect(joinRetryInMs()).toBe(0);
  });

  it("ignores an error carrying another command's id", () => {
    joinVoiceChannel(4);
    noteJoinSent("join-1");

    handleVoiceJoinRollback(refusal("FORBIDDEN"), "chat-edit-7");

    expect(voiceStore.getState().currentChannelId).toBe(4);
    expect(voiceStore.getState().voiceStatus).toBe("joining");
  });

  it("rolls back the refusal answering the pending join", () => {
    joinVoiceChannel(4);
    noteJoinSent("join-1");

    handleVoiceJoinRollback(refusal("FORBIDDEN"), "join-1");

    expect(voiceStore.getState().currentChannelId).toBeNull();
  });

  it("does not roll back a newer join for an older join's refusal", () => {
    joinVoiceChannel(4);
    noteJoinSent("join-old");
    joinVoiceChannel(5);
    noteJoinSent("join-new");

    handleVoiceJoinRollback(refusal("CHANNEL_FULL"), "join-old");

    expect(voiceStore.getState().currentChannelId).toBe(5);
    expect(voiceStore.getState().voiceStatus).toBe("joining");
  });

  it("rolls back an id-less join refusal from an older server", () => {
    joinVoiceChannel(4);
    noteJoinSent("join-1");

    handleVoiceJoinRollback(refusal("CHANNEL_FULL"), undefined);

    expect(voiceStore.getState().currentChannelId).toBeNull();
  });

  it("ignores an id-less non-join error while joining", () => {
    joinVoiceChannel(4);
    noteJoinSent("join-1");

    handleVoiceJoinRollback(refusal("INVALID_JSON"), undefined);

    expect(voiceStore.getState().currentChannelId).toBe(4);
  });
});

describe("handleVoiceError", () => {
  it("consumes a capacity refusal with a toast", () => {
    expect(handleVoiceError({ code: "CHANNEL_FULL", message: "" }, undefined)).toBe(true);
    expect(showToast).toHaveBeenCalledWith("That voice channel is full", "error");
  });

  it("leaves every other code to the rest of the chain", () => {
    expect(handleVoiceError({ code: "FORBIDDEN", message: "" }, "id-1")).toBe(false);
    expect(showToast).not.toHaveBeenCalled();
  });
});

const announce = (video_decode?: string[]): Payload<"voice_e2ee_announce"> => ({
  user_id: 5,
  public_key: "k",
  video_decode,
});

describe("handleVoiceE2eeAnnounce", () => {
  it("records the peer's decode list", () => {
    handleVoiceE2eeAnnounce(announce(["vp8", "vp9"]));
    expect(voiceStore.getState().peerVideoDecode?.get(5)).toEqual(["vp8", "vp9"]);
  });

  it("deletes the entry when a later announce omits the field", () => {
    handleVoiceE2eeAnnounce(announce(["vp8"]));
    expect(voiceStore.getState().peerVideoDecode?.has(5)).toBe(true);
    handleVoiceE2eeAnnounce(announce(undefined));
    expect(voiceStore.getState().peerVideoDecode?.has(5)).toBe(false);
  });

  it("drops a peer's list when that peer leaves voice", () => {
    joinVoiceChannel(4);
    handleVoiceE2eeAnnounce(announce(["vp8"]));
    handleVoiceLeave({ channel_id: 4, user_id: 5 }, {
      voiceRejoinChannelId: null,
    } as ReconnectClock);
    expect(voiceStore.getState().peerVideoDecode?.has(5)).toBe(false);
  });

  it("survives clearPeerVerifications but not the session-end resets", () => {
    handleVoiceE2eeAnnounce(announce(["vp8"]));
    clearPeerVerifications();
    expect(voiceStore.getState().peerVideoDecode?.get(5)).toEqual(["vp8"]);
    leaveVoiceChannel();
    expect(voiceStore.getState().peerVideoDecode?.size).toBe(0);
    handleVoiceE2eeAnnounce(announce(["vp8"]));
    resetVoiceStore();
    expect(voiceStore.getState().peerVideoDecode?.size).toBe(0);
  });
});

const raw = (video_decode: unknown): Payload<"voice_e2ee_announce"> =>
  ({ user_id: 5, public_key: "k", video_decode }) as unknown as Payload<"voice_e2ee_announce">;

describe("handleVoiceE2eeAnnounce with a malformed video_decode", () => {
  it.each([null, 7, { vp8: true }, "vp8", ["vp8", 3]])(
    "still hands %j to E2EE and stores nothing",
    async (bad) => {
      handleVoiceE2eeAnnounce(raw(bad));
      await vi.waitFor(() => expect(handleE2EEAnnounce).toHaveBeenCalledWith(5, "k", undefined));
      expect(voiceStore.getState().peerVideoDecode?.has(5)).toBe(false);
    },
  );

  it("keeps at most 8 entries", () => {
    handleVoiceE2eeAnnounce(raw(Array.from({ length: 12 }, (_, i) => `c${i}`)));
    expect(voiceStore.getState().peerVideoDecode?.get(5)).toHaveLength(8);
  });
});

const ack = (channelId: number): void =>
  handleVoiceState(socketStub(), voiceState({ channel_id: channelId, user_id: 9 }));

describe("handleVoiceMoved toast", () => {
  const clock = { voiceRejoinChannelId: null } as ReconnectClock;
  beforeEach(() => {
    clearAfkMove();
    channelsStore.setState((prev) => ({
      ...prev,
      channels: new Map([[4, { id: 4, name: "Parking", type: "voice", afk: true } as never]]),
    }));
  });

  it("says why only once the AFK join is acknowledged", async () => {
    const socket = socketStub();
    handleVoiceMoved(socket, { to_channel_id: 4, reason: "afk" }, clock);
    await vi.waitFor(() =>
      expect(socket.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "voice_join", payload: { channel_id: 4 } }),
      ),
    );
    expect(showToast).not.toHaveBeenCalled();

    ack(4);
    expect(showToast).toHaveBeenCalledExactlyOnceWith(
      "Moved to Parking because you were idle",
      "info",
    );
    // A later state frame for the same channel does not say it again.
    ack(4);
    expect(showToast).toHaveBeenCalledOnce();
  });

  it("names the moderator who moved you, at once", async () => {
    membersStore.setState((prev) => ({
      ...prev,
      members: new Map([
        [7, { id: 7, username: "mod", displayName: "Moddy" } as never],
        [8, { id: 8, username: "plain", displayName: null } as never],
      ]),
    }));
    const socket = socketStub();
    handleVoiceMoved(socket, { to_channel_id: 4, by_user_id: 7 }, clock);
    expect(showToast).toHaveBeenCalledExactlyOnceWith("Moddy moved you to Parking", "info");
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalled());

    vi.mocked(showToast).mockClear();
    handleVoiceMoved(socket, { to_channel_id: 4, by_user_id: 8 }, clock);
    expect(showToast).toHaveBeenCalledExactlyOnceWith("plain moved you to Parking", "info");
  });

  it("falls back to a generic message when the mover or channel is unknown", async () => {
    const socket = socketStub();
    handleVoiceMoved(socket, { to_channel_id: 4, by_user_id: 999 }, clock);
    expect(showToast).toHaveBeenCalledExactlyOnceWith("You were moved to Parking", "info");
    vi.mocked(showToast).mockClear();
    handleVoiceMoved(socket, { to_channel_id: 77, by_user_id: 999 }, clock);
    expect(showToast).toHaveBeenCalledExactlyOnceWith(
      "You were moved to another voice channel",
      "info",
    );
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalled());
  });

  it("does not announce a mover for the AFK sweep's move", async () => {
    const socket = socketStub();
    handleVoiceMoved(socket, { to_channel_id: 4, reason: "afk", by_user_id: 7 }, clock);
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalled());
    expect(showToast).not.toHaveBeenCalled();
  });

  it("says nothing for a move with no reason, even once acknowledged", async () => {
    const socket = socketStub();
    handleVoiceMoved(socket, { to_channel_id: 4 }, clock);
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalled());
    ack(4);
    expect(showToast).not.toHaveBeenCalled();
  });

  it("says nothing when the AFK join is refused", async () => {
    const socket = socketStub();
    handleVoiceMoved(socket, { to_channel_id: 4, reason: "afk" }, clock);
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalled());
    noteJoinSent("join-1");
    setVoiceStatus("joining");
    handleVoiceJoinRollback({ code: "FORBIDDEN", message: "no" }, "join-1");
    joinVoiceChannel(4);
    ack(4);
    expect(showToast).not.toHaveBeenCalled();
  });

  it("says nothing for a move a reconnect abandoned", async () => {
    const socket = socketStub();
    handleVoiceMoved(socket, { to_channel_id: 4, reason: "afk" }, clock);
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalled());

    // The socket dropped before the answer; the fresh ready supersedes the move.
    snapshotReadyVoice()(socketStub(), readyWith([]));
    ack(4);
    expect(showToast).not.toHaveBeenCalled();
  });
});

const member = (userId: number, screenshare = false) => ({
  userId,
  username: `u${String(userId)}`,
  muted: false,
  deafened: false,
  speaking: false,
  camera: false,
  screenshare,
});
const frame = (user_id: number, user_ids: number[]) =>
  ({ user_id, user_ids }) as Payload<"voice_watching">;

const err = (code: string) => ({ code, message: "m" }) as Payload<"error">;

describe("handleVoiceWatching", () => {
  const clock = { voiceRejoinChannelId: null } as ReconnectClock;

  beforeEach(() => {
    resetVoiceStore();
    authStore.setState((prev) => ({ ...prev, user: { id: 1, username: "me" } as never }));
    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 4,
      voiceUsers: new Map([
        [
          4,
          new Map([
            [1, member(1)],
            [2, member(2, true)],
            [5, member(5)],
          ]),
        ],
      ]),
    }));
  });

  it("records a channel member's set", () => {
    handleVoiceWatching(frame(5, [2]));
    expect(voiceStore.getState().peerWatching?.get(5)).toEqual([2]);
  });

  it("ignores a frame for a user not in our channel's roster", () => {
    handleVoiceWatching(frame(99, [2]));
    expect(voiceStore.getState().peerWatching?.size).toBe(0);
  });

  it("ignores a frame that arrives after that user's voice_leave", () => {
    handleVoiceWatching(frame(5, [2]));
    handleVoiceLeave({ channel_id: 4, user_id: 5 }, clock);
    expect(voiceStore.getState().peerWatching?.has(5)).toBe(false);
    handleVoiceWatching(frame(5, [2]));
    expect(voiceStore.getState().peerWatching?.has(5)).toBe(false);
  });

  it("drops non-integer ids, sorts and dedupes, and clears on an empty list", () => {
    handleVoiceWatching({
      user_id: 5,
      user_ids: [9, 2, 2, "x", 1.5],
    } as unknown as Payload<"voice_watching">);
    expect(voiceStore.getState().peerWatching?.get(5)).toEqual([2, 9]);
    handleVoiceWatching(frame(5, []));
    expect(voiceStore.getState().peerWatching?.has(5)).toBe(false);
  });

  it("clears with leaveVoiceChannel and resetVoiceStore", () => {
    handleVoiceWatching(frame(5, [2]));
    leaveVoiceChannel();
    expect(voiceStore.getState().peerWatching?.size).toBe(0);
    joinVoiceChannel(4);
    voiceStore.setState((prev) => ({
      ...prev,
      voiceUsers: new Map([[4, new Map([[5, member(5)]])]]),
    }));
    handleVoiceWatching(frame(5, [2]));
    resetVoiceStore();
    expect(voiceStore.getState().peerWatching?.size).toBe(0);
  });

  it("a resync forgets entries the server does not re-send", () => {
    handleVoiceWatching(frame(5, [2]));
    clearPeerWatching();
    expect(voiceStore.getState().peerWatching?.size).toBe(0);
    handleVoiceWatching(frame(5, [2]));
    expect(voiceStore.getState().peerWatching?.get(5)).toEqual([2]);
  });

  it("a direct channel switch drops the old channel's entries", () => {
    handleVoiceWatching(frame(5, [2]));
    joinVoiceChannel(6);
    expect(voiceStore.getState().peerWatching?.size).toBe(0);
  });

  describe("handleVoiceWatchError", () => {
    beforeEach(() => {
      resetWatchRequest();
      vi.mocked(retryWatching).mockClear();
    });

    it("ignores other frames", () => {
      expect(handleVoiceWatchError(err("RATE_LIMITED"), "x")).toBe(false);
      expect(retryWatching).not.toHaveBeenCalled();
    });

    it("swallows an error to our voice_watch without a retry", async () => {
      noteWatchSent("w1");
      expect(handleVoiceWatchError(err("BAD_REQUEST"), "w1")).toBe(true);
      await Promise.resolve();
      expect(retryWatching).not.toHaveBeenCalled();
    });

    it("retries once for RATE_LIMITED", async () => {
      noteWatchSent("w2");
      expect(handleVoiceWatchError(err("RATE_LIMITED"), "w2")).toBe(true);
      await vi.waitFor(() => expect(retryWatching).toHaveBeenCalledTimes(1));
    });
  });

  describe("streamViewers", () => {
    it("lists members watching the sharer, plus me when I watch locally", () => {
      handleVoiceWatching(frame(5, [2]));
      expect(streamViewers(2)).toEqual([5]);
      expect(streamViewers(2, true)).toEqual([1, 5]);
    });

    it("never lists the sharer, and skips members watching someone else", () => {
      handleVoiceWatching(frame(2, [2]));
      handleVoiceWatching(frame(5, [7]));
      expect(streamViewers(2)).toEqual([]);
    });

    it("is empty unless the sharer's voice user is sharing", () => {
      handleVoiceWatching(frame(2, [5]));
      expect(streamViewers(5)).toEqual([]);
      expect(streamViewers(5, true)).toEqual([]);
    });

    it("is empty outside a channel", () => {
      handleVoiceWatching(frame(5, [2]));
      voiceStore.setState((prev) => ({ ...prev, currentChannelId: null }));
      expect(streamViewers(2)).toEqual([]);
    });
  });
});

describe("handleVoiceE2eeAnnounce identity key", () => {
  it("hands the announcing device's identity key to E2EE when the server sent one", async () => {
    handleVoiceE2eeAnnounce({ ...raw(undefined), identity_public_key: "device-id" });
    await vi.waitFor(() =>
      expect(handleE2EEAnnounce).toHaveBeenCalledWith(5, "k", undefined, "device-id"),
    );
  });

  it.each([null, 7, "", {}])("ignores a malformed identity key %j", async (bad) => {
    handleVoiceE2eeAnnounce({
      ...raw(undefined),
      identity_public_key: bad as unknown as string,
    });
    await vi.waitFor(() => expect(handleE2EEAnnounce).toHaveBeenCalledWith(5, "k", undefined));
  });
});

// ── additional behaviour ────────────────────────────────────────────────────

/** Lets lazy `import()` hand-offs and their continuations finish. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

const clockWith = (id: number | null): ReconnectClock =>
  ({ voiceRejoinChannelId: id }) as ReconnectClock;

const connect = (): void => {
  joinVoiceChannel(4);
  setVoiceStatus("connected");
};

async function awaitAfkMoveNoted(): Promise<void> {
  const socket = socketStub();
  handleVoiceMoved(socket, { to_channel_id: 4, reason: "afk" }, clockWith(null));
  await vi.waitFor(() => expect(socket.send).toHaveBeenCalled());
}

const sentTypes = (socket: { send: ReturnType<typeof vi.fn> }): string[] =>
  socket.send.mock.calls.map((call) => (call[0] as { type: string }).type);

describe("handleVoiceState moderator flags", () => {
  beforeEach(() => {
    setVoiceStatus("joining");
  });

  it("does not treat the member's own deafen as a moderator's", async () => {
    voiceStore.setState((prev) => ({ ...prev, localDeafened: true }));
    const socket = socketStub();

    handleVoiceState(socket, voiceState({ deafened: true, server_deafened: false }));
    await settle();

    expect(sentTypes(socket)).not.toContain("voice_deafen");
    expect(setDeafened).not.toHaveBeenCalled();
  });

  it("marks a moderator's deafen while it lasts and clears the mark when it is lifted", async () => {
    handleVoiceState(socketStub(), voiceState({ deafened: true, server_deafened: true }));
    await vi.waitFor(() => expect(setDeafened).toHaveBeenCalledWith(true));
    expect(voiceStore.getState().moderatorDeafened).toBe(true);
    voiceStore.setState((prev) => ({ ...prev, localDeafened: true }));

    handleVoiceState(socketStub(), voiceState({ deafened: false, server_deafened: false }));
    await vi.waitFor(() => expect(setDeafened).toHaveBeenCalledWith(false));

    expect(voiceStore.getState().moderatorDeafened).toBe(false);
  });

  it("leaves a mute alone when no moderator flag has ever been recorded", async () => {
    voiceStore.setState((prev) => ({
      ...prev,
      localMuted: true,
      localServerMuted: undefined,
    }));

    handleVoiceState(socketStub(), voiceState({ muted: false, server_muted: false }));
    await settle();

    expect(setMuted).not.toHaveBeenCalled();
  });

  it("leaves a deafen alone when no moderator flag has ever been recorded", async () => {
    voiceStore.setState((prev) => ({
      ...prev,
      localDeafened: true,
      localServerDeafened: undefined,
    }));
    const socket = socketStub();

    handleVoiceState(socket, voiceState({ deafened: false, server_deafened: false }));
    await settle();

    expect(setDeafened).not.toHaveBeenCalled();
    expect(sentTypes(socket)).not.toContain("voice_deafen");
  });
});

describe("snapshotReadyVoice resync details", () => {
  it("restates a mute toggled offline when no moderator flag was ever recorded", async () => {
    connect();
    voiceStore.setState((prev) => ({
      ...prev,
      localMuted: true,
      localServerMuted: undefined,
      localServerDeafened: undefined,
    }));
    const socket = socketStub();

    snapshotReadyVoice()(socket, readyWith([voiceState({ muted: false })]));
    await settle();

    expect(socket.send).toHaveBeenCalledWith({ type: "voice_mute", payload: { muted: true } });
    expect(setMuted).not.toHaveBeenCalled();
  });

  it("restates a deafen toggled offline when no moderator flag was ever recorded", async () => {
    connect();
    voiceStore.setState((prev) => ({
      ...prev,
      localDeafened: true,
      localServerMuted: undefined,
      localServerDeafened: undefined,
    }));
    const socket = socketStub();

    snapshotReadyVoice()(socket, readyWith([voiceState({ deafened: false })]));
    await settle();

    expect(socket.send).toHaveBeenCalledWith({
      type: "voice_deafen",
      payload: { deafened: true },
    });
    expect(setDeafened).not.toHaveBeenCalled();
  });

  it("restates a mute toggled offline when the server explicitly reports no moderator mute", () => {
    connect();
    voiceStore.setState((prev) => ({ ...prev, localMuted: true }));
    const socket = socketStub();

    snapshotReadyVoice()(socket, readyWith([voiceState({ muted: false, server_muted: false })]));

    expect(socket.send).toHaveBeenCalledWith({ type: "voice_mute", payload: { muted: true } });
  });

  it("restates a deafen toggled offline when the server explicitly reports no moderator deafen", () => {
    connect();
    voiceStore.setState((prev) => ({ ...prev, localDeafened: true }));
    const socket = socketStub();

    snapshotReadyVoice()(
      socket,
      readyWith([voiceState({ deafened: false, server_deafened: false })]),
    );

    expect(socket.send).toHaveBeenCalledWith({
      type: "voice_deafen",
      payload: { deafened: true },
    });
  });

  it("does not restate anything while a moderator deafen is lifted during the outage", async () => {
    connect();
    voiceStore.setState((prev) => ({
      ...prev,
      localDeafened: true,
      localServerDeafened: true,
      moderatorDeafened: true,
    }));
    const socket = socketStub();

    snapshotReadyVoice()(
      socket,
      readyWith([voiceState({ deafened: false, server_deafened: false })]),
    );

    expect(socket.send).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(setDeafened).toHaveBeenCalledWith(false));
  });

  it("does not restate a deafen while a moderator deafen is in force", () => {
    connect();
    voiceStore.setState((prev) => ({ ...prev, localDeafened: true, localMuted: true }));
    const socket = socketStub();

    snapshotReadyVoice()(socket, readyWith([voiceState({ server_deafened: true })]));

    expect(socket.send).not.toHaveBeenCalled();
  });

  it("matches no self row while signed out", async () => {
    connect();
    authStore.setState((prev) => ({ ...prev, user: null }));

    snapshotReadyVoice()(socketStub(), readyWith([voiceState({ user_id: 0, server_muted: true })]));
    await settle();

    expect(setMuted).not.toHaveBeenCalled();
    expect(resendWatching).not.toHaveBeenCalled();
  });

  it("forgets what other members were watching, as the server re-sends none of it", () => {
    connect();
    voiceStore.setState((prev) => ({
      ...prev,
      voiceUsers: new Map([[4, new Map([[7, member(7)]])]]),
    }));
    setPeerWatching(7, [8]);
    expect(voiceStore.getState().peerWatching?.size).toBe(1);

    snapshotReadyVoice()(socketStub(), readyWith([voiceState({}), voiceState({ user_id: 7 })]));

    expect(voiceStore.getState().peerWatching?.size).toBe(0);
  });

  it("treats a peer now in another channel as having left this one", async () => {
    connect();
    voiceStore.setState((prev) => ({
      ...prev,
      voiceUsers: new Map([[4, new Map([[7, member(7)]])]]),
    }));
    setPeerVideoDecode(7, ["vp8"]);

    snapshotReadyVoice()(
      socketStub(),
      readyWith([voiceState({}), voiceState({ user_id: 7, channel_id: 5 })]),
    );

    await vi.waitFor(() => expect(handleParticipantLeft).toHaveBeenCalledWith(7));
    expect(handleParticipantLeft).toHaveBeenCalledTimes(1);
    expect(voiceStore.getState().peerVideoDecode?.has(7)).toBe(false);
  });

  it("keeps a peer who is still in the channel, and forgets none of the others' decode lists", async () => {
    connect();
    voiceStore.setState((prev) => ({
      ...prev,
      voiceUsers: new Map([
        [
          4,
          new Map([
            [7, member(7)],
            [8, member(8)],
          ]),
        ],
      ]),
    }));
    setPeerVideoDecode(8, ["vp9"]);

    snapshotReadyVoice()(socketStub(), readyWith([voiceState({}), voiceState({ user_id: 8 })]));
    await vi.waitFor(() => expect(handleParticipantLeft).toHaveBeenCalledWith(7));

    expect(handleParticipantLeft).toHaveBeenCalledTimes(1);
    expect(voiceStore.getState().peerVideoDecode?.get(8)).toEqual(["vp9"]);
  });

  it("does not compare rosters across a channel change", async () => {
    connect();
    voiceStore.setState((prev) => ({
      ...prev,
      voiceUsers: new Map([
        [
          4,
          new Map([
            [7, member(7)],
            [8, member(8)],
          ]),
        ],
      ]),
    }));

    snapshotReadyVoice()(socketStub(), readyWith([voiceState({ channel_id: 5 })]));

    await vi.waitFor(() => expect(resendWatching).toHaveBeenCalledTimes(1));
    expect(handleParticipantLeft).not.toHaveBeenCalled();
    expect(reconcileVideoFlags).not.toHaveBeenCalled();
  });

  it.each([
    [true, false],
    [false, true],
    [true, true],
    [false, false],
  ])("reconciles camera=%s screenshare=%s with the server's row", async (camera, screenshare) => {
    connect();

    snapshotReadyVoice()(socketStub(), readyWith([voiceState({ camera, screenshare })]));

    await vi.waitFor(() => expect(reconcileVideoFlags).toHaveBeenCalledWith(camera, screenshare));
  });

  it("reconciles false for flags the server row omits", async () => {
    connect();

    snapshotReadyVoice()(socketStub(), readyWith([voiceState({})]));

    await vi.waitFor(() => expect(reconcileVideoFlags).toHaveBeenCalledWith(false, false));
  });
});

describe("handleVoiceMoved session handling", () => {
  beforeEach(() => {
    clearAfkMove();
    channelsStore.setState((prev) => ({
      ...prev,
      channels: new Map([[4, { id: 4, name: "Parking", type: "voice", afk: true } as never]]),
    }));
  });

  it("cancels a pending restart-rejoin for the old channel", async () => {
    const clock = clockWith(3);
    const socket = socketStub();

    handleVoiceMoved(socket, { to_channel_id: 4 }, clock);

    expect(clock.voiceRejoinChannelId).toBeNull();
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalled());
  });

  it("leaves the old media session without telling the server, then joins the new channel", async () => {
    joinVoiceChannel(3);
    setVoiceStatus("connected");
    voiceStore.setState((prev) => ({ ...prev, localServerMuted: true, encryptionDegraded: true }));
    const socket = socketStub();

    handleVoiceMoved(socket, { to_channel_id: 4 }, clockWith(null));

    await vi.waitFor(() => expect(socket.send).toHaveBeenCalled());
    expect(leaveVoice).toHaveBeenCalledWith(false);
    const state = voiceStore.getState();
    expect(state.currentChannelId).toBe(4);
    expect(state.voiceStatus).toBe("joining");
    // The old session's flags do not follow the member into the new channel.
    expect(state.localServerMuted).toBe(false);
    expect(state.encryptionDegraded).toBe(false);
  });

  it("forgets an AFK move still awaiting its join when a moderator move follows", async () => {
    const socket = socketStub();
    handleVoiceMoved(socket, { to_channel_id: 4, reason: "afk" }, clockWith(null));
    handleVoiceMoved(socket, { to_channel_id: 5 }, clockWith(null));
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledTimes(2));

    ack(4);

    expect(showToast).not.toHaveBeenCalled();
  });
});

describe("handleVoiceDisconnected session handling", () => {
  beforeEach(() => {
    clearAfkMove();
    channelsStore.setState((prev) => ({
      ...prev,
      channels: new Map([[4, { id: 4, name: "Parking", type: "voice", afk: true } as never]]),
    }));
  });

  it("cancels a pending restart-rejoin", async () => {
    joinVoiceChannel(4);
    const clock = clockWith(4);

    handleVoiceDisconnected({ channel_id: 4, reason: "Removed" }, clock);

    expect(clock.voiceRejoinChannelId).toBeNull();
    await vi.waitFor(() => expect(leaveVoice).toHaveBeenCalledWith(false));
  });

  it("forgets an AFK move awaiting its join", async () => {
    const socket = socketStub();
    handleVoiceMoved(socket, { to_channel_id: 4, reason: "afk" }, clockWith(null));
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalled());

    handleVoiceDisconnected({ channel_id: 4, reason: "Removed" }, clockWith(null));
    // The member joins this channel again by hand; no stale AFK note explains it.
    joinVoiceChannel(4);
    ack(4);

    expect(showToast).not.toHaveBeenCalledWith(expect.stringContaining("idle"), "info");
  });

  it("ignores a frame for a channel the member has already left for another", async () => {
    joinVoiceChannel(5);
    const clock = clockWith(5);

    handleVoiceDisconnected({ channel_id: 4, reason: "Removed" }, clock);
    await settle();

    expect(clock.voiceRejoinChannelId).toBe(5);
    expect(leaveVoice).not.toHaveBeenCalled();
    expect(voiceStore.getState().currentChannelId).toBe(5);
    expect(showToast).not.toHaveBeenCalled();
  });

  it("shows a default reason when the server gives none", async () => {
    joinVoiceChannel(4);

    handleVoiceDisconnected({ channel_id: 4, reason: "" }, clockWith(null));

    expect(showToast).toHaveBeenCalledWith("You were disconnected from voice", "error");
    await vi.waitFor(() => expect(leaveVoice).toHaveBeenCalledWith(false));
  });
});

describe("handleVoiceLeave session handling", () => {
  beforeEach(() => {
    clearAfkMove();
    channelsStore.setState((prev) => ({
      ...prev,
      channels: new Map([[4, { id: 4, name: "Parking", type: "voice", afk: true } as never]]),
    }));
  });

  it("ends an AFK move when the member's own leave arrives", async () => {
    await awaitAfkMoveNoted();

    handleVoiceLeave({ channel_id: 3, user_id: 9 }, clockWith(null));
    ack(4);

    expect(showToast).not.toHaveBeenCalled();
  });

  it("keeps an AFK move when someone else leaves", async () => {
    await awaitAfkMoveNoted();

    handleVoiceLeave({ channel_id: 3, user_id: 10 }, clockWith(null));
    ack(4);

    expect(showToast).toHaveBeenCalledWith("Moved to Parking because you were idle", "info");
  });

  it("cancels a pending restart-rejoin on the member's own leave only", () => {
    const own = clockWith(4);
    handleVoiceLeave({ channel_id: 4, user_id: 9 }, own);
    expect(own.voiceRejoinChannelId).toBeNull();

    const other = clockWith(4);
    handleVoiceLeave({ channel_id: 4, user_id: 10 }, other);
    expect(other.voiceRejoinChannelId).toBe(4);
  });

  it("does not clear a channel joined between the leave and the media teardown", async () => {
    joinVoiceChannel(4);
    setVoiceStatus("connected");

    handleVoiceLeave({ channel_id: 4, user_id: 9 }, clockWith(null));
    expect(voiceStore.getState().currentChannelId).toBeNull();
    joinVoiceChannel(5);
    await vi.waitFor(() => expect(leaveVoice).toHaveBeenCalledWith(false));

    expect(voiceStore.getState().currentChannelId).toBe(5);
  });

  it("leaves the store to the reconnect loop while it owns the session", async () => {
    joinVoiceChannel(4);
    setVoiceStatus("reconnecting");

    handleVoiceLeave({ channel_id: 4, user_id: 9 }, clockWith(null));

    expect(voiceStore.getState().currentChannelId).toBe(4);
    await vi.waitFor(() => expect(leaveVoice).toHaveBeenCalledWith(false));
    expect(voiceStore.getState().currentChannelId).toBeNull();
  });
});

describe("handleVoiceE2eeAnnounce and offer hand-off", () => {
  it("still hands the key to the session when the decode list cannot be recorded", async () => {
    voiceStore.setState((prev) => ({ ...prev, peerVideoDecode: {} as never }));

    handleVoiceE2eeAnnounce(announce(["vp8"]));

    expectConsole("warn", /could not record video_decode/);
    await vi.waitFor(() => expect(handleE2EEAnnounce).toHaveBeenCalledWith(5, "k", undefined));
  });

  it("passes an offer's sender, key and iv to the session", async () => {
    handleVoiceE2eeOffer({ from_user_id: 6, encrypted_key: "ek", iv: "iv1" });

    await vi.waitFor(() => expect(handleE2EEOffer).toHaveBeenCalledWith(6, "ek", "iv1"));
  });
});

describe("handleVoiceWatchError retry", () => {
  beforeEach(() => {
    resetWatchRequest();
  });

  it("does not retry for a refusal other than rate limiting", async () => {
    noteWatchSent("w1");

    expect(handleVoiceWatchError(err("FORBIDDEN"), "w1")).toBe(true);
    await settle();

    expect(retryWatching).not.toHaveBeenCalled();
  });

  it("survives a failed retry", async () => {
    vi.mocked(retryWatching).mockRejectedValueOnce(new Error("no session"));
    noteWatchSent("w1");

    expect(handleVoiceWatchError(err("RATE_LIMITED"), "w1")).toBe(true);
    await vi.waitFor(() => expect(retryWatching).toHaveBeenCalledTimes(1));
    await settle();
  });
});

describe("handleVoiceJoinRollback session teardown", () => {
  beforeEach(() => {
    resetJoinRequest();
    vi.mocked(isVoiceSessionActive).mockReturnValue(false);
  });

  it("abandons a pending rejoin but keeps the server membership when no session is live", async () => {
    joinVoiceChannel(4);

    handleVoiceJoinRollback(refusal("FORBIDDEN"), undefined);

    await vi.waitFor(() => expect(failPendingRejoin).toHaveBeenCalledTimes(1));
    expect(leaveVoice).not.toHaveBeenCalled();
  });

  it("tells the server to drop a session that is live or still connecting", async () => {
    vi.mocked(isVoiceSessionActive).mockReturnValue(true);
    joinVoiceChannel(4);

    handleVoiceJoinRollback(refusal("FORBIDDEN"), undefined);

    await vi.waitFor(() => expect(leaveVoice).toHaveBeenCalledWith(true));
  });

  it("forgets a pending AFK move when its join is refused", async () => {
    clearAfkMove();
    const socket = socketStub();
    handleVoiceMoved(socket, { to_channel_id: 4, reason: "afk" }, clockStub());
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalled());
    resetJoinRequest();
    noteJoinSent("j1");

    handleVoiceJoinRollback(refusal("FORBIDDEN"), "j1");
    joinVoiceChannel(4);
    ack(4);

    expect(showToast).not.toHaveBeenCalled();
  });
});

describe("video limit refusals", () => {
  beforeEach(() => {
    vi.mocked(rollbackPendingVideo).mockReset();
  });

  it("consumes VIDEO_LIMIT with a toast and turns the camera off when the frame has no id", async () => {
    expect(handleVoiceError({ code: "VIDEO_LIMIT", message: "" }, undefined)).toBe(true);

    expect(showToast).toHaveBeenCalledWith(
      "That voice channel has reached its video limit",
      "error",
    );
    await vi.waitFor(() => expect(disableCamera).toHaveBeenCalledTimes(1));
    expect(disableScreenshare).not.toHaveBeenCalled();
  });

  it("rolls back the camera enable that the id correlates to", async () => {
    vi.mocked(rollbackPendingVideo).mockReturnValue("camera");

    expect(handleVoiceError({ code: "VIDEO_LIMIT", message: "" }, "cam-1")).toBe(true);

    await vi.waitFor(() => expect(disableCamera).toHaveBeenCalledTimes(1));
    expect(rollbackPendingVideo).toHaveBeenCalledWith("cam-1");
    expect(disableScreenshare).not.toHaveBeenCalled();
  });

  it("rolls back the screen share enable that the id correlates to", async () => {
    vi.mocked(rollbackPendingVideo).mockReturnValue("screen");

    handleVoiceError({ code: "VIDEO_LIMIT", message: "" }, "scr-1");

    await vi.waitFor(() => expect(disableScreenshare).toHaveBeenCalledTimes(1));
    expect(disableCamera).not.toHaveBeenCalled();
  });

  it("rolls nothing back for an id that no longer correlates", async () => {
    vi.mocked(rollbackPendingVideo).mockReturnValue(undefined);

    expect(handleVoiceError({ code: "VIDEO_LIMIT", message: "" }, "old-1")).toBe(true);
    await vi.waitFor(() => expect(rollbackPendingVideo).toHaveBeenCalledWith("old-1"));
    await settle();

    expect(disableCamera).not.toHaveBeenCalled();
    expect(disableScreenshare).not.toHaveBeenCalled();
  });
});

describe("rollbackVideoOnError", () => {
  beforeEach(() => {
    vi.mocked(rollbackPendingVideo).mockReset();
  });

  it("turns the camera off for a refused camera enable", async () => {
    vi.mocked(rollbackPendingVideo).mockReturnValue("camera");

    rollbackVideoOnError("cam-1");

    await vi.waitFor(() => expect(disableCamera).toHaveBeenCalledTimes(1));
    expect(disableScreenshare).not.toHaveBeenCalled();
  });

  it("turns the screen share off for a refused screen share enable", async () => {
    vi.mocked(rollbackPendingVideo).mockReturnValue("screen");

    rollbackVideoOnError("scr-1");

    await vi.waitFor(() => expect(disableScreenshare).toHaveBeenCalledTimes(1));
    expect(disableCamera).not.toHaveBeenCalled();
  });

  it("changes nothing for an id that does not correlate", async () => {
    vi.mocked(rollbackPendingVideo).mockReturnValue(undefined);

    rollbackVideoOnError("old-1");
    await vi.waitFor(() => expect(rollbackPendingVideo).toHaveBeenCalledWith("old-1"));
    await settle();

    expect(disableCamera).not.toHaveBeenCalled();
    expect(disableScreenshare).not.toHaveBeenCalled();
  });

  it("does nothing without an id", async () => {
    rollbackVideoOnError(undefined);
    await settle();

    expect(rollbackPendingVideo).not.toHaveBeenCalled();
    expect(disableCamera).not.toHaveBeenCalled();
  });
});

describe("snapshotReadyVoice self row selection", () => {
  it("applies the member's own row, not another member's row listed before it", async () => {
    connect();

    snapshotReadyVoice()(
      socketStub(),
      readyWith([
        voiceState({ user_id: 7, server_muted: true, server_deafened: true }),
        voiceState({}),
      ]),
    );
    await settle();

    expect(setMuted).not.toHaveBeenCalled();
    expect(setDeafened).not.toHaveBeenCalled();
    expect(voiceStore.getState().localServerMuted).toBe(false);
  });

  it("does nothing for another device's call: no watch re-send, no moderator enforcement", async () => {
    const socket = socketStub();

    snapshotReadyVoice()(socket, readyWith([voiceState({ server_muted: true })]));
    await settle();

    expect(resendWatching).not.toHaveBeenCalled();
    expect(isWatchingResync()).toBe(false);
    expect(setMuted).not.toHaveBeenCalled();
    expect(handleParticipantLeft).not.toHaveBeenCalled();
    expect(reconcileVideoFlags).not.toHaveBeenCalled();
  });
});

describe("handleVoiceState for another member", () => {
  it("leaves this client's channel, moderation and toasts alone", async () => {
    joinVoiceChannel(3);
    setVoiceStatus("connected");
    const socket = socketStub();

    handleVoiceState(
      socket,
      voiceState({ user_id: 10, channel_id: 4, server_muted: true, server_deafened: true }),
    );
    await settle();

    expect(voiceStore.getState().currentChannelId).toBe(3);
    expect(voiceStore.getState().voiceStatus).toBe("connected");
    expect(voiceStore.getState().voiceUsers.get(4)?.has(10)).toBe(true);
    expect(setMuted).not.toHaveBeenCalled();
    expect(setDeafened).not.toHaveBeenCalled();
    expect(socket.send).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });
});

describe("voice handler log lines", () => {
  it("records a moderator move with its destination", async () => {
    const logs = captureLogs();
    const socket = socketStub();

    handleVoiceMoved(socket, { to_channel_id: 4 }, clockWith(null));
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalled());

    expect(logs.find("Moved to another voice channel by a moderator")).toMatchObject([
      { level: "info", component: "dispatcher", data: { toChannelId: 4 } },
    ]);
  });

  it("records a frame for a channel already left, with that channel", async () => {
    const logs = captureLogs();
    joinVoiceChannel(5);

    handleVoiceDisconnected({ channel_id: 4, reason: "Removed" }, clockWith(5));
    await settle();

    expect(logs.find("Ignoring stale voice_disconnected for a channel already left")).toMatchObject(
      [{ level: "info", component: "dispatcher", data: { channelId: 4 } }],
    );
    expect(logs.find("Disconnected from voice by a moderator")).toEqual([]);
  });

  it("records a moderator disconnect with its channel", async () => {
    const logs = captureLogs();
    joinVoiceChannel(4);

    handleVoiceDisconnected({ channel_id: 4, reason: "Removed" }, clockWith(null));
    await vi.waitFor(() => expect(leaveVoice).toHaveBeenCalledWith(false));

    expect(logs.find("Disconnected from voice by a moderator")).toMatchObject([
      { level: "info", component: "dispatcher", data: { channelId: 4 } },
    ]);
  });

  it("records why a rate-limited watch retry failed", async () => {
    const logs = captureLogs();
    const failure = new Error("no session");
    vi.mocked(retryWatching).mockRejectedValueOnce(failure);
    noteWatchSent("w1");

    handleVoiceWatchError(err("RATE_LIMITED"), "w1");
    await vi.waitFor(() => expect(logs.find("voice_watch retry failed")).toHaveLength(1));

    expect(logs.find("voice_watch retry failed")[0]).toMatchObject({
      level: "debug",
      component: "dispatcher",
      data: { error: "no session" },
    });
  });
});
