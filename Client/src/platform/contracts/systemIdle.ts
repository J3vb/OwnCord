/**
 * System-wide input idle time, for auto-idle (DP-33). One read-only query:
 * how long since the last keyboard or mouse input anywhere on the machine,
 * not just in this window. `null` where the OS cannot say (a Wayland
 * compositor with neither D-Bus idle monitor, macOS), and the caller falls
 * back to in-window activity.
 */
export interface SystemIdle {
  /** Milliseconds since the last input, or null when unknown. */
  idleMs(): Promise<number | null>;
}
