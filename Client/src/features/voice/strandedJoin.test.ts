// A voice join whose answers cross a later click: the old call's echo must not
// move the store back, and a call the server still holds for this socket is
// given back when the join that replaced it is refused.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleVoiceJoinRollback, handleVoiceState } from "./wsHandlers";
import { noteJoinSent, noteTokenIgnored, resetJoinRequest } from "./joinRequest";
import {
  voiceStore,
  resetVoiceStore,
  joinVoiceChannel,
  setVoiceStatus,
} from "../../stores/voice.store";
import { authStore } from "../../stores/auth.store";
import type { Payload } from "../connection/dispatchContext";

vi.mock("../../lib/voice/livekitSession", () => ({
  setMuted: vi.fn(),
  setDeafened: vi.fn(),
  leaveVoice: vi.fn(),
  isVoiceSessionActive: vi.fn(() => false),
  failPendingRejoin: vi.fn(),
}));
import { setMuted, leaveVoice, failPendingRejoin } from "../../lib/voice/livekitSession";

const ownRow = (overrides: Partial<Payload<"voice_state">>): Payload<"voice_state"> =>
  ({ channel_id: 4, user_id: 9, username: "me", ...overrides }) as Payload<"voice_state">;
const refusal = (code: Payload<"error">["code"]): Payload<"error"> => ({ code, message: "" });
const socketStub = () => ({ send: vi.fn(), disconnect: vi.fn() });

beforeEach(() => {
  resetVoiceStore();
  resetJoinRequest();
  authStore.setState((prev) => ({ ...prev, user: { id: 9, username: "me" } as never }));
  vi.clearAllMocks();
});

describe("handleVoiceState for a channel the user just switched away from", () => {
  it("does not point the store back at the old channel", () => {
    joinVoiceChannel(4);
    setVoiceStatus("connected");
    joinVoiceChannel(5);

    handleVoiceState(socketStub(), ownRow({ channel_id: 4, muted: true }));

    const state = voiceStore.getState();
    expect(state).toMatchObject({ currentChannelId: 5, voiceStatus: "joining" });
    expect(state.voiceUsers.get(4)?.get(9)?.muted).toBe(true);
  });

  it("still applies a moderator mute carried by that row", async () => {
    joinVoiceChannel(4);
    setVoiceStatus("connected");
    joinVoiceChannel(5);

    handleVoiceState(socketStub(), ownRow({ channel_id: 4, server_muted: true }));

    await vi.waitFor(() => expect(setMuted).toHaveBeenCalledWith(true));
  });
});

describe("a refused join with a call still held for this socket", () => {
  it("gives back the call a refused re-join found in place", async () => {
    joinVoiceChannel(4);
    const socket = socketStub();

    handleVoiceJoinRollback(socket, refusal("ALREADY_JOINED"), undefined);

    await vi.waitFor(() =>
      expect(socket.send).toHaveBeenCalledWith({ type: "voice_leave", payload: {} }),
    );
    expect(leaveVoice).not.toHaveBeenCalled();
  });

  it("gives back a call whose token was let pass before this refusal, once", async () => {
    joinVoiceChannel(4);
    noteTokenIgnored();
    const socket = socketStub();

    handleVoiceJoinRollback(socket, refusal("FORBIDDEN"), undefined);
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledTimes(1));

    joinVoiceChannel(4);
    handleVoiceJoinRollback(socket, refusal("FORBIDDEN"), undefined);
    await vi.waitFor(() => expect(failPendingRejoin).toHaveBeenCalledTimes(2));
    expect(socket.send).toHaveBeenCalledTimes(1);
  });

  it("leaves that call to a join sent while the session module was loading", async () => {
    joinVoiceChannel(4);
    noteTokenIgnored();
    const socket = socketStub();

    handleVoiceJoinRollback(socket, refusal("FORBIDDEN"), undefined);
    joinVoiceChannel(5);
    noteJoinSent("join-next");

    await vi.waitFor(() => expect(failPendingRejoin).toHaveBeenCalledTimes(1));
    expect(socket.send).not.toHaveBeenCalled();
  });
});
