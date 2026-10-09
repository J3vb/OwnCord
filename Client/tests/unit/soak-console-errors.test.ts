// The soak's console.error allow-list: the LiveKit signal-stream line is
// excused only while the deliberate every-5th-cycle reconnect is in flight, or
// for the room the app has just left and not rejoined.
import { describe, expect, it } from "vitest";
import { unexpectedConsoleErrors } from "../e2e/support/soak-console";

const SIGNAL =
  "error reading from signal stream {room: channel-3, error: ConnectionError: WS closed}";

// The app's own lines that bracket a voice session, as the soak's console sees them.
const join = (channelId: number) => ({
  text: `[2026-10-09T03:53:42.341Z] [INFO] [voice-callbacks] Joining voice channel {channelId: ${channelId}}`,
  duringReconnect: false,
  type: "info",
});
const left = {
  text: "[2026-10-09T03:53:42.921Z] [INFO] [livekitSession] Left voice session ",
  duringReconnect: false,
  type: "info",
};
const signal = { text: SIGNAL, duringReconnect: false };

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

  it("excuses the signal-stream error of the room the app just left", () => {
    // Dev run 37880494738: the voice_leave's server-side participant removal
    // closed the signal socket before room.disconnect() did.
    expect(unexpectedConsoleErrors([join(3), left, signal])).toEqual([]);
  });

  it("flags the signal-stream error of a room still joined, another room, or after a rejoin", () => {
    expect(unexpectedConsoleErrors([join(3), signal])).toEqual([SIGNAL]);
    expect(unexpectedConsoleErrors([join(4), left, signal])).toEqual([SIGNAL]);
    expect(unexpectedConsoleErrors([join(3), left, join(3), signal])).toEqual([SIGNAL]);
  });

  it("ignores console lines that are not errors", () => {
    expect(
      unexpectedConsoleErrors([join(3), { text: "boom", duringReconnect: false, type: "info" }]),
    ).toEqual([]);
  });

  it("still flags unknown errors during the reconnect", () => {
    expect(unexpectedConsoleErrors([{ text: "boom", duringReconnect: true }])).toEqual(["boom"]);
  });
});
