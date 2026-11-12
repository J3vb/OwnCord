/**
 * The connected server's clock, as an offset from this device's.
 *
 * A `client_message_id` starts with the time it was made, and the server
 * refuses one more than five minutes ahead of its own clock. Building it from
 * the device clock locked out every send from a device whose clock runs fast
 * (or on a server whose clock runs slow). `ready.server_time_ms` gives the
 * server's clock once per connection; ids are built from that instead.
 *
 * The offset includes the ready frame's travel time, which only makes
 * `serverNow()` read slightly behind the server: the safe side of its check.
 * Until a ready carries the field (an older server) the offset is 0, which is
 * the device clock as before.
 */
import { registerSessionReset } from "./sessionRegistry";

let offsetMs = 0;

/** Record the server clock a full `ready` stated, at the moment it arrived. */
export function applyServerTime(serverTimeMs: number | undefined, receivedAt = Date.now()): void {
  offsetMs =
    serverTimeMs === undefined || !Number.isFinite(serverTimeMs) || serverTimeMs <= 0
      ? 0
      : receivedAt - serverTimeMs;
}

/** The server's time now, in Unix milliseconds, as best this device can tell. */
export function serverNow(): number {
  return Date.now() - offsetMs;
}

// Module lifetime: the offset belongs to whichever session is signed in.
void registerSessionReset(
  "serverClock:offset",
  () => {
    offsetMs = 0;
  },
  { phase: "cache" },
);
