import { readFileSync } from "node:fs";
import path from "node:path";
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
import { setMuted, setDeafened, handleParticipantLeft } from "../../lib/livekitSession";
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

describe("bundle hygiene", () => {
  // dispatcher.ts is in the startup chunk and imports these modules
  // statically, so a static import of livekit-client's importers here would
  // drag ~1.3 MB into it. Both must stay dynamic.
  it.each(["voice/wsHandlers.ts", "connection/dispatchContext.ts"])(
    "%s imports livekitSession and screenShare only dynamically",
    (file) => {
      const source = readFileSync(path.join(__dirname, "..", file), "utf8");
      expect(source).not.toMatch(
        /^\s*import\s[^;]*from\s+["'][^"']*\/(livekitSession|screenShare)["']/m,
      );
    },
  );
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
