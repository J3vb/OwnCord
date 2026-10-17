/**
 * GlobalKeybinds — the app-wide shortcuts the settings Keybinds tab advertises.
 *
 * Quick Switcher (Ctrl+K) is owned by its own manager; everything else the
 * Keybinds tab lists lives here so the panel and the behaviour can't drift.
 * The camera shortcut no-ops outside a voice channel rather than firing
 * signalling messages into a session that doesn't exist. Mute and deafen work
 * anywhere, like the user panel's buttons: outside a call they only change the
 * saved state the next join starts with.
 *
 * While a call is ringing, Ctrl+Enter accepts it (audio only) and Escape
 * declines it, ahead of the mark-read use of Escape below. Both keep to the same
 * rules: no dialog open, not suspended, nobody else used the key.
 *
 * Escape marks the open channel read (Shift+Escape the whole server) only when
 * nothing else used the key: a dialog or Settings open when it was pressed, or
 * any handler that called preventDefault() on it (closing a popup, cancelling
 * an edit), keeps the key for itself.
 */

import { Disposable } from "@lib/disposable";
import { setOwnedTimeout } from "@lib/dom";
import { createLogger } from "@lib/logger";
import { voiceStore } from "@stores/voice.store";
import { dialogOpen, isDisplayed } from "@lib/dialogOpen";
import { keyEventToVk, loadGlobalShortcutVks, type GlobalShortcutVks } from "@lib/voiceShortcuts";
import { inputMode } from "@lib/inputMode";
import { loadPref } from "@lib/preferences";

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
  /** Ctrl+Shift+U — open the composer's attachment picker. */
  readonly onUploadFile: () => void;
  /** Ctrl+E / Ctrl+G — open or close the composer's emoji or GIF picker. */
  readonly onTogglePicker: (kind: "emoji" | "gif") => void;
  /** Escape — mark the open channel read and return to its newest messages. */
  readonly onMarkChannelRead: () => void;
  /** Shift+Escape — mark every server channel read. */
  readonly onMarkServerRead: () => void;
  /** PageUp/PageDown from the message box — scroll the messages a page.
   *  `direction` is 1 for down, -1 for up. */
  readonly onScrollMessages: (direction: 1 | -1) => void;
  /** Alt+↑/↓ — step to the previous/next channel; with Shift, the previous/
   *  next unread one (DP-35). `direction` is 1 for down/next, -1 for up. */
  readonly onStepChannel: (direction: 1 | -1, unreadOnly: boolean) => void;
  /** Whether an incoming-call ring is on screen. While it is, Ctrl+Enter
   *  accepts it and Escape declines it (3B-4); with none, neither key does
   *  anything new. Optional so a host with no calls attaches nothing. */
  readonly ringActive?: () => boolean;
  /** Ctrl+Enter while a ring is current — accept it, audio only. */
  readonly onAcceptRing?: () => void;
  /** Escape while a ring is current — decline it, ahead of mark-read. */
  readonly onDeclineRing?: () => void;
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

    // AltGr arrives as Ctrl+Alt on Windows; a character typed with it (@ on
    // AZERTY) is plain typing, not a shortcut.
    const altGrChar = e.key.length === 1 && e.getModifierState("AltGraph");
    if ((!e.ctrlKey && !e.metaKey && !e.altKey) || altGrChar) {
      handlePlainKey(e);
      return;
    }

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
      if (fromComposer) setOwnedTimeout(owner.signal, focusNewComposer, 0);
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
      if (action === null) {
        // A mute or deafen bound to U before U was reserved keeps it.
        if (key === "u") run("upload-file", handlers.onUploadFile);
        return;
      }
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
      // Ctrl+E / Ctrl+G work from the message box and from an open picker
      // (to close it or switch), but another text field keeps its own keys.
      case "e":
      case "g":
        if (isTypingTarget(e.target) && !isComposer(e.target) && !inPicker(e.target)) break;
        run("toggle-picker", () => handlers.onTogglePicker(key === "e" ? "emoji" : "gif"));
        break;
      default:
        break;
    }
  };

  /** Page keys from the message box scroll the messages; a printable key
   *  with nothing focused starts typing in the message box. */
  const handlePlainKey = (e: KeyboardEvent): void => {
    if (e.isComposing || e.defaultPrevented) return;
    if (e.key === "PageUp" || e.key === "PageDown") {
      // A focused scroller pages itself; only these two would page nothing.
      if (!isComposer(e.target) && e.target !== document.body) return;
      if (dialogOpen()) return;
      const direction = e.key === "PageDown" ? 1 : -1;
      runGlobal(e, "scroll-messages", () => handlers.onScrollMessages(direction));
      return;
    }
    // Space stays with the page (scrolling, pressing a focused control).
    if (e.key.length !== 1 || e.key === " " || e.repeat || !isIdleTarget(e.target)) return;
    // The push-to-talk key is polled natively and still reaches the page;
    // held during a call it must not type into the message box.
    if (isPttKey(e) || dialogOpen()) return;
    const composer = findComposer();
    // Focus moves before the key's default runs, so the character lands in
    // the message box: no preventDefault here.
    if (composer !== null) composer.focus();
  };

  // Escape is decided after every other listener: the window's bubble phase
  // runs last. What was open is read in its capture phase, before the key
  // closes it.
  let escapeTaken = false;
  const onEscapeCapture = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    escapeTaken = handlers.isSuspended?.() === true || dialogOpen();
  };
  // Ctrl+Enter answers a ringing call. It is taken in the capture phase,
  // before the message box would send its draft on the same key; with no
  // ring the key reaches the message box untouched.
  const onAcceptRingCapture = (e: KeyboardEvent): void => {
    if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    if (e.repeat || e.isComposing || handlers.isSuspended?.() === true || dialogOpen()) return;
    if (handlers.ringActive?.() !== true) return;
    e.stopPropagation();
    runGlobal(e, "accept-ring", () => handlers.onAcceptRing?.());
  };
  const onEscape = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || e.ctrlKey || e.metaKey || e.altKey) return;
    if (escapeTaken || e.defaultPrevented || e.isComposing || e.repeat) return;
    if (isTypingTarget(e.target) && !isComposer(e.target)) return;
    // A ringing call outranks mark-read: the key declines it, and the
    // preventDefault inside runGlobal keeps anything else from reusing it.
    if (!e.shiftKey && handlers.ringActive?.() === true) {
      runGlobal(e, "decline-ring", () => handlers.onDeclineRing?.());
      return;
    }
    if (e.shiftKey) runGlobal(e, "mark-server-read", handlers.onMarkServerRead);
    else runGlobal(e, "mark-channel-read", handlers.onMarkChannelRead);
  };

  const owner = new Disposable();
  document.addEventListener("keydown", handler, { signal: owner.signal });
  window.addEventListener("keydown", onEscapeCapture, { capture: true, signal: owner.signal });
  window.addEventListener("keydown", onAcceptRingCapture, { capture: true, signal: owner.signal });
  window.addEventListener("keydown", onEscape, { signal: owner.signal });
  return () => owner.destroy();
}

/** Controls that take keys of their own; typing on one of them stays there. */
const INTERACTIVE =
  'button, a[href], input, textarea, select, [contenteditable="true"], [role="button"], ' +
  '[role="menu"], [role="menuitem"], [role="listbox"], [role="option"], [role="tab"], ' +
  '[role="slider"], [role="radio"], [role="checkbox"], [role="switch"], [role="textbox"]';

/** Nothing that takes typed keys has focus. */
function isIdleTarget(target: EventTarget | null): boolean {
  if (target === document.body || target === document.documentElement) return true;
  return target instanceof Element && target.closest(INTERACTIVE) === null;
}

/** Inside an open emoji or GIF picker, which focuses its own search field. */
function inPicker(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".emoji-picker, .gif-picker") !== null;
}

/** The bound push-to-talk key, in a call with Push to Talk as the input mode. `keyCode`
 *  is the Windows VK the native poller uses, on every platform for these keys. */
function isPttKey(e: KeyboardEvent): boolean {
  if (!inVoice() || inputMode() !== "ptt") return false;
  const vk = loadPref<number>("pttVk", 0);
  return vk !== 0 && e.keyCode === vk;
}

/** The message box on screen, when it can be typed into. */
function findComposer(): HTMLTextAreaElement | null {
  const composer = document.querySelector<HTMLTextAreaElement>("textarea.msg-textarea");
  if (composer === null || composer.readOnly || composer.disabled) return null;
  return isDisplayed(composer) ? composer : null;
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
