import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleVoiceError,
  handleVoiceJoinRollback,
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
import type { Payload } from "../connection/dispatchContext";
import { expectConsole } from "../../../tests/helpers/console";

vi.mock("../../lib/livekitSession", () => ({
  setMuted: vi.fn(),
  setDeafened: vi.fn(),
  leaveVoice: vi.fn(),
  handleParticipantLeft: vi.fn(async () => {}),
  isVoiceSessionActive: vi.fn(() => false),
}));
vi.mock("../../lib/toast", () => ({ showToast: vi.fn() }));
import { setMuted, setDeafened, handleParticipantLeft, leaveVoice } from "../../lib/livekitSession";
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

  it("releases a moderator mute lifted while disconnected, using the pre-ready flags", async () => {
    joinVoiceChannel(4);
    setVoiceStatus("connected");
    voiceStore.setState((prev) => ({ ...prev, localServerMuted: true, localMuted: true }));
    const apply = snapshotReadyVoice();

    apply(socketStub(), readyWith([voiceState({ server_muted: false })]));

    await vi.waitFor(() => expect(setMuted).toHaveBeenCalledWith(false));
  });

  // RT-8: a network blip longer than the server's reconnect grace window ends
  // the membership, but the LiveKit room survives the chat-socket drop (it is
  // an independent media path). Before this branch, the resync's `ready` simply
  // omitted self and left the orphaned media session live — the UI showed
  // not-in-voice while the mic kept publishing. A live session whose channel
  // the ready payload no longer names must be torn down.
  it("tears down an orphaned live session when the ready payload no longer names us in voice", async () => {
    joinVoiceChannel(4);
    setVoiceStatus("connected");
    const socket = socketStub();
    const apply = snapshotReadyVoice();

    apply(socket, readyWith([]));
    expectConsole("warn", /\[dispatcher\] Live voice session not in the ready payload/);

    await vi.waitFor(() => expect(leaveVoice).toHaveBeenCalledWith(false));
    expect(voiceStore.getState().currentChannelId).toBeNull();
    expect(socket.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "voice_leave", payload: {} }),
    );
  });

  it("keeps an orphaned session when the ready payload names us elsewhere", async () => {
    joinVoiceChannel(4);
    setVoiceStatus("connected");
    const socket = socketStub();
    const apply = snapshotReadyVoice();

    apply(socket, readyWith([voiceState({ channel_id: 9 })]));

    // The server still names us in voice (another channel); reconciliation,
    // not teardown, owns that transition.
    await Promise.resolve();
    expect(leaveVoice).not.toHaveBeenCalled();
  });
});

describe("handleVoiceState moderator enforcement", () => {
  it("applies a moderator mute and deafen to this client", async () => {
    handleVoiceState(voiceState({ server_muted: true, server_deafened: true }));

    await vi.waitFor(() => expect(setDeafened).toHaveBeenCalledWith(true));
    expect(setMuted).toHaveBeenCalledWith(true);
  });

  it("releases a moderator mute on its falling edge only", async () => {
    handleVoiceState(voiceState({ server_muted: true }));
    await vi.waitFor(() => expect(setMuted).toHaveBeenCalledWith(true));
    voiceStore.setState((prev) => ({ ...prev, localMuted: true }));

    handleVoiceState(voiceState({ server_muted: false }));
    await vi.waitFor(() => expect(setMuted).toHaveBeenCalledWith(false));
  });

  it("does nothing to local audio for another user's voice state", async () => {
    handleVoiceState(voiceState({ user_id: 10, server_muted: true }));
    await Promise.resolve();
    expect(setMuted).not.toHaveBeenCalled();
  });
});

describe("handleVoiceJoinRollback", () => {
  it("rolls back an outstanding join", () => {
    joinVoiceChannel(4);
    expect(voiceStore.getState().voiceStatus).toBe("joining");

    handleVoiceJoinRollback();

    expect(voiceStore.getState().currentChannelId).toBeNull();
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
