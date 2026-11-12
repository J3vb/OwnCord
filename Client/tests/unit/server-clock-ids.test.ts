// A device whose clock runs fast (or a server whose clock runs slow) must still
// be able to send: client_message_id is stamped with the server's time from
// ready.server_time_ms, not with the device clock.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyServerTime, serverNow } from "@lib/net/serverClock";
import { newClientMessageId, pendingMessageExpired } from "@lib/pendingMessages";
import { runSessionResets } from "@lib/net/sessionRegistry";

const SERVER_NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
const TEN_MIN = 10 * 60 * 1000;
/** The server's acceptance window for an id's time (message_delivery.go). */
const SERVER_SKEW_MS = 5 * 60 * 1000;

const stamp = (id: string): number => Number(id.split(":", 1)[0]);

describe("server clock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    applyServerTime(undefined);
    vi.useRealTimers();
  });

  it("stamps ids with server time when the device clock is 10 minutes ahead", () => {
    vi.setSystemTime(SERVER_NOW + TEN_MIN);
    applyServerTime(SERVER_NOW);
    const id = newClientMessageId();
    expect(Math.abs(stamp(id) - SERVER_NOW)).toBeLessThan(SERVER_SKEW_MS);
    expect(pendingMessageExpired(id)).toBe(false);
    // Time passes on both clocks alike.
    vi.advanceTimersByTime(60_000);
    expect(serverNow()).toBe(SERVER_NOW + 60_000);
  });

  it("stamps ids with server time when the device clock is a day behind", () => {
    vi.setSystemTime(SERVER_NOW - 25 * 60 * 60 * 1000);
    applyServerTime(SERVER_NOW);
    expect(stamp(newClientMessageId())).toBe(SERVER_NOW);
  });

  it("keeps the restore floor when it is later than server time", () => {
    vi.setSystemTime(SERVER_NOW);
    applyServerTime(SERVER_NOW);
    expect(stamp(newClientMessageId(SERVER_NOW + 1000))).toBe(SERVER_NOW + 1000);
  });

  it("falls back to the device clock for a server that sends no time", () => {
    vi.setSystemTime(SERVER_NOW + TEN_MIN);
    applyServerTime(SERVER_NOW);
    applyServerTime(undefined);
    expect(stamp(newClientMessageId())).toBe(SERVER_NOW + TEN_MIN);
  });

  it("ignores a nonsense time", () => {
    vi.setSystemTime(SERVER_NOW);
    applyServerTime(Number.NaN);
    expect(serverNow()).toBe(SERVER_NOW);
    applyServerTime(0);
    expect(serverNow()).toBe(SERVER_NOW);
  });

  it("forgets the offset when the session ends", () => {
    vi.setSystemTime(SERVER_NOW + TEN_MIN);
    applyServerTime(SERVER_NOW);
    runSessionResets("user");
    expect(serverNow()).toBe(SERVER_NOW + TEN_MIN);
  });
});
