// handleVoiceMoved: whether a move is this device's to follow, and what the
// member is told. Split from wsHandlers.test.ts, which holds the other handlers.
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleVoiceJoinRollback,
  handleVoiceLeave,
  handleVoiceMoved,
  handleVoiceState,
  snapshotReadyVoice,
} from "./wsHandlers";
import {
  voiceStore,
  resetVoiceStore,
  joinVoiceChannel,
  setVoiceStatus,
} from "../../stores/voice.store";
import { authStore } from "../../stores/auth.store";
import { channelsStore } from "../../stores/channels.store";
import { membersStore } from "../../stores/members.store";
import {
  CALL_ENDED_MOVE_WINDOW_MS,
  clearAfkMove,
  clearCallEndedByServer,
  isVoiceMovePending,
  takeVoiceMoved,
} from "./moveHint";
import { noteJoinSent } from "./joinRequest";
import type { Payload, ReconnectClock } from "../connection/dispatchContext";

vi.mock("../../lib/voice/livekitSession", () => ({
  leaveVoice: vi.fn(),
  setMuted: vi.fn(),
  setDeafened: vi.fn(),
  isAutoReconnecting: vi.fn(() => false),
  isVoiceSessionActive: vi.fn(() => false),
  handleParticipantLeft: vi.fn(async () => {}),
  failPendingRejoin: vi.fn(),
  reconcileVideoFlags: vi.fn(),
  resendWatching: vi.fn(),
}));
vi.mock("../../lib/ui/toast", () => ({ showToast: vi.fn() }));
import { leaveVoice } from "../../lib/voice/livekitSession";
import { showToast } from "../../lib/ui/toast";

const voiceState = (overrides: Partial<Payload<"voice_state">>): Payload<"voice_state"> =>
  ({
    channel_id: 4,
    user_id: 9,
    username: "me",
    muted: false,
    deafened: false,
    speaking: false,
    ...overrides,
  }) as Payload<"voice_state">;

/** This device holds a call in channel 3. */
const inCall = (): void => {
  joinVoiceChannel(3);
  setVoiceStatus("connected");
};
const clockStub = (): ReconnectClock => ({ voiceRejoinChannelId: null }) as ReconnectClock;
const socketStub = () => ({ send: vi.fn(), disconnect: vi.fn() });
const readyWith = (voiceStates: Payload<"voice_state">[]) =>
  ({ voice_states: voiceStates }) as unknown as Payload<"ready">;
const ack = (channelId: number): void =>
  handleVoiceState(socketStub(), voiceState({ channel_id: channelId, user_id: 9 }));

beforeEach(() => {
  resetVoiceStore();
  authStore.setState((prev) => ({
    ...prev,
    user: { id: 9, username: "me", avatar: null, role: "member" },
  }));
  vi.clearAllMocks();
});

/** The server's voice_leave of `channelId` for this user. */
const leaveOf = (channelId: number) =>
  ({ channel_id: channelId, user_id: 9 }) as Payload<"voice_leave">;

describe("handleVoiceMoved on a device with or without a call", () => {
  beforeEach(() => {
    clearCallEndedByServer();
    takeVoiceMoved(null);
    channelsStore.setState((prev) => ({
      ...prev,
      channels: new Map([
        [4, { id: 4, name: "Parking", type: "voice" } as never],
        [5, { id: 5, name: "general", type: "text" } as never],
      ]),
    }));
  });

  it("does nothing on a device that holds no call", async () => {
    const socket = socketStub();
    const before = voiceStore.getState();
    handleVoiceMoved(socket, { to_channel_id: 4, by_user_id: 7 }, clockStub());
    await Promise.resolve();
    await Promise.resolve();
    expect(socket.send).not.toHaveBeenCalled();
    expect(leaveVoice).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
    expect(isVoiceMovePending()).toBe(false);
    expect(voiceStore.getState()).toBe(before);
  });

  it("follows the move the server sends right after ending this device's call", async () => {
    inCall();
    const socket = socketStub();
    const clock = clockStub();
    // The server's order: the eviction's own voice_leave, then voice_moved.
    handleVoiceLeave(leaveOf(3), clock);
    expect(voiceStore.getState().voiceStatus).toBe("idle");
    handleVoiceMoved(socket, { to_channel_id: 4, by_user_id: 7 }, clock);
    await vi.waitFor(() =>
      expect(socket.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "voice_join", payload: { channel_id: 4 } }),
      ),
    );
    expect(voiceStore.getState().currentChannelId).toBe(4);
  });

  it("does nothing once the window after the server ended the call has passed", async () => {
    vi.useFakeTimers();
    try {
      inCall();
      const socket = socketStub();
      const clock = clockStub();
      handleVoiceLeave(leaveOf(3), clock);
      vi.advanceTimersByTime(CALL_ENDED_MOVE_WINDOW_MS + 1);
      handleVoiceMoved(socket, { to_channel_id: 4 }, clock);
      await vi.advanceTimersByTimeAsync(0);
      expect(socket.send).not.toHaveBeenCalled();
      expect(voiceStore.getState().currentChannelId).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("follows a move while a restart re-join is still pending", async () => {
    const socket = socketStub();
    const clock = { voiceRejoinChannelId: 3 } as ReconnectClock;
    handleVoiceMoved(socket, { to_channel_id: 4 }, clock);
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalled());
    expect(clock.voiceRejoinChannelId).toBeNull();
  });

  it("does nothing for a destination the channel list knows as a text channel", async () => {
    inCall();
    const socket = socketStub();
    handleVoiceMoved(socket, { to_channel_id: 5 }, clockStub());
    await Promise.resolve();
    await Promise.resolve();
    expect(socket.send).not.toHaveBeenCalled();
    expect(voiceStore.getState().currentChannelId).toBe(3);
  });
});

describe("handleVoiceMoved toast", () => {
  const clock = { voiceRejoinChannelId: null } as ReconnectClock;
  beforeEach(() => {
    clearAfkMove();
    // The move is for the call this device holds.
    inCall();
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
    handleVoiceJoinRollback(socketStub(), { code: "FORBIDDEN", message: "no" }, "join-1");
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
