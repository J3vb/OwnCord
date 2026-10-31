/**
 * The on-screen talk button: Push to Talk in the Android app, where there is no
 * key to hold. Holding the button opens the push-to-talk gate and letting go
 * closes it again, through the same `setPttGated` a held key uses, so the
 * microphone stays published and the user's own mute is never this button's
 * to lift.
 *
 * Starting it marks the button as the app's Push to Talk trigger
 * (`setTalkButton`) and, while the saved input mode is Push to Talk, reports a
 * live press source (`setPttPollingLive`), so a call joined in that mode starts
 * with the gate closed and the sensitivity gate steps aside. Letting go, a
 * cancelled touch, and the app going to the background all close the gate.
 */

import { createElement } from "../../lib/dom";
import { createIcon } from "../../lib/icons";
import { createLogger } from "../../lib/logger";
import { inputMode, setTalkButton } from "../../lib/ui/inputMode";
import { pttReleaseDelayMs } from "../../lib/voice/ptt";
import {
  voiceStore,
  setPttPollingLive,
  onPttPollingLiveChange,
  type VoiceState,
} from "../../stores/voice.store";
import { voiceText } from "../../i18n/voice";

const log = createLogger("talk-button");

export type TalkVariant = "call" | "bar" | "user";

let started = false;
let held = false;
/** Bumped by every press, release and mode change, so a late gate write from
 *  an older one is dropped. */
let edge = 0;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;
/** The touch holding the button, so lifting that finger anywhere lets go even
 *  when the button moved or was redrawn under it. */
let holdPointer: number | null = null;
const heldListeners = new Set<() => void>();

function talkMode(): boolean {
  return started && inputMode() === "ptt";
}

function setHeld(next: boolean): void {
  if (!next) holdPointer = null;
  if (held === next) return;
  held = next;
  for (const listener of heldListeners) listener();
}

/** Close (`gated`) or open the gate for the call in progress, after `delay`
 *  ms. Dropped when a newer edge came first or the call changed meanwhile. */
function writeGate(gated: boolean, delay: number, stillWanted: () => boolean): void {
  const { currentChannelId, joinedAt } = voiceStore.getState();
  if (currentChannelId === null) return;
  const at = ++edge;
  clearTimeout(releaseTimer);
  releaseTimer = undefined;
  // In a call the session module is already loaded, so this resolves from the
  // module cache; importing it lazily keeps the voice SDK out of this module.
  void import("../../lib/voice/livekitSession")
    .then(({ setPttGated }) => {
      const apply = (): void => {
        const state = voiceStore.getState();
        if (
          at !== edge ||
          state.currentChannelId !== currentChannelId ||
          state.joinedAt !== joinedAt ||
          !stillWanted()
        )
          return;
        setPttGated(gated);
      };
      if (delay > 0) releaseTimer = setTimeout(apply, delay);
      else apply();
    })
    .catch((e: unknown) => log.warn("Failed to apply the talk button's gate", e));
}

/** Hold to talk: opens the gate at once. */
export function pressTalk(): void {
  if (!talkMode() || voiceStore.getState().currentChannelId === null) return;
  setHeld(true);
  writeGate(false, 0, talkMode);
}

/** Let go: closes the gate after the saved release delay, so the tail of a
 *  word is not cut. */
export function releaseTalk(): void {
  if (!held) return;
  setHeld(false);
  writeGate(true, pttReleaseDelayMs(), talkMode);
}

/** Follow the saved input mode: Push to Talk reports the button as a live press
 *  source and closes the gate of a call already in progress; Voice Activity
 *  takes the source away and opens a gate it left closed. */
export function syncTalkSource(): void {
  if (!started) return;
  const ptt = inputMode() === "ptt";
  if (!ptt) setHeld(false);
  setPttPollingLive(ptt);
  const state = voiceStore.getState();
  if (state.currentChannelId === null) return;
  if (ptt && state.pttGated !== true && !held) writeGate(true, 0, talkMode);
  else if (!ptt && state.pttGated === true) writeGate(false, 0, () => inputMode() !== "ptt");
}

/** Make the talk button the Push to Talk trigger, for the app's lifetime. */
export function startTalkButton(signal: AbortSignal): void {
  if (started) return;
  started = true;
  setTalkButton(true);
  syncTalkSource();
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "hidden") releaseTalk();
    },
    { signal },
  );
  window.addEventListener("blur", releaseTalk, { signal });
  const letGo = (e: PointerEvent): void => {
    if (e.pointerId === holdPointer) releaseTalk();
  };
  document.addEventListener("pointerup", letGo, { capture: true, signal });
  document.addEventListener("pointercancel", letGo, { capture: true, signal });
}

/** Whether the button can open the mic: in a call, in Push to Talk mode, and
 *  not muted, deafened, listen-only, muted by a moderator or in the AFK
 *  channel (where the gate opening would send nothing). */
function talkState(state: VoiceState): { shown: boolean; disabled: boolean } {
  const shown = talkMode() && state.currentChannelId !== null;
  const disabled =
    state.localMuted ||
    state.localDeafened ||
    state.listenOnly ||
    state.localServerMuted === true ||
    state.inAfkChannel === true;
  return { shown, disabled };
}

/** The hold-to-talk button: `call` is the large one in the call view, `bar` the
 *  round one in the phone call bar and the DM call, `user` the small one beside
 *  Mute in the user bar. It hides itself outside Push to Talk. */
export function createTalkButton(variant: TalkVariant, signal: AbortSignal): HTMLButtonElement {
  const label = voiceText("talk.hold");
  const btn = createElement("button", {
    type: "button",
    class: `talk-btn talk-btn--${variant}`,
    "aria-label": label,
    "aria-pressed": "false",
    "data-testid": `talk-button-${variant}`,
  });
  btn.appendChild(createIcon("mic", variant === "call" ? 28 : 20));
  if (variant === "call") {
    btn.appendChild(createElement("span", { class: "talk-btn__label" }, label));
  }

  const paint = (): void => {
    const state = voiceStore.getState();
    const { shown, disabled } = talkState(state);
    btn.hidden = !shown;
    btn.disabled = disabled;
    const talking = shown && held && state.pttGated !== true;
    btn.classList.toggle("talking", talking);
    btn.setAttribute("aria-pressed", String(held && shown));
    // A control that stops showing must not leave the gate open.
    if ((!shown || disabled) && held) releaseTalk();
  };

  const press = (): void => {
    if (btn.disabled || btn.hidden) return;
    pressTalk();
  };
  btn.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.preventDefault();
      try {
        btn.setPointerCapture(e.pointerId);
      } catch {
        // No capture (the pointer is already gone): pointerup still arrives.
      }
      press();
      if (held) holdPointer = e.pointerId;
    },
    { signal },
  );
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
    btn.addEventListener(type, releaseTalk, { signal });
  }
  // Android's long-press menu would steal the touch mid-sentence.
  btn.addEventListener("contextmenu", (e) => e.preventDefault(), { signal });
  btn.addEventListener(
    "keydown",
    (e) => {
      if ((e.key !== " " && e.key !== "Enter") || e.repeat) return;
      e.preventDefault();
      press();
    },
    { signal },
  );
  btn.addEventListener(
    "keyup",
    (e) => {
      if (e.key !== " " && e.key !== "Enter") return;
      e.preventDefault();
      releaseTalk();
    },
    { signal },
  );
  btn.addEventListener("blur", releaseTalk, { signal });

  const unsubs = [
    voiceStore.subscribeSelector(
      (s) =>
        [
          s.currentChannelId,
          s.pttGated === true,
          s.localMuted,
          s.localDeafened,
          s.listenOnly,
          s.localServerMuted === true,
          s.inAfkChannel === true,
        ].join("|"),
      paint,
    ),
    onPttPollingLiveChange(paint),
  ];
  heldListeners.add(paint);
  signal.addEventListener(
    "abort",
    () => {
      for (const unsub of unsubs) unsub();
      heldListeners.delete(paint);
      if (held) releaseTalk();
    },
    { once: true },
  );
  paint();
  return btn;
}

/** Test-only: forget the module state between tests. */
export function resetTalkButtonForTest(): void {
  clearTimeout(releaseTimer);
  releaseTimer = undefined;
  started = false;
  held = false;
  edge = 0;
  holdPointer = null;
  heldListeners.clear();
  setTalkButton(false);
}
