import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleVoiceDisconnected,
  handleVoiceE2eeAnnounce,
  handleVoiceError,
  handleVoiceJoinRollback,
  handleVoiceLeave,
  handleVoiceMoved,
  handleVoiceState,
  handleVoiceWatching,
  handleVoiceWatchError,
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
  isVoiceSessionActive: vi.fn(() => false),
  isAutoReconnecting: vi.fn(() => false),
  failPendingRejoin: vi.fn(),
  reconcileVideoFlags: vi.fn(),
  resendWatching: vi.fn(),
  retryWatching: vi.fn(),
}));
vi.mock("../../lib/toast", () => ({ showToast: vi.fn() }));
import {
  setMuted,
  setDeafened,
  leaveVoice,
  handleParticipantLeft,
  handleE2EEAnnounce,
  resendWatching,
  retryWatching,
} from "../../lib/livekitSession";
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

  it("names the moderator who moved you, at once (WP 8.4b)", async () => {
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

describe("handleVoiceWatching (6.6b)", () => {
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
