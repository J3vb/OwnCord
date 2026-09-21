import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleAuthError, handleAuthOk, handleConnectionError } from "./wsHandlers";
import { createReconnectClock } from "./dispatchContext";
import { authStore } from "../../stores/auth.store";
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
});

describe("handleAuthError", () => {
  it("names the refused host on a protocol-epoch refusal", () => {
    handleAuthError({ listBlocks: vi.fn(), getConfig: () => ({ host: "h:1" }) }, {
      message: "update the server",
      code: "protocol_epoch_unsupported",
      server_epoch: 9,
    });
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

  it("leaves every other code to the rest of the chain", () => {
    const ws = socketStub();

    expect(handleConnectionError(ws, { code: "FORBIDDEN", message: "" })).toBe(false);
    expect(ws.disconnect).not.toHaveBeenCalled();
  });
});
