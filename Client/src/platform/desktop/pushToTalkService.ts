/**
 * Push-to-Talk service — uses Rust-side GetAsyncKeyState polling so the
 * PTT key is NOT consumed/hijacked. Other apps and chat input continue
 * to receive the key normally. Works even when OwnCord is unfocused.
 *
 * Lifted from `lib/ptt.ts` (B7-5): the `PushToTalk` suite binds `init()` to
 * the persisted key and `stop()`/`updateKey()` to the binding's polling
 * state, so the binding/generation bookkeeping moves with the native calls.
 * `vkName` is a pure display helper and stays in `lib/ptt.ts`. The native
 * modules stay dynamic `import()`s.
 *
 * A press or release only opens or closes the push-to-talk gate inside the
 * microphone processor (livekitSession.setPttGated): the microphone stays
 * published and the capture device stays open across presses, so no press
 * ever puts a raw track on the sender, and a user's own mute is never PTT's
 * to lift (v006) — a press while muted opens a gate on a stopped capture.
 *
 * Only `./pushToTalk.ts` imports this module, and lazily — see its header.
 */

import { loadPref, savePref } from "@lib/preferences";
import { voiceStore, setPttPollingLive, isPttPollingLive } from "@stores/voice.store";
import { createLogger } from "@lib/logger";
import { vkName, pttReleaseDelayMs } from "@lib/ptt";
import type { PushToTalk } from "../contracts/pushToTalk";

const log = createLogger("ptt");

interface PttBinding {
  generation: number;
  ready: boolean;
  initialEdge: number;
  unlisteners: (() => void)[];
}

let generation = 0;
let binding: PttBinding | null = null;
let nativeStarted = false;
let nativeStop: Promise<void> | null = null;
let edge = 0;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;

function isCurrent(attempt: PttBinding, version = attempt.generation): boolean {
  return binding === attempt && generation === version;
}

function releaseListeners(attempt: PttBinding | null): void {
  for (const unlisten of attempt?.unlisteners.splice(0) ?? []) unlisten();
}

function retainListener(attempt: PttBinding, unlisten: () => void): boolean {
  if (!isCurrent(attempt)) {
    unlisten();
    return false;
  }
  attempt.unlisteners.push(unlisten);
  return true;
}

/** Open the gate when the poller can no longer produce a future press/release
 *  edge — clearing the key binding (stopPtt) or the polling thread dying
 *  (ptt-error) — so a closed gate is never stranded with no way to open it. */
function ungateMic(): void {
  if (voiceStore.getState().pttGated !== true) return;
  const version = generation;
  const { currentChannelId, joinedAt } = voiceStore.getState();
  void import("@lib/livekitSession")
    .then(({ setPttGated }) => {
      const state = voiceStore.getState();
      if (
        generation !== version ||
        state.currentChannelId !== currentChannelId ||
        state.joinedAt !== joinedAt
      )
        return;
      setPttGated(false);
    })
    .catch((e) => log.warn("Failed to open the mic gate after clearing PTT", e));
}

/** Start listening for PTT state changes from the Rust backend. */
async function initPtt(): Promise<void> {
  const vk = loadPref<number>("pttVk", 0);
  if (vk === 0) return;
  await startBinding(vk, false);
}

async function startBinding(vk: number, gateMidCall: boolean): Promise<void> {
  releaseListeners(binding);
  const initialState = voiceStore.getState();
  const attempt: PttBinding = {
    generation: ++generation,
    ready: false,
    initialEdge: edge,
    unlisteners: [],
  };
  binding = attempt;
  setPttPollingLive(false);

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const { listen } = await import("@tauri-apps/api/event");
    if (!isCurrent(attempt)) return;
    // A new start must not be stopped by the preceding binding's pending
    // stop. Clear itself never waits for an unfinished start or readiness call.
    if (nativeStop !== null) await nativeStop;
    if (!isCurrent(attempt)) return;

    await invoke("ptt_set_key", { vkCode: vk });
    if (!isCurrent(attempt)) return;

    // ptt_start spawns its thread unconditionally, so a running thread is NOT
    // evidence that PTT works — on macOS is_key_down is a stub and on
    // pure-Wayland Linux there is no reachable display. Ask the backend what
    // it can actually observe, so livekitSession only applies its join-time
    // PTT mute where a press can genuinely lift it again.
    const supported = await invoke<boolean>("ptt_polling_supported");
    if (!isCurrent(attempt)) return;
    if (!supported) {
      log.warn("PTT key polling unsupported on this platform — mic will not be gated at join");
    }

    // Surface a backend polling-thread panic: no further ptt-state events can
    // ever arrive afterward, so a gate the last release closed would
    // otherwise be stranded with no way to open it.
    const errorUnlisten = await listen<string>("ptt-error", (event) => {
      if (!isCurrent(attempt)) return;
      log.warn("PTT polling thread stopped unexpectedly", { error: event.payload });
      ++generation;
      binding = null;
      nativeStarted = false;
      releaseListeners(attempt);
      setPttPollingLive(false);
      ungateMic();
    });
    if (!retainListener(attempt, errorUnlisten)) return;

    // Listen for press/release events
    const unsub = await listen<boolean>("ptt-state", (event) => {
      if (!isCurrent(attempt) || !supported) return;
      // Only toggle mute when in a voice channel
      const { currentChannelId: channelId, joinedAt } = voiceStore.getState();
      if (channelId === null) return;
      const version = attempt.generation;
      const currentEdge = ++edge;

      const pressed = event.payload;
      // A newer edge supersedes a release still waiting out its delay; the
      // edge guard below already drops it, this just frees the timer.
      clearTimeout(releaseTimer);
      // livekitSession (and the ~1.3 MB livekit-client SDK behind it) is
      // loaded lazily so it stays out of the startup path. In a voice channel
      // the module is necessarily already loaded, so this import resolves
      // from the module cache in a microtask.
      void import("@lib/livekitSession")
        .then(({ setPttGated }) => {
          const apply = (): void => {
            const state = voiceStore.getState();
            if (
              !isCurrent(attempt, version) ||
              currentEdge !== edge ||
              state.currentChannelId !== channelId ||
              state.joinedAt !== joinedAt
            )
              return;
            setPttGated(!pressed);
            log.debug(pressed ? "PTT pressed — gate open" : "PTT released — gate closed");
          };
          // A release keeps transmitting for the saved delay (DP-30), so the
          // tail of a word is not cut; a press opens at once.
          const delay = pressed ? 0 : pttReleaseDelayMs();
          if (delay > 0) releaseTimer = setTimeout(apply, delay);
          else apply();
        })
        .catch((e) => log.warn("Failed to apply PTT gate", e));
    });
    if (!retainListener(attempt, unsub)) return;

    // Subscribe before starting: the poller may report a press or fail as
    // soon as its thread starts, before the IPC response reaches us.
    nativeStarted = true;
    await invoke("ptt_start");
    if (!isCurrent(attempt)) return;
    attempt.ready = true;
    setPttPollingLive(supported);
    const state = voiceStore.getState();
    // Startup may still be checking native readiness when auto-join opens
    // a call. Reconcile that call once idle-key polling becomes available.
    const joinedDuringStart =
      state.currentChannelId !== initialState.currentChannelId ||
      state.joinedAt !== initialState.joinedAt;
    if ((gateMidCall || joinedDuringStart) && supported) await gateBoundMic(attempt);
    log.info("PTT started", { vk, name: vkName(vk) });
  } catch (err) {
    // Not in Tauri environment (dev mode), or the backend rejected a command.
    // Either way no ptt-state event can arrive, so the poller is not live —
    // leaving a stale `true` here would let a later join mute the mic for good.
    if (isCurrent(attempt)) await stopPtt();
    log.debug("PTT not available", { error: err });
  }
}

/** Stop PTT polling. */
async function stopPtt(): Promise<void> {
  await stopBinding(false);
}

async function stopBinding(clearKey: boolean): Promise<void> {
  const previous = binding;
  const shouldStopNative = nativeStarted;
  // Invalidate before any await, including while init is still registering
  // listeners. Late listeners clean up their own handles via retainListener.
  const version = ++generation;
  binding = null;
  nativeStarted = false;
  releaseListeners(previous);
  setPttPollingLive(false);
  ungateMic();
  if (!clearKey && !shouldStopNative) return;

  const precedingStop = nativeStop;
  const stopping = Promise.resolve().then(async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    if (clearKey && generation === version) await invoke("ptt_set_key", { vkCode: 0 });
    if (shouldStopNative) await invoke("ptt_stop");
  });
  // A repeated Clear must not hide an earlier stop that is still joining
  // its thread. Starts wait for all outstanding stops; this caller only
  // awaits its own command and never the old init/readiness promise.
  const allStops = Promise.allSettled([precedingStop, stopping]).then(() => {});
  nativeStop = allStops;
  void allStops.then(() => {
    if (nativeStop === allStops) nativeStop = null;
  });
  try {
    await stopping;
    log.info("PTT stopped");
  } catch (err) {
    log.debug("PTT stop command failed (state already cleaned up)", err);
  }
}

/** Update the PTT key and restart polling. */
async function updatePttKey(vk: number): Promise<void> {
  savePref("pttVk", vk);
  if (vk === 0) {
    await stopBinding(true);
    return;
  }
  const attempt = binding;
  if (!attempt?.ready) {
    await startBinding(vk, true);
    return;
  }
  // Rebinding an established poller preserves its event listeners, but
  // supersedes pending key changes and delayed mic callbacks.
  const version = ++generation;
  attempt.generation = version;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    if (!isCurrent(attempt, version)) return;
    await invoke("ptt_set_key", { vkCode: vk });
    if (!isCurrent(attempt, version)) return;
    log.info("PTT key updated", { vk, name: vk !== 0 ? vkName(vk) : "disabled" });
  } catch {
    if (isCurrent(attempt, version)) await stopPtt();
  }
}

/** An idle newly-bound key emits no edge, so close the gate mid-call too. */
async function gateBoundMic(attempt: PttBinding): Promise<void> {
  const { currentChannelId, joinedAt, pttGated } = voiceStore.getState();
  if (
    currentChannelId === null ||
    !isPttPollingLive() ||
    pttGated === true ||
    edge !== attempt.initialEdge
  )
    return;
  const version = attempt.generation;
  const currentEdge = edge;
  try {
    const { setPttGated } = await import("@lib/livekitSession");
    const state = voiceStore.getState();
    if (
      !isCurrent(attempt, version) ||
      edge !== currentEdge ||
      state.currentChannelId !== currentChannelId ||
      state.joinedAt !== joinedAt
    )
      return;
    setPttGated(true);
  } catch (e) {
    log.warn("Failed to gate mic after binding PTT key mid-call", e);
  }
}

/** Use Rust-side polling to capture the next key press (for the binding UI). */
async function captureKeyPress(): Promise<number> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<number>("ptt_listen_for_key");
}

/** Whether the host can observe global key state (false on macOS / pure
 *  Wayland, where PTT never gates). A missing bridge (dev/test) is false. */
async function pttSupported(): Promise<boolean> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<boolean>("ptt_polling_supported");
  } catch {
    return false;
  }
}

export const pushToTalk: PushToTalk = {
  init: initPtt,
  stop: stopPtt,
  updateKey: updatePttKey,
  captureKeyPress,
  supported: pttSupported,
};
