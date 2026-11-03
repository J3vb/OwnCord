import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@tauri-apps/api/core", async () => ({
  invoke: (await import("./helpers/ws-mocks")).mockInvoke,
}));

vi.mock("@tauri-apps/api/event", async () => ({
  listen: (await import("./helpers/ws-mocks")).mockListen,
}));

import { mockInvoke, emitTauriEvent } from "./helpers/ws-mocks";
import { createWsClient } from "../../src/lib/ws";
import { attachRecorder } from "../../src/lib/diagnostics/eventSink";
import { useWsClientFixture } from "../helpers/wsClientFixture";

type Seen = { code: string; fields: Readonly<Record<string, unknown>> };

// The server connection writes its own timeline into the diagnostic event log,
// tagged with the connection attempt it belongs to. An old attempt's late
// report is recorded as stale and leaves the live attempt alone.
describe("ws diagnostic events", () => {
  let client: ReturnType<typeof createWsClient>;
  useWsClientFixture((created) => {
    client = created;
  });

  let detach: (() => void) | null = null;
  afterEach(() => {
    detach?.();
    detach = null;
  });

  function capture(): Seen[] {
    const seen: Seen[] = [];
    detach = attachRecorder((code, fields) => seen.push({ code, fields }));
    seen.length = 0;
    return seen;
  }

  it("records connect, open, ready and close with one generation", async () => {
    const seen = capture();
    client.connect({ host: "Chat.Example.org:8443", token: "secret-token" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");
    emitTauriEvent("ws-message", JSON.stringify({ type: "auth_ok", payload: { user: { id: 1 } } }));
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "closed");
    await vi.advanceTimersByTimeAsync(10);

    const codes = seen.map((e) => e.code);
    expect(codes).toEqual(
      expect.arrayContaining(["ws.connecting", "ws.open", "ws.closed", "ws.reconnect_scheduled"]),
    );
    const connecting = seen.find((e) => e.code === "ws.connecting")!;
    expect(connecting.fields.host).toBe("chat.example.org");
    const gens = new Set(seen.map((e) => e.fields.generation));
    expect(gens.size).toBe(1);
    expect(seen.find((e) => e.code === "ws.closed")!.fields.close_class).toBe("abnormal");
    expect(JSON.stringify(seen)).not.toContain("secret-token");
    client.disconnect();
  });

  it("drops the host for an IP address", async () => {
    const seen = capture();
    client.connect({ host: "192.168.1.20:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    expect(seen.find((e) => e.code === "ws.connecting")!.fields.host).toBeNull();
    client.disconnect();
  });

  it("tags a superseded attempt and keeps its late failure off the live attempt", async () => {
    let failFirst!: (err: Error) => void;
    let calls = 0;
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "ws_connect" && calls++ === 0) {
        return new Promise((_resolve, reject) => {
          failFirst = reject;
        });
      }
      return Promise.resolve(undefined);
    });
    const seen = capture();
    const states: string[] = [];
    client.onStateChange((s) => states.push(s));

    void client.connect({ host: "chat.example.org", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    void client.connect({ host: "chat.example.org", token: "t" });
    await vi.advanceTimersByTimeAsync(10);

    const first = seen.find((e) => e.code === "ws.connecting")!.fields.generation as number;
    const superseded = seen.find((e) => e.code === "ws.superseded")!;
    expect(superseded.fields).toEqual({ generation: first, by_generation: first + 1 });

    failFirst(new Error("dial failed"));
    await vi.advanceTimersByTimeAsync(10);
    // The transport drops the old attempt's rejection itself; nothing from it
    // reaches the live attempt's state or its timeline.
    expect(states).not.toContain("disconnected");
    expect(seen.some((e) => e.code === "ws.closed")).toBe(false);

    emitTauriEvent("ws-state", "open");
    await vi.advanceTimersByTimeAsync(10);
    expect(seen.filter((e) => e.code === "ws.open").map((e) => e.fields.generation)).toEqual([
      first + 1,
    ]);
    client.disconnect();
  });
});
