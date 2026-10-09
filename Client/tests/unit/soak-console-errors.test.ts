// The soak's console.error allow-list: the LiveKit signal-stream line is
// excused only while the deliberate every-5th-cycle reconnect is in flight.
import { describe, expect, it } from "vitest";
import { unexpectedConsoleErrors } from "../e2e/support/soak-console";

const SIGNAL =
  "error reading from signal stream {room: channel-3, error: ConnectionError: WS closed}";

describe("unexpectedConsoleErrors", () => {
  it("excuses the signal-stream error during the reconnect window", () => {
    expect(unexpectedConsoleErrors([{ text: SIGNAL, duringReconnect: true }])).toEqual([]);
  });

  it("flags the same line outside the reconnect window", () => {
    expect(unexpectedConsoleErrors([{ text: SIGNAL, duringReconnect: false }])).toEqual([SIGNAL]);
  });

  it("keeps the phase-independent entries excused", () => {
    const ws = "[ws] ws_send failed {error: WS is not open";
    const key = "InvalidKey: Decryption failed: x";
    expect(
      unexpectedConsoleErrors([
        { text: ws, duringReconnect: false },
        { text: key, duringReconnect: false },
      ]),
    ).toEqual([]);
  });

  it("still flags unknown errors during the reconnect", () => {
    expect(unexpectedConsoleErrors([{ text: "boom", duringReconnect: true }])).toEqual(["boom"]);
  });
});
