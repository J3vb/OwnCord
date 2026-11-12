/**
 * System-wide input idle time, for auto-idle. One read-only query:
 * how long since the last keyboard or mouse input anywhere on the machine,
 * not just in this window. `null` where the OS cannot say (a Wayland
 * compositor with neither D-Bus idle monitor, macOS), and the caller falls
 * back to in-window activity.
 *
 * A phone has no keyboard to watch. In the Android app the idle time is how
 * long the app has been out of view (in the background, or the screen off),
 * and 0 while it shows: someone looking at the app is here.
 */
export interface SystemIdle {
  /** Milliseconds since the last input, or null when unknown. */
  idleMs(): Promise<number | null>;
  /** For a host that knows when the answer matters without being polled:
   *  until `signal` aborts, it calls `ask` when `idleMs` is worth reading
   *  again at once. The Android app does as it starts to follow, when it
   *  comes back into view, and each time it has been out of view for
   *  `thresholdMs`, which it also notices on a phone that sleeps (a sleeping
   *  phone runs no timer of the page). One follower at a time: a newer one
   *  takes over. A host that is only ever polled calls nothing. */
  follow(signal: AbortSignal, thresholdMs: number, ask: () => void): void;
}
