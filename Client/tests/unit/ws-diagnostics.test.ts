import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", async () => ({
  invoke: (await import("./helpers/ws-mocks")).mockInvoke,
}));
vi.mock("@tauri-apps/api/event", async () => ({
  listen: (await import("./helpers/ws-mocks")).mockListen,
}));
import { createWsClient } from "@lib/ws";
import { mockInvoke, eventHandlers, emitTauriEvent } from "./helpers/ws-mocks";

describe("diagnostic heartbeat", () => {
  let ws: ReturnType<typeof createWsClient>;
  beforeEach(async () => {
    vi.useFakeTimers();
    mockInvoke.mockReset().mockResolvedValue(undefined);
    eventHandlers.clear();
    ws = createWsClient();
    ws.connect({ host: "server.test", token: "token" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");
    emitTauriEvent("ws-message", JSON.stringify({ type: "auth_ok", payload: {} }));
  });
  afterEach(() => {
    ws.disconnect();
    vi.useRealTimers();
  });

  it("requires a fresh pong, not an open transport or another message", async () => {
    emitTauriEvent("ws-message", JSON.stringify({ type: "pong" }));
    const done = vi.fn();
    const work = ws.ping(new AbortController().signal).then(done);
    expect(mockInvoke).toHaveBeenCalledWith("ws_send", {
      message: JSON.stringify({ type: "ping", payload: {} }),
    });
    emitTauriEvent("ws-message", JSON.stringify({ type: "typing", payload: {} }));
    await vi.advanceTimersByTimeAsync(10);
    expect(done).not.toHaveBeenCalled();
    emitTauriEvent("ws-message", JSON.stringify({ type: "pong" }));
    await work;
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("fails when the server does not answer", async () => {
    const work = expect(ws.ping(new AbortController().signal, 100)).rejects.toThrow(
      "No heartbeat response",
    );
    await vi.advanceTimersByTimeAsync(100);
    await work;
  });

  it.each(["cancel", "disconnect", "send failure"])(
    "cleans the pending probe on %s",
    async (reason) => {
      const ac = new AbortController();
      if (reason === "send failure") mockInvoke.mockRejectedValueOnce(new Error("channel full"));
      const work = expect(ws.ping(ac.signal)).rejects.toBeDefined();
      if (reason === "cancel") ac.abort();
      if (reason === "disconnect") ws.disconnect();
      await work;
      emitTauriEvent("ws-message", JSON.stringify({ type: "pong" }));
      await vi.advanceTimersByTimeAsync(6000);
    },
  );
});
