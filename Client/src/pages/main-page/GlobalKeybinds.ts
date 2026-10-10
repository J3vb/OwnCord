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
import { dialogOpen } from "@lib/dialogOpen";

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
  /** Alt+↑/↓ — step to the previous/next channel; with Shift, the previous/
   *  next unread one (DP-35). `direction` is 1 for down/next, -1 for up. */
  readonly onStepChannel: (direction: 1 | -1, unreadOnly: boolean) => void;
  /** Whether shortcuts should be ignored right now (e.g. settings overlay open). */
  readonly isSuspended?: () => boolean;
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
    // a text field disqualifies the step rather than swallowing the key.
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      if (dialogOpen() || isTypingTarget(e.target)) return;
      const direction = e.key === "ArrowDown" ? 1 : -1;
      runGlobal(e, "step-channel", () => handlers.onStepChannel(direction, e.shiftKey));
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

/** A text-entry control, where a bare Alt+Arrow belongs to the field. */
function isTypingTarget(target: EventTarget | null): boolean {
  return (
    (target instanceof HTMLInputElement && target.type !== "range") ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
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
