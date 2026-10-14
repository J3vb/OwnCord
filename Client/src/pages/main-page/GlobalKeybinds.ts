/**
 * GlobalKeybinds — the app-wide shortcuts the settings Keybinds tab advertises.
 *
 * Quick Switcher (Ctrl+K) is owned by its own manager; everything else the
 * Keybinds tab lists lives here so the panel and the behaviour can't drift.
 * The camera shortcut no-ops outside a voice channel rather than firing
 * signalling messages into a session that doesn't exist. Mute and deafen work
 * anywhere, like the user panel's buttons: outside a call they only change the
 * saved state the next join starts with.
 */

import { Disposable } from "@lib/disposable";
import { createLogger } from "@lib/logger";
import { voiceStore } from "@stores/voice.store";
import { dialogOpen } from "@lib/dialogOpen";
import { keyEventToVk, loadGlobalShortcutVks, type GlobalShortcutVks } from "@lib/voiceShortcuts";

const log = createLogger("global-keybinds");

export interface GlobalKeybindHandlers {
  /** Ctrl+F — open the message search overlay. */
  readonly onSearch: () => void;
  /** The global mute binding (default Ctrl+Shift+M), or the Ctrl+M alias — toggle mute. */
  readonly onToggleMute: () => void;
  /** The global deafen binding (default Ctrl+Shift+D), or the Ctrl+D alias — toggle deafen. */
  readonly onToggleDeafen: () => void;
  /** Ctrl+Shift+V — toggle the camera (voice only). */
  readonly onToggleCamera: () => void;
  /** Ctrl+U — open the composer's attachment picker. */
  readonly onUploadFile: () => void;
  /** Alt+↑/↓ — step to the previous/next channel; with Shift, the previous/
   *  next unread one (DP-35). `direction` is 1 for down/next, -1 for up. */
  readonly onStepChannel: (direction: 1 | -1, unreadOnly: boolean) => void;
  /** Whether shortcuts should be ignored right now (e.g. settings overlay open). */
  readonly isSuspended?: () => boolean;
  /** The mute/deafen keys of the global shortcut, read on every press so a
   *  Settings rebind applies at once. Defaults to the persisted binding. */
  readonly voiceShortcutKeys?: () => GlobalShortcutVks;
  /** True while the native poller delivers the voice shortcuts itself (it
   *  sees the keys focused or not), so the in-app handler must not toggle too. */
  readonly isGlobalPollerActive?: () => boolean;
}

/** True while the user is connected to a voice channel. */
function inVoice(): boolean {
  return voiceStore.getState().currentChannelId !== null;
}

/**
 * Register the shortcuts on `document`. Returns a detach function.
 */
export function attachGlobalKeybinds(handlers: GlobalKeybindHandlers): () => void {
  const handler = (e: KeyboardEvent): void => {
    if (handlers.isSuspended?.() === true) return;

    // Alt+↑/↓ (DP-35) steps channels; Alt+Shift+↑/↓ steps unread channels.
    // Checked before the Ctrl/Meta guard below, which rejects any Alt combo.
    // A plain Alt+Arrow is not a text-editing shortcut, but AltGr arrives as
    // ctrlKey+altKey and the composer's own Alt use must win, so Ctrl/Meta or
    // a text field disqualifies the step rather than swallowing the key. The
    // message composer is the exception: like Discord, the step works while
    // typing there (an IME composition still keeps the key).
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      // A mention or emoji popup in the composer claims the arrows first.
      if (dialogOpen() || e.isComposing || e.defaultPrevented) return;
      const fromComposer = isComposer(e.target);
      if (isTypingTarget(e.target) && !fromComposer) return;
      const direction = e.key === "ArrowDown" ? 1 : -1;
      runGlobal(e, "step-channel", () => handlers.onStepChannel(direction, e.shiftKey));
      // The switch rebuilds the composer once the store notifies (a microtask
      // later); keep typing in the new one unless focus has moved on since.
      if (fromComposer) setTimeout(focusNewComposer, 0);
      return;
    }

    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    // A modal owns the keyboard while it is up.
    if (dialogOpen()) return;

    // `e.key` is layout-dependent and uppercases with Shift held — compare
    // case-insensitively so Ctrl+Shift+V arrives as "V", not a missed "v".
    const key = e.key.toLowerCase();

    const run = (label: string, action: () => void): void => runGlobal(e, label, action);

    if (e.shiftKey) {
      if (key === "v") {
        if (inVoice()) run("toggle-camera", handlers.onToggleCamera);
        return;
      }
      // Mute and deafen use the global shortcut's own binding, so the focused
      // and unfocused keys can never disagree. Other Shift combos fall through.
      const vk = keyEventToVk(e);
      const keys = (handlers.voiceShortcutKeys ?? loadGlobalShortcutVks)();
      const action = vk === keys.mute ? "mute" : vk === keys.deafen ? "deafen" : null;
      if (action === null) return;
      if (handlers.isGlobalPollerActive?.() === true) {
        // The poller fires on exactly Ctrl+Shift; any other combo is not ours.
        if (e.ctrlKey && !e.metaKey) e.preventDefault();
        return;
      }
      // Like the poller, toggle on the press edge only, not on auto-repeat.
      if (e.repeat) {
        e.preventDefault();
        return;
      }
      if (action === "mute") run("toggle-mute", handlers.onToggleMute);
      else run("toggle-deafen", handlers.onToggleDeafen);
      return;
    }

    switch (key) {
      case "f":
        run("search", handlers.onSearch);
        break;
      // Ctrl+M / Ctrl+D: hidden aliases from before the Ctrl+Shift keys.
      // A text field keeps its own Ctrl+D (forward-delete on macOS).
      // remove after beta.5
      case "m":
        if (!isTypingTarget(e.target)) run("toggle-mute", handlers.onToggleMute);
        break;
      case "d":
        if (!isTypingTarget(e.target)) run("toggle-deafen", handlers.onToggleDeafen);
        break;
      case "u":
        run("upload-file", handlers.onUploadFile);
        break;
      default:
        break;
    }
  };

  const owner = new Disposable();
  document.addEventListener("keydown", handler, { signal: owner.signal });
  return () => owner.destroy();
}

/** A text-entry control, where a bare Alt+Arrow belongs to the field. */
function isTypingTarget(target: EventTarget | null): boolean {
  return (
    (target instanceof HTMLInputElement && target.type !== "range") ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function focusNewComposer(): void {
  const active = document.activeElement;
  if (active !== null && active !== document.body) return;
  document.querySelector<HTMLTextAreaElement>("textarea.msg-textarea")?.focus();
}

/** The message composer's textarea, where Alt+↑/↓ still steps channels. */
function isComposer(target: EventTarget | null): boolean {
  return target instanceof HTMLTextAreaElement && target.classList.contains("msg-textarea");
}

/** Prevent the default and report any handler error rather than let it escape. */
function runGlobal(e: KeyboardEvent, label: string, action: () => void): void {
  e.preventDefault();
  try {
    action();
  } catch (err) {
    log.error("Keybind handler failed", { key: label, error: String(err) });
  }
}
