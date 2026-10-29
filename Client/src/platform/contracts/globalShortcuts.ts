/**
 * Global voice shortcuts (U6) and, on Wayland, their setup through the
 * desktop's own shortcut service (LP-9): mute and deafen that fire while the
 * app is unfocused, plus the tray's Mute/Deafen items.
 *
 * The native host delivers global keys one of three ways, named by
 * `status().backend`:
 * - `polling` (Windows, X11 Linux): a 20 ms key-state loop observes the
 *   combination without consuming it and emits one `voice-shortcut` event per
 *   press edge. The combinations are rebindable (`setKeys`); both default to
 *   Ctrl+Shift and the same key set the PTT table can poll.
 * - `portal` (Wayland with xdg-desktop-portal GlobalShortcuts, GNOME 48+ and
 *   KDE Plasma): the desktop owns the keys. `bindPortal` opens the desktop's
 *   own dialog, `status().triggers` reports what the user chose, and the
 *   desktop consumes the key in every app. `setKeys` only seeds the suggested
 *   triggers of the next bind. `configurePortal` opens the desktop's own
 *   shortcut settings where `canConfigure` is true.
 * - `none` (macOS, Wayland without the interface): nothing delivers a global
 *   key; the tray items still work and Settings discloses the gap.
 *
 * Callers choose their UI by `status().backend`, never by a platform check.
 * `start()` is called whenever the host answers; the host decides whether
 * anything observes keys (on `portal` it arms the session, so a press the
 * desktop was told to deliver by its own config gets through even when the
 * portal names no keys). `supported()` is true once a press can actually
 * arrive and the in-app handler should stand down: always on `polling`, and
 * on `portal` only once both mute and deafen are bound.
 * `onShortcut` passes the actions to the renderer, which toggles the same
 * controls the in-app shortcuts do.
 */
/** How the host delivers global keys. */
export type GlobalKeysBackend = "polling" | "portal" | "none";

/** The portal's own description of each bound trigger; `null` is unbound. */
export interface GlobalKeysTriggers {
  ptt: string | null;
  mute: string | null;
  deafen: string | null;
}

/** The host's answer to `global_keys_status` and its `global-keys-changed` payload. */
export interface GlobalKeysStatus {
  backend: GlobalKeysBackend;
  /** The portal interface version; 0 when there is no portal. */
  portalVersion: number;
  triggers: GlobalKeysTriggers;
  /** Whether the portal can open its own shortcut settings (version 2+). */
  canConfigure: boolean;
  /**
   * The portal holds all three of our shortcuts but names none of their keys
   * (xdg-desktop-portal-hyprland always does): the user assigns them in the
   * desktop's own config, so `triggers` stays all `null` and does not mean
   * "not set up".
   */
  triggersUnnamed: boolean;
  /** The portal refused to open a session for us, so no shortcut can work until it does. */
  sessionRefused: boolean;
}

/** Why a portal bind or configure failed. `bind_cancelled` is the user closing the dialog. */
export type GlobalKeysErrorCode =
  | "unsupported"
  | "bind_in_progress"
  | "bind_cancelled"
  | "bind_timeout"
  | "bind_failed"
  | "portal_lost"
  | "unknown";

/** The rejection of `bindPortal` and `configurePortal`. */
export interface GlobalKeysError extends Error {
  readonly code: GlobalKeysErrorCode;
}

export interface GlobalShortcuts {
  /** Start the native polling loop, or arm the portal session on Wayland; a no-op where nothing can observe keys. Idempotent on the host side. */
  start(): Promise<void>;
  /** Whether a global press can arrive now: always on `polling`, only with both keys bound on `portal`. */
  supported(): Promise<boolean>;
  /** Replace the mute/deafen key codes the loop polls, live (on `portal`: the next bind's suggestion). Rejects an out-of-range code. */
  setKeys(keys: { muteVk: number; deafenVk: number }): Promise<void>;
  /** Which backend delivers global keys and which triggers are bound. Never rejects: a host that cannot answer reads as `none`. */
  status(): Promise<GlobalKeysStatus>;
  /**
   * Portal backend only: ask the desktop to bind push to talk, mute and
   * deafen. The key codes only suggest triggers; the desktop's dialog has the
   * last word. Resolves after that dialog (minutes) with the resulting status;
   * rejects with a `GlobalKeysError`.
   */
  bindPortal(keys: { pttVk: number; muteVk: number; deafenVk: number }): Promise<GlobalKeysStatus>;
  /** Portal backend with `canConfigure`: open the desktop's shortcut settings. Rejects with a `GlobalKeysError`. */
  configurePortal(): Promise<void>;
  /** Subscribe to a change of the bound triggers (a bind, the user editing them in system settings, or the portal restarting). */
  onStatusChange(handler: (status: GlobalKeysStatus) => void): () => void;
  /** Subscribe to a mute/deafen action from the global key or the tray. */
  onShortcut(handler: (action: "mute" | "deafen") => void): () => void;
}
