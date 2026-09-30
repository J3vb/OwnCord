/**
 * Global voice shortcuts (U6): mute and deafen that fire while the app is
 * unfocused, plus the tray's Mute/Deafen items.
 *
 * The native host owns the polling (a 20 ms key-state loop that observes the
 * combination without consuming it) and emits one `voice-shortcut` event per
 * press edge; the tray emits the same event. This contract starts that loop,
 * reports whether the platform can observe global keys, hands a rebound
 * combination to the loop, and passes the actions to the renderer, which
 * toggles the same controls the in-app shortcuts do.
 *
 * The combinations are rebindable (Settings, Keybinds); both default to
 * Ctrl+Shift and the same key set the PTT table can poll, so a rebind is live
 * on the running poller without a restart.
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
  /** Replace the mute/deafen key codes the loop polls, live. Rejects an out-of-range code. */
  setKeys(keys: { muteVk: number; deafenVk: number }): Promise<void>;
  /** Subscribe to a mute/deafen action from the global key or the tray. */
  onShortcut(handler: (action: "mute" | "deafen") => void): () => void;
}
