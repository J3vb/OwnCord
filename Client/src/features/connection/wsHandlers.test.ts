import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleAuthError, handleAuthOk, handleConnectionError } from "./wsHandlers";
import { createReconnectClock } from "./dispatchContext";
import { authStore } from "../../stores/auth.store";
import { channelsStore } from "../../stores/channels.store";
import { messagesStore } from "../../stores/messages.store";
import { uiStore } from "../../stores/ui.store";
import { expectConsole } from "../../../tests/helpers/console";

vi.mock("../../lib/livekitSession", () => ({ leaveVoice: vi.fn() }));

const user = { id: 9, username: "me", avatar: null, role: "member" };

function socketStub() {
  return { send: vi.fn(), disconnect: vi.fn() };
}

beforeEach(() => {
  authStore.setState((prev) => ({ ...prev, token: "tok", user, isAuthenticated: true }));
  uiStore.setState((prev) => ({ ...prev, sessionReplaced: false, updateRequiredHost: null }));
  channelsStore.setState(() => ({ channels: new Map(), activeChannelId: null, roles: [] }));
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

  // P4-03: channel_focus also advances the server's read state, so a reconnect
  // that re-focuses the active channel while the reader is away silently marks
  // the messages missed while away as read. The resume's auth frame
  // (active_channel_id) restores the ChannelTopic subscription instead.
  it("does not re-focus the active channel on auth_ok while the window is unfocused", () => {
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 42 }));
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const ws = socketStub();

    handleAuthOk(ws, createReconnectClock(), { user, server_name: "s", motd: "" });

    expect(ws.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "channel_focus" }),
    );
  });

  it("does not re-focus the active channel on auth_ok while its window is detached", () => {
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 42 }));
    messagesStore.setState((prev) => ({
      ...prev,
      detachedChannels: new Set([42]),
    }));
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const ws = socketStub();

    handleAuthOk(ws, createReconnectClock(), { user, server_name: "s", motd: "" });

    expect(ws.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "channel_focus" }),
    );
  });

  it("still re-focuses the active channel on auth_ok while the window is focused", () => {
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 42 }));
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const ws = socketStub();

    handleAuthOk(ws, createReconnectClock(), { user, server_name: "s", motd: "" });

    expect(ws.send).toHaveBeenCalledWith({
      type: "channel_focus",
      payload: { channel_id: 42 },
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
