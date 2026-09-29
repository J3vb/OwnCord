// CLI-04(a): the desktop socket transport logs one "TOFU cert event" line per
// (host, status) per app session. Every tunneled REST request re-runs the TOFU
// check, so without the gate a busy server fills the log (and any support
// bundle) with the same trusted line. The gate touches the log line only — the
// first-use / mismatch listeners still see every event.
import { describe, it, expect, beforeEach, vi } from "vitest";

const { info } = vi.hoisted(() => ({ info: vi.fn() }));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info, warn: vi.fn(), error: vi.fn() }),
}));

const handlers = new Map<string, Set<(e: { payload: unknown }) => void>>();
const listenMock = vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
  if (!handlers.has(event)) handlers.set(event, new Set());
  handlers.get(event)!.add(handler);
  return () => {
    handlers.get(event)?.delete(handler);
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

import { socket } from "../../../src/platform/desktop/socket";

function emitCert(host: string, status: "first_use" | "trusted" | "mismatch"): void {
  for (const handler of handlers.get("cert-tofu") ?? []) {
    handler({ payload: { host, fingerprint: "sha256:abc", status } });
  }
}

describe("cert-tofu log line", () => {
  beforeEach(() => {
    info.mockClear();
    handlers.clear();
  });

  it("logs once per host+status, and again when either changes", async () => {
    const connection = socket.create();
    await connection.startCertListener();

    emitCert("a.example:8443", "trusted");
    emitCert("a.example:8443", "trusted");
    emitCert("a.example:8443", "trusted");
    expect(info).toHaveBeenCalledTimes(1);

    // A different host is its own report.
    emitCert("b.example:8443", "trusted");
    expect(info).toHaveBeenCalledTimes(2);

    // A status change for a known host is not suppressed.
    emitCert("a.example:8443", "mismatch");
    expect(info).toHaveBeenCalledTimes(3);
  });

  it("still routes every event to the first-use and mismatch listeners", async () => {
    const connection = socket.create();
    await connection.startCertListener();

    const firstUse = vi.fn();
    const mismatch = vi.fn();
    connection.onCertFirstUse(firstUse);
    connection.onCertMismatch(mismatch);

    emitCert("a.example:8443", "first_use");
    emitCert("a.example:8443", "first_use");
    emitCert("a.example:8443", "mismatch");
    emitCert("a.example:8443", "mismatch");

    expect(firstUse).toHaveBeenCalledTimes(2);
    expect(mismatch).toHaveBeenCalledTimes(2);
    // The log line is deduped even though routing is not.
    expect(info).toHaveBeenCalledTimes(2);
  });
});
