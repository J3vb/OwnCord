/**
 * GlobalKeybinds — the app-wide shortcuts the settings Keybinds tab advertises.
 *
 * Quick Switcher (Ctrl+K) is owned by its own manager; everything else the
 * Keybinds tab lists lives here so the panel and the behaviour can't drift.
 * Voice actions no-op outside a voice channel rather than firing signalling
 * messages into a session that doesn't exist.
 */

import { Disposable } from "@lib/disposable";
import { createLogger } from "@lib/logger";
import { voiceStore } from "@stores/voice.store";

const log = createLogger("global-keybinds");

export interface GlobalKeybindHandlers {
  /** Ctrl+F — open the message search overlay. */
  readonly onSearch: () => void;
  /** Ctrl+M — toggle microphone mute (voice only). */
  readonly onToggleMute: () => void;
  /** Ctrl+D — toggle deafen (voice only). */
  readonly onToggleDeafen: () => void;
  /** Ctrl+Shift+V — toggle the camera (voice only). */
  readonly onToggleCamera: () => void;
  /** Ctrl+U — open the composer's attachment picker. */
  readonly onUploadFile: () => void;
  /** Whether shortcuts should be ignored right now (e.g. settings overlay open). */
  readonly isSuspended?: () => boolean;
}

/** True while the user is connected to a voice channel. */
function inVoice(): boolean {
  return voiceStore.getState().currentChannelId !== null;
}

/** True while a modal dialog is open — the global shortcuts must not fire
 *  behind it and swallow the key from the dialog's own fields (#17). */
export function dialogOpen(): boolean {
  return Array.from(
    document.querySelectorAll<HTMLElement>('.modal-overlay, [aria-modal="true"]'),
  ).some(isShown);
}

/** A mounted-but-hidden dialog (the Settings panel inside its closed
 *  overlay) is not open: every ancestor must be displayed too. */
function isShown(el: HTMLElement): boolean {
  for (let n: HTMLElement | null = el; n !== null; n = n.parentElement) {
    if (n.hidden || getComputedStyle(n).display === "none") return false;
  }
  return true;
}

/**
 * Register the shortcuts on `document`. Returns a detach function.
 */
export function attachGlobalKeybinds(handlers: GlobalKeybindHandlers): () => void {
  const handler = (e: KeyboardEvent): void => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (handlers.isSuspended?.() === true) return;
    // A modal owns the keyboard while it is up.
    if (dialogOpen()) return;

    // `e.key` is layout-dependent and uppercases with Shift held — compare
    // case-insensitively so Ctrl+Shift+V arrives as "V", not a missed "v".
    const key = e.key.toLowerCase();

    const run = (label: string, action: () => void): void => {
      e.preventDefault();
      try {
        action();
      } catch (err) {
        log.error("Keybind handler failed", { key: label, error: String(err) });
      }
    };

    if (e.shiftKey) {
      // Only Ctrl+Shift+V is claimed; other Shift combos fall through to the app.
      if (key === "v" && inVoice()) run("toggle-camera", handlers.onToggleCamera);
      return;
    }

    switch (key) {
      case "f":
        run("search", handlers.onSearch);
        break;
      case "m":
        if (inVoice()) run("toggle-mute", handlers.onToggleMute);
        break;
      case "d":
        if (inVoice()) run("toggle-deafen", handlers.onToggleDeafen);
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
