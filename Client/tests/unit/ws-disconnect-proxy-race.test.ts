import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async () => ({
  invoke: (await import("./helpers/ws-mocks")).mockInvoke,
}));

vi.mock("@tauri-apps/api/event", async () => ({
  listen: (await import("./helpers/ws-mocks")).mockListen,
}));

import { mockInvoke, emitTauriEvent } from "./helpers/ws-mocks";
import { createWsClient } from "../../src/lib/ws";
import { expectConsole } from "../helpers/console";
import { useWsClientFixture } from "../helpers/wsClientFixture";

// disconnectProxy() awaits the transport's disconnect and then marks the proxy
// closed. If a newer connect() opened its own proxy while that await was
// pending, the late write must not close the live attempt's proxy.
describe("disconnectProxy vs a newer connect", () => {
  let client: ReturnType<typeof createWsClient>;
  useWsClientFixture((created) => {
    client = created;
  });

  const cfg = { host: "localhost:8443", token: "t" };
  const chat = {
    type: "chat_send",
    payload: { channel_id: 1, content: "hi", reply_to: null, attachments: [] },
  } as const;

  it("keeps the new attempt's proxy open when the stale disconnect resolves late", async () => {
    client.connect(cfg);
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    let finishStaleDisconnect!: () => void;
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === "ws_disconnect"
        ? new Promise<void>((resolve) => {
            finishStaleDisconnect = resolve;
          })
        : Promise.resolve(undefined),
    );
    client.disconnect();
    await vi.advanceTimersByTimeAsync(10);

    // The next login dials and its proxy opens before the old disconnect lands.
    client.connect(cfg);
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    finishStaleDisconnect();
    await vi.advanceTimersByTimeAsync(10);

    mockInvoke.mockClear();
    client.send(chat);
    await vi.advanceTimersByTimeAsync(10);
    expect(mockInvoke).toHaveBeenCalledWith("ws_send", expect.anything());
  });

  it("still closes the proxy when nothing superseded the disconnect", async () => {
    client.connect(cfg);
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    client.disconnect();
    await vi.advanceTimersByTimeAsync(10);

    mockInvoke.mockClear();
    const failures: string[] = [];
    client.onSendFailure((_id, code) => failures.push(code));
    client.send(chat);
    await vi.advanceTimersByTimeAsync(10);
    expect(mockInvoke).not.toHaveBeenCalledWith("ws_send", expect.anything());
    expect(failures).toEqual(["OFFLINE"]);
    expectConsole("warn", /Cannot send, WebSocket not open/);
  });
});
