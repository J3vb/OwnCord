import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleAuthError,
  handleAuthOk,
  handleConnectionError,
  rejoinVoiceAfterRestart,
} from "./wsHandlers";
import { createReconnectClock } from "./dispatchContext";
import { authStore } from "../../stores/auth.store";
import { channelsStore } from "../../stores/channels.store";
import { messagesStore } from "../../stores/messages.store";
import { uiStore } from "../../stores/ui.store";
import {
  voiceStore,
  resetVoiceStore,
  joinVoiceChannel,
  setVoiceStatus,
  isWatchingResync,
  setPeerWatching,
} from "../../stores/voice.store";
import { expectConsole } from "../../../tests/helpers/console";

const resendWatching = vi.hoisted(() => vi.fn());
vi.mock("../../lib/livekitSession", () => ({ leaveVoice: vi.fn(), resendWatching }));

const user = { id: 9, username: "me", avatar: null, role: "member" };

function socketStub() {
  return { send: vi.fn(), disconnect: vi.fn() };
}

beforeEach(() => {
  authStore.setState((prev) => ({ ...prev, token: "tok", user, isAuthenticated: true }));
  uiStore.setState((prev) => ({ ...prev, sessionReplaced: false, updateRequiredHost: null }));
  channelsStore.setState(() => ({
    channels: new Map(),
    activeChannelId: null,
    roles: [],
    categories: [],
  }));
  messagesStore.setState((prev) => ({ ...prev, detachedChannels: new Set() }));
});

describe("handleAuthOk", () => {
  it("stamps the handshake time only from the second auth_ok on", () => {
    const clock = createReconnectClock();
    const payload = { user, server_name: "s", motd: "" };

    handleAuthOk(socketStub(), clock, payload);
    expect(clock.hasAuthenticatedBefore).toBe(true);
    expect(clock.lastReconnectHandshakeAt).toBeNull();

    handleAuthOk(socketStub(), clock, payload);
    expect(clock.lastReconnectHandshakeAt).not.toBeNull();
  });

  it("re-focuses the active channel on auth_ok", () => {
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 42 }));
    const ws = socketStub();

    handleAuthOk(ws, createReconnectClock(), { user, server_name: "s", motd: "" });

    expect(ws.send).toHaveBeenCalledWith({
      type: "channel_focus",
      payload: { channel_id: 42 },
    });
  });

  describe("voice restate on a resumed socket", () => {
    const resumed = { user, server_name: "s", motd: "", replay_source: "buffer" } as const;

    beforeEach(() => {
      resetVoiceStore();
      joinVoiceChannel(4);
      setVoiceStatus("connected");
      voiceStore.setState((prev) => ({ ...prev, localMuted: true }));
    });

    it("restates a mute toggled while the socket was down", () => {
      const ws = socketStub();

      handleAuthOk(ws, createReconnectClock(), resumed);

      expect(ws.send).toHaveBeenCalledWith({ type: "voice_mute", payload: { muted: true } });
    });

    it("re-sends our watch set and quiets the viewer sounds for the re-sync", async () => {
      handleAuthOk(socketStub(), createReconnectClock(), resumed);

      expect(isWatchingResync()).toBe(true);
      await vi.waitFor(() => expect(resendWatching).toHaveBeenCalledTimes(1));
    });

    it("drops a peer's watch set the resumed server does not re-send", () => {
      voiceStore.setState((prev) => ({
        ...prev,
        voiceUsers: new Map([[4, new Map([[5, { userId: 5 } as never]])]]),
      }));
      setPeerWatching(5, [2]);
      expect(voiceStore.getState().peerWatching?.get(5)).toEqual([2]);

      handleAuthOk(socketStub(), createReconnectClock(), resumed);

      expect(voiceStore.getState().peerWatching?.has(5)).toBe(false);
    });

    it("does not re-send the watch set on a fresh flow or with no session", async () => {
      resendWatching.mockClear();
      handleAuthOk(socketStub(), createReconnectClock(), { user, server_name: "s", motd: "" });
      setVoiceStatus("idle");
      handleAuthOk(socketStub(), createReconnectClock(), resumed);
      await Promise.resolve();
      expect(resendWatching).not.toHaveBeenCalled();
    });

    it("sends nothing on a fresh flow, where ready restates", () => {
      const ws = socketStub();

      handleAuthOk(ws, createReconnectClock(), { user, server_name: "s", motd: "" });

      expect(ws.send).not.toHaveBeenCalled();
    });

    it("sends nothing while a join is still in flight", () => {
      setVoiceStatus("joining");
      const ws = socketStub();

      handleAuthOk(ws, createReconnectClock(), resumed);

      expect(ws.send).not.toHaveBeenCalled();
    });

    it("sends nothing with no voice session", () => {
      setVoiceStatus("idle");
      const ws = socketStub();

      handleAuthOk(ws, createReconnectClock(), resumed);

      expect(ws.send).not.toHaveBeenCalled();
    });
  });
});

describe("handleAuthError", () => {
  it("names the refused host on a protocol-epoch refusal", () => {
    handleAuthError(
      { listBlocks: vi.fn(), getConfig: () => ({ host: "h:1" }) },
      {
        message: "update the server",
        code: "protocol_epoch_unsupported",
        server_epoch: 9,
      },
    );
    expectConsole("error", /\[dispatcher\] Auth failed/);

    expect(uiStore.getState().updateRequiredHost).toMatchObject({ host: "h:1", serverEpoch: 9 });
    expect(authStore.getState().isAuthenticated).toBe(false);
  });
});

describe("handleConnectionError", () => {
  it("disconnects before signing out on BANNED", () => {
    const ws = socketStub();
    let authenticatedAtDisconnect: boolean | undefined;
    ws.disconnect.mockImplementation(() => {
      authenticatedAtDisconnect = authStore.getState().isAuthenticated;
    });

    expect(handleConnectionError(ws, { code: "BANNED", message: "" })).toBe(true);

    expect(authenticatedAtDisconnect).toBe(true);
    expect(authStore.getState().isAuthenticated).toBe(false);
  });

  it("disconnects but stays signed in on SESSION_REPLACED", () => {
    const ws = socketStub();

    expect(handleConnectionError(ws, { code: "SESSION_REPLACED", message: "" })).toBe(true);

    expect(ws.disconnect).toHaveBeenCalledTimes(1);
    expect(uiStore.getState().sessionReplaced).toBe(true);
    expect(authStore.getState().isAuthenticated).toBe(true);
  });

  it("disconnects but stays signed in on ANOTHER_DEVICE_ACTIVE (U4)", () => {
    const ws = socketStub();

    expect(handleConnectionError(ws, { code: "ANOTHER_DEVICE_ACTIVE", message: "" })).toBe(true);

    expect(ws.disconnect).toHaveBeenCalledTimes(1);
    expect(uiStore.getState().sessionReplaced).toBe(true);
    expect(authStore.getState().isAuthenticated).toBe(true);
  });

  it("leaves every other code to the rest of the chain", () => {
    const ws = socketStub();

    expect(handleConnectionError(ws, { code: "FORBIDDEN", message: "" })).toBe(false);
    expect(ws.disconnect).not.toHaveBeenCalled();
  });
});

function readyPayload(voiceStates: { user_id: number; channel_id: number }[]) {
  return {
    channels: [{ id: 5, type: "voice" }],
    dm_channels: [],
    voice_states: voiceStates,
  } as never;
}

function armedClock() {
  const clock = createReconnectClock();
  clock.voiceRejoinChannelId = 5;
  clock.voiceRejoinExpiresAt = Date.now() + 60_000;
  return clock;
}

describe("rejoinVoiceAfterRestart", () => {
  beforeEach(() => resetVoiceStore());

  it("rejoins when ready has no row for this user", () => {
    const ws = socketStub();
    rejoinVoiceAfterRestart(armedClock(), ws, readyPayload([{ user_id: 2, channel_id: 5 }]));
    expect(ws.send).toHaveBeenCalledWith({ type: "voice_join", payload: { channel_id: 5 } });
  });

  it("does not rejoin when this user already has a row in the channel", () => {
    const ws = socketStub();
    rejoinVoiceAfterRestart(armedClock(), ws, readyPayload([{ user_id: 9, channel_id: 5 }]));
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("does not rejoin when another device holds the user's call in another channel", () => {
    const ws = socketStub();
    rejoinVoiceAfterRestart(armedClock(), ws, readyPayload([{ user_id: 9, channel_id: 7 }]));
    expect(ws.send).not.toHaveBeenCalled();
  });
});
