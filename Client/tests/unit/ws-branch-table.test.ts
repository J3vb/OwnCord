import { describe, it, expect, vi } from "vitest";

import * as wsMocks from "./helpers/ws-mocks";

vi.mock("@tauri-apps/api/core", () => wsMocks.tauriCoreMock());
vi.mock("@tauri-apps/api/event", () => wsMocks.tauriEventMock());

import { emitTauriEvent } from "./helpers/ws-mocks";
import type { ConnectionState } from "../../src/lib/ws";
import { useWsClientFixture } from "../helpers/wsClientFixture";
import { connectAndAuth, openSocket, trackStates, wsConnectCalls } from "../helpers/wsSuiteHarness";
import { createWsClient } from "../../src/lib/ws";

// Characterisation of the inbound-frame and transport-state branches the
// other ws suites leave unpinned.
describe("ws frame and transport branches", () => {
  let client: ReturnType<typeof createWsClient>;
  useWsClientFixture((created) => {
    client = created;
  });

  it("tells server-busy listeners about a SERVER_BUSY refusal and keeps it from error listeners", async () => {
    const busy = vi.fn();
    const errors = vi.fn();
    client.onServerBusy(busy);
    client.on("error", errors);
    await connectAndAuth(client);
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "error",
        payload: { code: "SERVER_BUSY", message: "busy", retry_after_ms: 10 },
      }),
    );
    expect(busy).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it("hands any other error frame to the error listeners only", async () => {
    const busy = vi.fn();
    const errors = vi.fn();
    client.onServerBusy(busy);
    client.on("error", errors);
    await connectAndAuth(client);
    emitTauriEvent(
      "ws-message",
      JSON.stringify({ type: "error", payload: { code: "RATE_LIMITED", message: "slow" } }),
    );
    expect(busy).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it("goes connecting, authenticating, connected, reconnecting, connecting on a dropped session", async () => {
    const states = trackStates(client);
    await connectAndAuth(client);
    emitTauriEvent("ws-state", "closed");
    await vi.advanceTimersByTimeAsync(2100);
    expect(states).toEqual<ConnectionState[]>([
      "connecting",
      "authenticating",
      "connected",
      "reconnecting",
      "connecting",
    ]);
  });

  it("ends in disconnected without redialling after an intentional close", async () => {
    await openSocket(client);
    client.disconnect();
    const dials = wsConnectCalls().length;
    emitTauriEvent("ws-state", "closed");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.getState()).toBe("disconnected");
    expect(wsConnectCalls().length).toBe(dials);
  });
});
