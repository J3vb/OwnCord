import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleVoiceE2eeAnnounce,
  handleVoiceError,
  handleVoiceJoinRollback,
  handleVoiceLeave,
  handleVoiceState,
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
} from "../../stores/voice.store";
import { authStore } from "../../stores/auth.store";
import { joinRetryInMs, noteJoinSucceeded } from "./joinBackoff";
import { noteJoinSent, resetJoinRequest } from "./joinRequest";
import type { Payload, ReconnectClock } from "../connection/dispatchContext";
import { expectConsole } from "../../../tests/helpers/console";

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
}));
vi.mock("../../lib/toast", () => ({ showToast: vi.fn() }));
import {
  setMuted,
  setDeafened,
  handleParticipantLeft,
  handleE2EEAnnounce,
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
  it("sends voice_leave for a stale self voice state with no live session", () => {
    const socket = socketStub();
    const apply = snapshotReadyVoice();

    apply(socket, readyWith([voiceState({})]));
    expectConsole("warn", /\[dispatcher\] Stale voice state detected in ready payload/);

    expect(socket.send).toHaveBeenCalledWith({ type: "voice_leave", payload: {} });
    expect(voiceStore.getState().currentChannelId).toBeNull();
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
