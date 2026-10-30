import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as dispatcherMocks from "../../helpers/dispatcherMocks";
import { wireDispatcher, wireConnectionStatus } from "../../../src/lib/dispatcher";
import { createMockWsClient } from "../../helpers/mock-ws";
import { expectConsole } from "../../helpers/console";
import { uiStore } from "../../../src/stores/ui.store";
import type { WsClient, WsListener } from "../../../src/lib/ws";
import type { ServerMessage } from "../../../src/lib/types";
import { createMockWs, expectLazyVoiceImportsSettled } from "../../helpers/dispatcherHarness";

vi.mock("@lib/notifications", () => dispatcherMocks.notificationsMock());
vi.mock("@lib/voice/livekitSession", () => dispatcherMocks.livekitSessionMock());
vi.mock("@lib/voice/screenShare", () => dispatcherMocks.screenShareMock());
vi.mock("@lib/ui/toast", () => dispatcherMocks.toastMock());
vi.mock("@lib/net/identity", () => dispatcherMocks.identityMock());
vi.mock("../../../src/features/connection/dispatchContext", async (importOriginal) =>
  dispatcherMocks.dispatchContextMock(await importOriginal<object>()),
);

afterEach(async () => {
  await expectLazyVoiceImportsSettled();
});

describe("wireConnectionStatus", () => {
  beforeEach(() => {
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "disconnected" }));
  });

  it("writes ws state changes into ui.store.connectionStatus via the 5→3 mapping", () => {
    const mockWs = createMockWsClient();
    const unsub = wireConnectionStatus(mockWs);

    mockWs.simulateStateChange("connecting");
    expect(uiStore.getState().connectionStatus).toBe("reconnecting");

    mockWs.simulateStateChange("authenticating");
    expect(uiStore.getState().connectionStatus).toBe("reconnecting");

    mockWs.simulateStateChange("connected");
    expect(uiStore.getState().connectionStatus).toBe("connected");

    mockWs.simulateStateChange("disconnected");
    expect(uiStore.getState().connectionStatus).toBe("disconnected");

    unsub();
    mockWs.simulateStateChange("connected");
    expect(uiStore.getState().connectionStatus).toBe("disconnected");
  });

  it("keeps a dial failure for the whole outage, clearing it on a connection", () => {
    const mockWs = createMockWsClient();
    const unsub = wireConnectionStatus(mockWs);
    const dialFailed = (): boolean => uiStore.getState().connectionDialFailed;

    mockWs.simulateStateChange("connecting");
    mockWs.simulateStateChange("authenticating");
    mockWs.simulateStateChange("connected");
    // A drop from a live connection has not failed a dial yet.
    mockWs.simulateStateChange("reconnecting");
    expect(dialFailed()).toBe(false);
    mockWs.simulateStateChange("connecting");
    expect(dialFailed()).toBe(false);

    mockWs.simulateStateChange("reconnecting");
    expect(dialFailed()).toBe(true);
    // Later backoff dials, and their failures, keep the outage's fact.
    for (let cycle = 0; cycle < 2; cycle++) {
      mockWs.simulateStateChange("connecting");
      expect(dialFailed()).toBe(true);
      mockWs.simulateStateChange("reconnecting");
      expect(dialFailed()).toBe(true);
    }

    mockWs.simulateStateChange("connecting");
    mockWs.simulateStateChange("authenticating");
    mockWs.simulateStateChange("connected");
    expect(dialFailed()).toBe(false);

    unsub();
  });

  it("starts a fresh outage when a stopped socket connects again", () => {
    const mockWs = createMockWsClient();
    const unsub = wireConnectionStatus(mockWs);
    const dialFailed = (): boolean => uiStore.getState().connectionDialFailed;

    mockWs.simulateStateChange("connecting");
    mockWs.simulateStateChange("disconnected");
    expect(dialFailed()).toBe(true);

    // Sign-in, a server switch or "Use here" dials from a stopped socket.
    mockWs.simulateStateChange("connecting");
    expect(dialFailed()).toBe(false);

    unsub();
  });
});

describe("WS Dispatcher cleanup isolation", () => {
  it("a throwing cleanup entry still unsubscribes every other handler", () => {
    const m = createMockWs();
    const realOn = m.ws.on.bind(m.ws);
    let first = true;
    m.ws.on = ((type: ServerMessage["type"], listener: WsListener<ServerMessage["type"]>) => {
      const unsub = realOn(type, listener);
      if (!first) return unsub;
      first = false;
      return () => {
        throw new Error("boom");
      };
    }) as WsClient["on"];
    const stop = wireDispatcher(m.ws);
    const remaining = (): number => [...m.listeners.values()].reduce((n, set) => n + set.size, 0);
    expect(remaining()).toBeGreaterThan(1);

    expect(() => stop()).not.toThrow();
    expectConsole("error", /Dispatcher cleanup step failed/);

    // Only the entry whose unsubscribe threw is left registered.
    expect(remaining()).toBe(1);
  });
});
