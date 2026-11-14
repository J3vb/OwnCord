/**
 * The Share music control shared by the voice widget and the call view's bar:
 * whether this machine can share music (probed once, cached), the button's
 * state and the one action behind it, which stops a running share or asks
 * which app to share.
 */

import { voiceStore, type VoiceState } from "@stores/voice.store";
import { uiStore } from "@stores/ui.store";
import { createElement } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { startMusic, stopMusic } from "@lib/voice/livekitSession";
import { createLogger } from "@lib/logger";
import { desktop } from "../../platform/desktop";
import type { MusicSupport, MusicUnsupportedReason } from "../../platform/contracts/musicAudio";
import { voiceText } from "../../i18n/voice";
import { musicText } from "../../i18n/music";
import { showMusicPicker } from "./MusicPicker";

const log = createLogger("musicControl");

const REASON_KEYS = {
  browser: "reason.browser",
  android: "reason.android",
  platform: "reason.platform",
  windowsOld: "reason.windowsOld",
  noSoundServer: "reason.noSoundServer",
} as const satisfies Record<MusicUnsupportedReason, string>;

/** How long a failed or "no sound server" answer waits before the next probe. */
const RETRY_MS = 5000;

/** The probe's lasting answer, once it has one. A missing sound server may be
 *  started later and a failed probe may work next time, so those are not kept:
 *  `last` shows them while the probe goes again. */
let settled: MusicSupport | null = null;
let last: MusicSupport | null = null;
let probing: Promise<MusicSupport> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const watchers = new Set<() => void>();

function cancelRetry(): void {
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
}

/** Probe again after a pause while someone shows the button and the answer is
 *  not a lasting one. */
function scheduleRetry(): void {
  if (settled !== null || retryTimer !== null || watchers.size === 0) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void getMusicSupport();
  }, RETRY_MS);
}

function probe(): Promise<MusicSupport> {
  probing ??= desktop.musicAudio
    .support()
    .then((answer) => ({ answer, lasting: answer.ok || answer.reason !== "noSoundServer" }))
    .catch((err: unknown) => {
      log.debug("music support probe failed", err);
      return { answer: { ok: false, reason: "platform" } as MusicSupport, lasting: false };
    })
    .then(({ answer, lasting }) => {
      probing = null;
      last = answer;
      if (lasting) settled = answer;
      for (const watcher of watchers) watcher();
      scheduleRetry();
      return answer;
    });
  return probing;
}

/** Whether this machine can share music; one probe at a time, cached once
 *  it is a lasting answer. */
export function getMusicSupport(): Promise<MusicSupport> {
  return settled !== null ? Promise.resolve(settled) : probe();
}

/** The latest answer (lasting or not), or null before the first probe has
 *  settled. */
export function cachedMusicSupport(): MusicSupport | null {
  return settled ?? last;
}

/** Call `listener` whenever a probe settles, until `signal` aborts; starts the
 *  probe if none has run. A last answer that is not lasting is probed again
 *  every few seconds while anyone watches. */
export function watchMusicSupport(listener: () => void, signal: AbortSignal): void {
  if (signal.aborted) return;
  watchers.add(listener);
  signal.addEventListener(
    "abort",
    () => {
      watchers.delete(listener);
      if (watchers.size === 0) cancelRetry();
    },
    { once: true },
  );
  if (settled === null && probing === null) {
    if (last === null) void getMusicSupport();
    else scheduleRetry();
  }
}

/** Forget the cached probe (a test, or a retry after the host changed). */
export function resetMusicSupport(): void {
  settled = null;
  last = null;
  probing = null;
  cancelRetry();
}

export interface MusicButtonState {
  /** You are sharing: the button stops it. */
  readonly sharing: boolean;
  readonly disabled: boolean;
  /** The tooltip: what a press does, or why it does nothing. */
  readonly title: string;
}

/** The button's state. `support` is null while the probe runs; `lockReason`
 *  is why the call controls are inert now (socket down, still joining), or
 *  null. Never disabled while you share, so Stop music always works. */
export function musicButtonState(
  voice: VoiceState,
  support: MusicSupport | null,
  lockReason: string | null,
): MusicButtonState {
  const sharing = voice.localMusic === true;
  if (sharing) return { sharing, disabled: false, title: voiceText("music.stop") };
  if (support === null) {
    return { sharing, disabled: true, title: musicText("checking") };
  }
  if (!support.ok) {
    return { sharing, disabled: true, title: musicText(REASON_KEYS[support.reason]) };
  }
  if (lockReason !== null) return { sharing, disabled: true, title: lockReason };
  if (voice.shareDenied === true) {
    return { sharing, disabled: true, title: voiceText("widget.control.shareDenied") };
  }
  return { sharing, disabled: false, title: voiceText("music.share") };
}

/** The voice widget's Share music button, pressed through `toggleMusicShare`. */
export function createMusicButton(signal: AbortSignal): HTMLButtonElement {
  const btn = createElement("button", {
    class: "vw-music-btn",
    "aria-label": voiceText("music.share"),
    "data-testid": "vw-music-btn",
  });
  btn.appendChild(createIcon("music", 18));
  btn.addEventListener("click", () => void toggleMusicShare(), { signal });
  return btn;
}

/** Draw `btn` from the voice state: its label, pressed look and whether it can
 *  be pressed. The call is locked while the chat socket is down or the join
 *  has not reached the room. */
export function syncMusicButton(btn: HTMLButtonElement, voice: VoiceState): void {
  const status = uiStore.getState().connectionStatus;
  let lock: string | null = null;
  if (status !== "connected") {
    lock = voiceText(
      status === "reconnecting" ? "status.reconnectingShort" : "status.notConnected",
    );
  } else if (voice.voiceStatus === "joining" || voice.voiceStatus === "securing") {
    lock = voiceText("status.joining");
  }
  const state = musicButtonState(voice, cachedMusicSupport(), lock);
  btn.disabled = state.disabled;
  btn.title = state.title;
  btn.setAttribute("aria-label", voiceText(state.sharing ? "music.stop" : "music.share"));
  btn.setAttribute("aria-pressed", String(state.sharing));
  btn.classList.toggle("active-ctrl", state.sharing);
}

/** One press: stop a running share, else pick an app and share it. */
export async function toggleMusicShare(): Promise<void> {
  if (voiceStore.getState().localMusic === true) {
    stopMusic();
    return;
  }
  const app = await showMusicPicker();
  // The call may have ended or a share started while the dialog was open.
  const voice = voiceStore.getState();
  if (app === null || voice.currentChannelId === null || voice.localMusic === true) return;
  await startMusic(app.id);
}
