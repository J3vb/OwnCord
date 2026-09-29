// CLI-04(a): the desktop socket transport skips a "trusted" log line while the
// host's last logged status is already "trusted". Every tunneled REST request
// re-runs the TOFU check, so without the gate a busy server fills the log (and
// any support bundle) with the same trusted line. "first_use" and "mismatch"
// always log, and the listeners still see every event.
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

  it("logs a repeated trusted report once per host", async () => {
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

  it("logs trusted again after a mismatch is accepted", async () => {
    const connection = socket.create();
    await connection.startCertListener();

    emitCert("a.example:8443", "trusted");
    emitCert("a.example:8443", "mismatch");
    emitCert("a.example:8443", "trusted");
    emitCert("a.example:8443", "trusted");

    expect(info.mock.calls.map(([, ctx]) => (ctx as { status: string }).status)).toEqual([
      "trusted",
      "mismatch",
      "trusted",
    ]);
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
    // Repeated first_use and mismatch reports each log — a second, different
    // certificate change must not vanish from the log.
    expect(info).toHaveBeenCalledTimes(4);
  });
});
