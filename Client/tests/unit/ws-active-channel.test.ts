import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import * as wsMocks from "./helpers/ws-mocks";

vi.mock("@tauri-apps/api/core", () => wsMocks.tauriCoreMock());
vi.mock("@tauri-apps/api/event", () => wsMocks.tauriEventMock());

import { mockInvoke, mockListen, eventHandlers, emitTauriEvent } from "./helpers/ws-mocks";
import { createWsClient, setActiveChannelProvider } from "../../src/lib/ws";
import { useWsClientFixture } from "../helpers/wsClientFixture";
import {
  openSocket,
  emitAuthOk,
  dropAndClear,
  lastAuthPayload as getAuthPayload,
} from "../helpers/wsSuiteHarness";

/** activeChannelProvider is a module-level singleton (registered once at app
 *  bootstrap in dispatcher.ts); reset it so state does not leak across tests. */
function resetProvider(): void {
  beforeEach(() => setActiveChannelProvider(null));
  afterEach(() => setActiveChannelProvider(null));
}

const hasActiveChannelKey = (payload: Record<string, unknown>): boolean =>
  Object.prototype.hasOwnProperty.call(payload, "active_channel_id");

describe("auth frame: active_channel_id", () => {
  let client: ReturnType<typeof createWsClient>;
  useWsClientFixture((created) => {
    client = created;
  });
  resetProvider();

  /** Connects, authenticates at `seq`, drops, and lets the reconnect's auth go out. */
  async function reconnectAfterAuth(seq: number): Promise<void> {
    await openSocket(client);
    emitAuthOk({ seq });
    dropAndClear();
    await vi.advanceTimersByTimeAsync(1100);
    emitTauriEvent("ws-state", "open");
  }

  it("fresh connect (reconnectAttempt=0, lastSeq=0): no active_channel_id key even with a provider registered", async () => {
    setActiveChannelProvider(() => 99);
    await openSocket(client);

    const payload = getAuthPayload();
    expect(payload.last_seq).toBe(0);
    expect(hasActiveChannelKey(payload)).toBe(false);
  });

  it.each([
    [
      "reconnect with lastSeq > 0 and a registered provider: active_channel_id carries the provider's id",
      7,
      () => 42,
      42,
    ],
    [
      "reconnect with lastSeq > 0 and NO provider registered: no active_channel_id key",
      3,
      null,
      undefined,
    ],
    [
      "reconnect with lastSeq > 0 and a provider that returns null: no active_channel_id key",
      4,
      () => null,
      undefined,
    ],
  ])("%s", async (_name, seq, provider, expected) => {
    setActiveChannelProvider(provider);
    await reconnectAfterAuth(seq);

    const payload = getAuthPayload();
    expect(payload.last_seq).toBe(seq);
    if (expected === undefined) expect(hasActiveChannelKey(payload)).toBe(false);
    else expect(payload.active_channel_id).toBe(expected);
  });

  it("lastSeq > 0 but reconnectAttempt === 0: the provider is still consulted (gated on lastSeq, not reconnect count)", async () => {
    // First "open": reconnectAttempt=0, lastSeq=0 — irrelevant, just gets us started.
    await openSocket(client);

    // Bump lastSeq WITHOUT ever going through a "closed"/scheduleReconnect
    // cycle, so reconnectAttempt never increments off 0.
    emitTauriEvent(
      "ws-message",
      JSON.stringify({
        type: "presence",
        seq: 9,
        payload: { user_id: 1, status: "idle" },
      }),
    );

    setActiveChannelProvider(() => 5);
    mockInvoke.mockClear();

    // Rust reports "open" again on the same (never-closed) connection.
    emitTauriEvent("ws-state", "open");

    const payload = getAuthPayload();
    expect(payload.last_seq).toBe(9);
    expect(payload.active_channel_id).toBe(5);
  });

  it("reconnectAttempt > 0 but lastSeq === 0: no active_channel_id key", async () => {
    setActiveChannelProvider(() => 5);

    await openSocket(client);
    // No message ever arrives — lastSeq stays 0.

    dropAndClear();
    await vi.advanceTimersByTimeAsync(1100);
    emitTauriEvent("ws-state", "open"); // reconnectAttempt is now 1, lastSeq is still 0

    const payload = getAuthPayload();
    expect(payload.last_seq).toBe(0);
    expect(hasActiveChannelKey(payload)).toBe(false);
  });
});

describe("auth frame: features", () => {
  useWsClientFixture(() => {});
  resetProvider();

  /** Dials a fresh client and returns the features its auth frame declared. */
  async function dial(): Promise<unknown> {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    mockListen.mockClear();
    eventHandlers.clear();
    const client = createWsClient();
    await openSocket(client);
    const features = getAuthPayload().features;
    client.disconnect();
    return features;
  }

  it("declares the forums feature on every auth, so the server sends forum channels", async () => {
    expect(await dial()).toEqual(["forums"]);
  });

  it("adds mobile only in the Android app, not in a phone browser", async () => {
    // A phone browser: Android user agent, no native host.
    vi.stubGlobal("navigator", { ...navigator, userAgent: "Mozilla/5.0 (Linux; Android 14)" });
    expect(await dial()).toEqual(["forums"]);

    // The Android app: a Tauri host on an Android user agent.
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    expect(await dial()).toEqual(["forums", "mobile"]);

    vi.unstubAllGlobals();
  });
});
