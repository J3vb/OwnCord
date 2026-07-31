import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.mock is hoisted per file; the factories resolve to the shared handles
// exported from ./helpers/ws-mocks (see that module's doc comment).
vi.mock("@tauri-apps/api/core", async () => ({
  invoke: (await import("./helpers/ws-mocks")).mockInvoke,
}));

vi.mock("@tauri-apps/api/event", async () => ({
  listen: (await import("./helpers/ws-mocks")).mockListen,
}));

import { mockInvoke, mockListen, eventHandlers, emitTauriEvent } from "./helpers/ws-mocks";
import { createWsClient } from "../../src/lib/ws";

describe("cert mismatch blocking", () => {
  let client: ReturnType<typeof createWsClient>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    mockListen.mockClear();
    eventHandlers.clear();
    client = createWsClient();
  });

  afterEach(() => {
    client.disconnect();
    vi.useRealTimers();
  });

  it("should block reconnect when cert mismatch detected", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        seq: 1,
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S",
          motd: "",
        },
      }),
    );

    // Cert mismatch event fires
    emitTauriEvent("cert-tofu", {
      host: "localhost:8443",
      fingerprint: "sha256:NEW",
      status: "mismatch",
      message: "Stored: sha256:OLD",
    });

    expect(client.getState()).toBe("disconnected");

    // Connection closes after mismatch
    emitTauriEvent("ws-state", "closed");

    // Wait well beyond normal backoff — should NOT reconnect
    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    const reconnectCalls = mockInvoke.mock.calls.filter((c) => c[0] === "ws_connect");
    expect(reconnectCalls).toHaveLength(0);
  });

  it("should unblock after acceptCertFingerprint", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        seq: 1,
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S",
          motd: "",
        },
      }),
    );

    emitTauriEvent("cert-tofu", {
      host: "localhost:8443",
      fingerprint: "sha256:NEW",
      status: "mismatch",
      message: "Stored: sha256:OLD",
    });

    expect(client.getState()).toBe("disconnected");

    // Accept the new fingerprint
    await client.acceptCertFingerprint("localhost:8443", "sha256:NEW");

    // Now a manual reconnect should work
    mockInvoke.mockClear();
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);

    expect(mockInvoke).toHaveBeenCalledWith("ws_connect", expect.anything());
  });

  it("routes first_use cert events to onCertFirstUse, not onCertMismatch (F4/F8)", async () => {
    const firstUse: unknown[] = [];
    const mismatch: unknown[] = [];
    client.onCertFirstUse((e) => firstUse.push(e));
    client.onCertMismatch((e) => mismatch.push(e));

    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);

    emitTauriEvent("cert-tofu", {
      host: "localhost:8443",
      fingerprint: "sha256:NEW",
      status: "first_use",
    });

    expect(firstUse).toHaveLength(1);
    expect(mismatch).toHaveLength(0);
  });

  it("startCertListener catches cert events before any WS connect (connect-page path)", async () => {
    const firstUse: unknown[] = [];
    client.onCertFirstUse((e) => firstUse.push(e));

    // No connect() — main.ts registers the listener at bootstrap so first-use
    // fires during the connect page's health check, before login.
    await client.startCertListener();

    emitTauriEvent("cert-tofu", {
      host: "localhost:8443",
      fingerprint: "sha256:NEW",
      status: "first_use",
    });

    expect(firstUse).toHaveLength(1);
  });

  it("should not schedule reconnect when certMismatchBlock is true", async () => {
    const mismatchEvents: unknown[] = [];
    client.onCertMismatch((evt) => mismatchEvents.push(evt));

    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        seq: 1,
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S",
          motd: "",
        },
      }),
    );

    // Trigger mismatch
    emitTauriEvent("cert-tofu", {
      host: "localhost:8443",
      fingerprint: "sha256:CHANGED",
      status: "mismatch",
      message: "Stored: sha256:ORIGINAL",
    });

    expect(mismatchEvents).toHaveLength(1);

    // Connection drops
    emitTauriEvent("ws-state", "closed");

    // State should remain disconnected, not reconnecting
    expect(client.getState()).toBe("disconnected");

    mockInvoke.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);

    const reconnects = mockInvoke.mock.calls.filter((c) => c[0] === "ws_connect");
    expect(reconnects).toHaveLength(0);
  });
});

describe("parseStoredFingerprint", () => {
  // Import the pure function directly
  let parseStoredFingerprint: typeof import("../../src/lib/ws").parseStoredFingerprint;

  beforeEach(async () => {
    const mod = await import("../../src/lib/ws");
    parseStoredFingerprint = mod.parseStoredFingerprint;
  });

  it("returns undefined for undefined input", () => {
    expect(parseStoredFingerprint(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parseStoredFingerprint("")).toBeUndefined();
  });

  it("returns undefined when no Stored: prefix found", () => {
    expect(parseStoredFingerprint("no match here")).toBeUndefined();
  });

  it("extracts fingerprint after Stored: prefix", () => {
    expect(parseStoredFingerprint("Stored: sha256:ABCDEF")).toBe("sha256:ABCDEF");
  });

  it("extracts first non-whitespace token after Stored:", () => {
    expect(parseStoredFingerprint("Stored:   sha256:XYZ  trailing")).toBe("sha256:XYZ");
  });

  it("extracts fingerprint from longer message string", () => {
    expect(parseStoredFingerprint("Certificate mismatch. Stored: sha256:OLD123")).toBe(
      "sha256:OLD123",
    );
  });
});

describe("cert-tofu non-mismatch statuses", () => {
  let client: ReturnType<typeof createWsClient>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    mockListen.mockClear();
    eventHandlers.clear();
    client = createWsClient();
  });

  afterEach(() => {
    client.disconnect();
    vi.useRealTimers();
  });

  it("trusted_first_use status does not block reconnect", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S",
          motd: "",
        },
      }),
    );

    // Non-mismatch cert event
    emitTauriEvent("cert-tofu", {
      host: "localhost:8443",
      fingerprint: "sha256:FIRST",
      status: "trusted_first_use",
    });

    // State should still be connected (not disconnected)
    expect(client.getState()).toBe("connected");

    // Verify mismatch listener was NOT called
    const mismatchEvents: unknown[] = [];
    client.onCertMismatch((e) => mismatchEvents.push(e));

    emitTauriEvent("cert-tofu", {
      host: "localhost:8443",
      fingerprint: "sha256:TRUSTED",
      status: "trusted",
    });

    expect(mismatchEvents).toHaveLength(0);
    expect(client.getState()).toBe("connected");
  });
});

describe("acceptCertFingerprint edge cases", () => {
  let client: ReturnType<typeof createWsClient>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    mockListen.mockClear();
    eventHandlers.clear();
    client = createWsClient();
  });

  afterEach(() => {
    client.disconnect();
    vi.useRealTimers();
  });

  it("calls Tauri invoke with correct command and args", async () => {
    // Must connect first so Tauri APIs are loaded
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);

    await client.acceptCertFingerprint("example.com", "sha256:NEWCERT");

    expect(mockInvoke).toHaveBeenCalledWith("accept_cert_fingerprint", {
      host: "example.com",
      fingerprint: "sha256:NEWCERT",
    });
  });

  it("clears certMismatchBlock so reconnect works again", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S",
          motd: "",
        },
      }),
    );

    // Block with mismatch
    emitTauriEvent("cert-tofu", {
      host: "localhost:8443",
      fingerprint: "sha256:NEW",
      status: "mismatch",
    });
    expect(client.getState()).toBe("disconnected");

    // Accept fingerprint
    await client.acceptCertFingerprint("localhost:8443", "sha256:NEW");

    // Reconnect should now work
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    expect(client.getState()).toBe("connecting");
  });
});

describe("disconnect resets certMismatchBlock", () => {
  let client: ReturnType<typeof createWsClient>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    mockListen.mockClear();
    eventHandlers.clear();
    client = createWsClient();
  });

  afterEach(() => {
    client.disconnect();
    vi.useRealTimers();
  });

  it("clears certMismatchBlock on intentional disconnect", async () => {
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);
    emitTauriEvent("ws-state", "open");

    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "auth_ok",
        payload: {
          user: { id: 1, username: "a", avatar: null, role: "admin" },
          server_name: "S",
          motd: "",
        },
      }),
    );

    // Set cert mismatch block
    emitTauriEvent("cert-tofu", {
      host: "localhost:8443",
      fingerprint: "sha256:NEW",
      status: "mismatch",
    });

    // Intentional disconnect should clear the block
    client.disconnect();

    // Now reconnect should work (certMismatchBlock was cleared)
    mockInvoke.mockClear();
    client.connect({ host: "localhost:8443", token: "t" });
    await vi.advanceTimersByTimeAsync(10);

    expect(mockInvoke).toHaveBeenCalledWith("ws_connect", expect.anything());
    expect(client.getState()).toBe("connecting");
  });
});
