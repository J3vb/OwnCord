// The server's video upload cap per person (camera and screen share together),
// in bits per second; 0 means no cap. Set from auth_ok on every connect and
// resume and from the video_bitrate_cap frame after an admin saves it.
import { registerSessionReset } from "../net/sessionRegistry";

let cap = 0;

/** Who wants to hear the cap change. Owners remove their own listener. */
const listeners = new Set<(bitrate: number) => void>();

/** A wire value as a cap: a whole number of bits per second, else no cap. */
function asCap(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** The cap in force, in bits per second; 0 means no cap. */
export function videoBitrateCap(): number {
  return cap;
}

/**
 * Record the cap the server stated. Returns whether it changed, and tells the
 * listeners when it did.
 */
export function applyVideoBitrateCap(value: unknown): boolean {
  const next = asCap(value);
  if (next === cap) return false;
  cap = next;
  // A Set tolerates a listener unsubscribing itself while it is called.
  for (const listener of listeners) listener(next);
  return true;
}

/** Listen for the cap changing; returns the unsubscribe. */
export function onVideoBitrateCap(listener: (bitrate: number) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Session end: back to no cap. Listeners are kept and told when a cap is lifted. */
export function resetVideoBitrateCap(): void {
  applyVideoBitrateCap(0);
}

// The cap belongs to the server that stated it; a session end forgets it.
void registerSessionReset("voice:video-bitrate-cap", resetVideoBitrateCap, { phase: "voice" });
