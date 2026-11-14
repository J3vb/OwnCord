/**
 * GlobalKeybinds — the app-wide shortcuts the settings Keybinds tab advertises.
 *
 * Quick Switcher (Ctrl+K) is owned by its own manager; everything else the
 * Keybinds tab lists lives here so the panel and the behaviour can't drift.
 * Camera, screen share and disconnect are rebindable and no-op outside a voice
 * channel rather than firing signalling messages into a session that doesn't
 * exist (`lib/prefs/keybinds.ts` holds the table of rebindable actions; Meta never
 * stands in for Ctrl on those). Mute and deafen work
 * anywhere, like the user panel's buttons: outside a call they only change the
 * saved state the next join starts with.
 *
 * While a call is ringing, Ctrl+Enter accepts it (audio only) and Escape
 * declines it, ahead of the mark-read use of Escape below. Both keep to the same
 * rules: no dialog open, not suspended, nobody else used the key.
 *
 * Ctrl+, (Cmd+, on macOS) opens Settings, including from the message box.
 * Ctrl+/ (Cmd+/) opens the read-only shortcuts overlay the same way; pressing
 * it again closes the overlay, which listens for that itself because every
 * shortcut here stands down while a dialog is open.
 *
 * Escape marks the open channel read (Shift+Escape the whole server) only when
 * nothing else used the key: a dialog or Settings open when it was pressed, or
 * any handler that called preventDefault() on it (closing a popup, cancelling
 * an edit), keeps the key for itself.
 */

import { Disposable } from "@lib/disposable";
import { isImeCommit } from "@lib/text/ime";
import { setOwnedTimeout } from "@lib/dom";
import { createLogger } from "@lib/logger";
import { voiceStore } from "@stores/voice.store";
import { dialogOpen, isDisplayed } from "@lib/ui/dialogOpen";
import {
  GLOBAL_DEAFEN_VK_PREF,
  GLOBAL_MUTE_VK_PREF,
  keyEventToVk,
  loadGlobalShortcutVks,
  type GlobalShortcutVks,
} from "@lib/voice/voiceShortcuts";
import {
  KEYBINDS_PREF,
  comboFromEvent,
  comboKey,
  loadEffectiveKeybinds,
  type ActionId,
  type EffectiveKeybinds,
  type KeyCombo,
} from "@lib/prefs/keybinds";
import { inputMode } from "@lib/ui/inputMode";
import { loadPref, onPrefChange } from "@lib/prefs/preferences";
import { canPublishScreen } from "../voice/native/platform";

const log = createLogger("global-keybinds");

export interface GlobalKeybindHandlers {
  /** The search binding (default Ctrl+F) — open the message search overlay. */
  readonly onSearch: () => void;
  /** The global mute binding (default Ctrl+Shift+M), or the Ctrl+M alias — toggle mute. */
  readonly onToggleMute: () => void;
  /** The global deafen binding (default Ctrl+Shift+D), or the Ctrl+D alias — toggle deafen. */
  readonly onToggleDeafen: () => void;
  /** The camera binding (default Ctrl+Shift+V) — toggle the camera (voice only). */
  readonly onToggleCamera: () => void;
  /** The screen-share binding (unbound by default) — toggle screen share (voice only). */
  readonly onToggleScreenshare?: () => void;
  /** The disconnect binding (unbound by default) — leave the voice channel (voice only). */
  readonly onDisconnect?: () => void;
  /** The upload binding (default Ctrl+Shift+U) — open the composer's attachment picker. */
  readonly onUploadFile: () => void;
  /** The emoji / GIF bindings (default Ctrl+E / Ctrl+G) — open or close the composer's picker. */
  readonly onTogglePicker: (kind: "emoji" | "gif") => void;
  /** Escape — mark the open channel read and return to its newest messages. */
  readonly onMarkChannelRead: () => void;
  /** Shift+Escape — mark every server channel read. */
  readonly onMarkServerRead: () => void;
  /** PageUp/PageDown from the message box — scroll the messages a page.
   *  `direction` is 1 for down, -1 for up. */
  readonly onScrollMessages: (direction: 1 | -1) => void;
  /** Alt+↑/↓ — step to the previous/next channel; with Shift, the previous/
   *  next unread one. `direction` is 1 for down/next, -1 for up. */
  readonly onStepChannel: (direction: 1 | -1, unreadOnly: boolean) => void;
  /** Whether an incoming-call ring is on screen. While it is, Ctrl+Enter
   *  accepts it and Escape declines it (3B-4); with none, neither key does
   *  anything new. Optional so a host with no calls attaches nothing. */
  readonly ringActive?: () => boolean;
  /** Ctrl+Enter while a ring is current — accept it, audio only. */
  readonly onAcceptRing?: () => void;
  /** Escape while a ring is current — decline it, ahead of mark-read. */
  readonly onDeclineRing?: () => void;
  /** Ctrl+, (Cmd+, on macOS) — open Settings. Not run while Settings is open
   *  (`isSuspended`) or a dialog is up. */
  readonly onOpenSettings: () => void;
  /** Ctrl+/ (Cmd+/ on macOS) — open the Keyboard Shortcuts overlay. Not run
   *  while Settings is open (`isSuspended`) or a dialog is up. */
  readonly onOpenShortcuts: () => void;
  /** Whether shortcuts should be ignored right now (e.g. settings overlay open). */
  readonly isSuspended?: () => boolean;
  /** The mute/deafen keys of the global shortcut, read on every press so a
   *  Settings rebind applies at once. Defaults to the persisted binding. */
  readonly voiceShortcutKeys?: () => GlobalShortcutVks;
  /** The effective binding of every action, read on every press. Defaults to a
   *  cached `loadEffectiveKeybinds()` that drops on a `keybinds` preference change. */
  readonly keybinds?: () => EffectiveKeybinds;
  /** True while the native poller delivers the voice shortcuts itself (it
   *  sees the keys focused or not), so the in-app handler must not toggle too. */
  readonly isGlobalPollerActive?: () => boolean;
}

/** True while the user is connected to a voice channel. */
function inVoice(): boolean {
  return voiceStore.getState().currentChannelId !== null;
}

type RebindableTable = () => ReadonlyMap<string, ActionId>;

/** Alt+↑/↓ steps channels; Alt+Shift+↑/↓ steps unread channels. */
function isAltArrow(e: KeyboardEvent): boolean {
  return e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "ArrowUp" || e.key === "ArrowDown");
}

/**
 * Step the channel on Alt+↑/↓. Checked before the rebindable lookup and the
 * Ctrl/Meta guard, which rejects any Alt combo. A plain Alt+Arrow is not a
 * text-editing shortcut, but AltGr arrives as ctrlKey+altKey and the
 * composer's own Alt use must win, so Ctrl/Meta or a text field disqualifies
 * the step rather than swallowing the key. The message composer is the
 * exception: like Discord, the step works while typing there (an IME
 * composition still keeps the key).
 */
function stepChannelKey(
  e: KeyboardEvent,
  handlers: GlobalKeybindHandlers,
  signal: AbortSignal,
): void {
  // A mention or emoji popup in the composer claims the arrows first.
  if (dialogOpen() || e.isComposing || e.defaultPrevented) return;
  const fromComposer = isComposer(e.target);
  if (isTypingTarget(e.target) && !fromComposer) return;
  const direction = e.key === "ArrowDown" ? 1 : -1;
  runGlobal(e, "step-channel", () => handlers.onStepChannel(direction, e.shiftKey));
  // The switch rebuilds the composer once the store notifies (a microtask
  // later); keep typing in the new one unless focus has moved on since.
  if (fromComposer) setOwnedTimeout(signal, focusNewComposer, 0);
}

/** Ctrl/Cmd+Shift+key: mute and deafen on the global shortcut's own binding, so
 *  the focused and unfocused keys can never disagree. Other Shift combos fall
 *  through (the rebindable table already ran). */
function handleCtrlShiftKey(e: KeyboardEvent, handlers: GlobalKeybindHandlers): void {
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
  if (action === "mute") runGlobal(e, "toggle-mute", handlers.onToggleMute);
  else runGlobal(e, "toggle-deafen", handlers.onToggleDeafen);
}

/** Toggle on the press edge only: a held key must not flip it back. A text
 *  field keeps its own Ctrl+D (forward-delete on macOS). */
function toggleAlias(e: KeyboardEvent, label: string, action: () => void): void {
  if (isTypingTarget(e.target)) return;
  if (e.repeat) e.preventDefault();
  else runGlobal(e, label, action);
}

/** Ctrl/Cmd+key with no Shift or Alt. */
function handleCtrlKey(e: KeyboardEvent, handlers: GlobalKeybindHandlers): void {
  // `e.key` is layout-dependent and uppercases with Shift held — compare
  // case-insensitively so Ctrl+Shift+V arrives as "V", not a missed "v".
  switch (e.key.toLowerCase()) {
    // Ctrl+, opens Settings from anywhere, the message box included: the key
    // has no text-editing meaning, like Ctrl+F. Settings itself is covered by
    // `isSuspended`, a dialog by the guard in the caller.
    case ",":
      if (!e.repeat) runGlobal(e, "open-settings", handlers.onOpenSettings);
      break;
    case "/":
      if (!e.repeat) runGlobal(e, "open-shortcuts", handlers.onOpenShortcuts);
      break;
    // Ctrl+M / Ctrl+D: hidden aliases from before the Ctrl+Shift keys.
    // remove after beta.5
    case "m":
      toggleAlias(e, "toggle-mute", handlers.onToggleMute);
      break;
    case "d":
      toggleAlias(e, "toggle-deafen", handlers.onToggleDeafen);
      break;
    default:
      break;
  }
}

/** Mute and deafen win a shared Ctrl+Shift key and keep their poller
 *  stand-down in the Ctrl+Shift path. */
function yieldsToVoiceShortcut(
  e: KeyboardEvent,
  combo: KeyCombo,
  handlers: GlobalKeybindHandlers,
): boolean {
  if (!combo.ctrl || !combo.shift || combo.alt) return false;
  const keys = (handlers.voiceShortcutKeys ?? loadGlobalShortcutVks)();
  const vk = keyEventToVk(e);
  return vk !== null && (vk === keys.mute || vk === keys.deafen);
}

function isVoiceOnlyAction(id: ActionId): boolean {
  return id === "toggleCamera" || id === "toggleScreenshare" || id === "disconnect";
}

/** Whether the key belongs to the focused control instead of the action. The
 *  pickers fire from the message box or an open picker, not from another text
 *  field. These act on the channel's own composer; from the thread panel's
 *  composer the key is left alone rather than opening the parent's picker or
 *  file chooser. */
function keyBelongsToFocus(id: ActionId, target: EventTarget | null): boolean {
  const picker = id === "emojiPicker" || id === "gifPicker";
  if (picker && isTypingTarget(target) && !isComposer(target) && !inPicker(target)) return true;
  return (picker || id === "uploadFile") && inThreadPanel(target);
}

type RebindableRunner = (e: KeyboardEvent, handlers: GlobalKeybindHandlers) => void;

const REBINDABLE_RUNNERS: Partial<Record<ActionId, RebindableRunner>> = {
  toggleCamera: (e, h) => runGlobal(e, "toggle-camera", h.onToggleCamera),
  toggleScreenshare: (e, h) => {
    if (!canPublishScreen()) return;
    runGlobal(e, "toggle-screenshare", () => h.onToggleScreenshare?.());
  },
  disconnect: (e, h) => runGlobal(e, "disconnect", () => h.onDisconnect?.()),
  search: (e, h) => runGlobal(e, "search", h.onSearch),
  uploadFile: (e, h) => runGlobal(e, "upload-file", h.onUploadFile),
  emojiPicker: (e, h) => runGlobal(e, "toggle-picker", () => h.onTogglePicker("emoji")),
  gifPicker: (e, h) => runGlobal(e, "toggle-picker", () => h.onTogglePicker("gif")),
};

/** Run the rebindable action bound to this keydown. True when the key was
 *  consumed (acted on, or deliberately ignored); false to carry on. */
function dispatchRebindable(
  e: KeyboardEvent,
  handlers: GlobalKeybindHandlers,
  table: RebindableTable,
): boolean {
  if (e.isComposing || dialogOpen()) return false;
  const combo = comboFromEvent(e, "inApp");
  if (combo === null) return false;
  const id = table().get(comboKey(combo));
  if (id === undefined) return false;
  if (yieldsToVoiceShortcut(e, combo, handlers)) return false;
  // Voice-only actions do nothing outside a call, and leave the key alone
  // (Ctrl+Shift+V still pastes plain text there).
  if (isVoiceOnlyAction(id) && !inVoice()) return true;
  if (keyBelongsToFocus(id, e.target)) return false;
  // Toggle on the press edge only, not on auto-repeat.
  if (e.repeat) {
    e.preventDefault();
    return true;
  }
  const run = REBINDABLE_RUNNERS[id];
  if (run === undefined) return false;
  run(e, handlers);
  return true;
}

/** PageUp/PageDown from the message box scroll the messages. */
function scrollOnPageKey(e: KeyboardEvent, handlers: GlobalKeybindHandlers): void {
  // A focused scroller pages itself; only these two would page nothing.
  if (!isComposer(e.target) && e.target !== document.body) return;
  if (inThreadPanel(e.target) || dialogOpen()) return;
  const direction = e.key === "PageDown" ? 1 : -1;
  runGlobal(e, "scroll-messages", () => handlers.onScrollMessages(direction));
}

/** A printable key with nothing focused starts typing in the message box. */
function focusComposerOnType(e: KeyboardEvent): void {
  // Space stays with the page (scrolling, pressing a focused control).
  if (e.key.length !== 1 || e.key === " " || e.repeat || !isIdleTarget(e.target)) return;
  // The push-to-talk key is polled natively and still reaches the page;
  // held during a call it must not type into the message box.
  if (isPttKey(e) || dialogOpen()) return;
  // Focus moves before the key's default runs, so the character lands in
  // the message box: no preventDefault here.
  findComposer()?.focus();
}

function handlePlainKey(e: KeyboardEvent, handlers: GlobalKeybindHandlers): void {
  if (e.isComposing || e.defaultPrevented) return;
  if (e.key === "PageUp" || e.key === "PageDown") scrollOnPageKey(e, handlers);
  else focusComposerOnType(e);
}

/** The keydown handler on `document`, one step per kind of key. */
function onKeydown(
  e: KeyboardEvent,
  handlers: GlobalKeybindHandlers,
  table: RebindableTable,
  signal: AbortSignal,
): void {
  if (handlers.isSuspended?.() === true) return;

  // AltGr arrives as Ctrl+Alt on Windows; a character typed with it (@ on
  // AZERTY) is plain typing, not a shortcut.
  const altGrChar = e.key.length === 1 && e.getModifierState("AltGraph");

  if (isAltArrow(e)) {
    stepChannelKey(e, handlers, signal);
    return;
  }

  // Rebindable actions: ahead of handlePlainKey (bare F-key bindings arrive
  // there) and of the Ctrl/Meta guard (Alt+key bindings).
  if (!altGrChar && dispatchRebindable(e, handlers, table)) return;

  if ((!e.ctrlKey && !e.metaKey && !e.altKey) || altGrChar) {
    handlePlainKey(e, handlers);
    return;
  }

  handleCtrlChord(e, handlers);
}

/** Ctrl/Cmd chords without Alt. */
function handleCtrlChord(e: KeyboardEvent, handlers: GlobalKeybindHandlers): void {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  // A modal owns the keyboard while it is up.
  if (dialogOpen()) return;
  if (e.shiftKey) handleCtrlShiftKey(e, handlers);
  else handleCtrlKey(e, handlers);
}

/** Whether Escape may mark read or decline a ring: nothing else used the key
 *  and focus is not in another field or the thread panel. */
function escapeIsFree(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.repeat) return false;
  if (isTypingTarget(e.target) && !isComposer(e.target)) return false;
  // Escape in the thread panel's composer must not mark the parent read.
  return !inThreadPanel(e.target);
}

function runEscape(e: KeyboardEvent, handlers: GlobalKeybindHandlers): void {
  // A ringing call outranks mark-read: the key declines it, and the
  // preventDefault inside runGlobal keeps anything else from reusing it.
  if (!e.shiftKey && handlers.ringActive?.() === true) {
    runGlobal(e, "decline-ring", () => handlers.onDeclineRing?.());
  } else if (e.shiftKey) {
    runGlobal(e, "mark-server-read", handlers.onMarkServerRead);
  } else {
    runGlobal(e, "mark-channel-read", handlers.onMarkChannelRead);
  }
}

/**
 * Register the shortcuts on `document`. Returns a detach function.
 */
export function attachGlobalKeybinds(handlers: GlobalKeybindHandlers): () => void {
  // The table the rebindable lookup reads: combo -> action, mute and deafen
  // left out (they stay on the global binding's own path). Injected
  // bindings are rebuilt on every press; the persisted ones are cached and
  // dropped when a preference they derive from changes.
  let cachedTable: ReadonlyMap<string, ActionId> | null = null;
  const currentTable: RebindableTable = () => {
    if (handlers.keybinds !== undefined) return buildTable(handlers.keybinds());
    cachedTable ??= buildTable(loadEffectiveKeybinds());
    return cachedTable;
  };
  // The effective set also derives from the mute/deafen keys and push to talk.
  const onKeybindPrefChange = (): void => {
    cachedTable = null;
  };

  const owner = new Disposable();
  const handler = (e: KeyboardEvent): void => onKeydown(e, handlers, currentTable, owner.signal);

  // Escape is decided after every other listener: the window's bubble phase
  // runs last. What was open is read in its capture phase, before the key
  // closes it.
  let escapeTaken = false;
  const onEscapeCapture = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || isImeCommit(e)) return;
    escapeTaken = handlers.isSuspended?.() === true || dialogOpen();
  };
  // Ctrl+Enter answers a ringing call. It is taken in the capture phase,
  // before the message box would send its draft on the same key; with no
  // ring the key reaches the message box untouched.
  const onAcceptRingCapture = (e: KeyboardEvent): void => {
    if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    if (e.repeat || isImeCommit(e) || handlers.isSuspended?.() === true || dialogOpen()) return;
    if (handlers.ringActive?.() !== true) return;
    e.stopPropagation();
    runGlobal(e, "accept-ring", () => handlers.onAcceptRing?.());
  };
  const onEscape = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || isImeCommit(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (escapeTaken || !escapeIsFree(e)) return;
    runEscape(e, handlers);
  };

  document.addEventListener("keydown", handler, { signal: owner.signal });
  window.addEventListener("keydown", onEscapeCapture, { capture: true, signal: owner.signal });
  window.addEventListener("keydown", onAcceptRingCapture, { capture: true, signal: owner.signal });
  window.addEventListener("keydown", onEscape, { signal: owner.signal });
  onPrefChange(
    [KEYBINDS_PREF, GLOBAL_MUTE_VK_PREF, GLOBAL_DEAFEN_VK_PREF, "pttVk"],
    onKeybindPrefChange,
    owner.signal,
  );
  return () => owner.destroy();
}

/** combo -> action for the rebindable lookup; mute and deafen are left out (they
 *  stay on the global binding's own path). */
function buildTable(eff: EffectiveKeybinds): ReadonlyMap<string, ActionId> {
  const table = new Map<string, ActionId>();
  for (const id of Object.keys(eff) as ActionId[]) {
    const combo = eff[id];
    if (combo === null || id === "toggleMute" || id === "toggleDeafen") continue;
    table.set(comboKey(combo), id);
  }
  return table;
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
/** Whether the key was pressed inside the thread side panel. */
function inThreadPanel(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".thread-panel") !== null;
}

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
