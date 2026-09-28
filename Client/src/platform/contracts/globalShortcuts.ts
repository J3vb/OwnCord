/**
 * Global voice shortcuts (U6): Ctrl+Shift+M mute and Ctrl+Shift+D deafen that
 * fire while the app is unfocused, plus the tray's Mute/Deafen items.
 *
 * The native host owns the polling (a 20 ms key-state loop that observes the
 * combination without consuming it) and emits one `voice-shortcut` event per
 * press edge; the tray emits the same event. This contract only starts that
 * loop, reports whether the platform can observe global keys, and hands
 * the actions to the renderer, which toggles the same controls the in-app
 * shortcuts do.
 *
 * `supported()` is false on macOS and on any Wayland Linux session, where
 * global key state is not observable without the xdg-desktop-portal
 * GlobalShortcuts API. The tray items work regardless; Settings discloses the
 * gap.
 */
export interface GlobalShortcuts {
  /** Start the native polling loop where `supported()` is true. Idempotent on the host side. */
  start(): Promise<void>;
  /** Whether this platform can observe global key state. */
  supported(): Promise<boolean>;
  /** Subscribe to a mute/deafen action from the global key or the tray. */
  onShortcut(handler: (action: "mute" | "deafen") => void): () => void;
}
