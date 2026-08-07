/**
 * Push-to-Talk service — uses Rust-side GetAsyncKeyState polling so the
 * PTT key is NOT consumed/hijacked. Other apps and chat input continue
 * to receive the key normally. Works even when OwnCord is unfocused.
 */

import { loadPref, savePref } from "@components/settings/helpers";
import { voiceStore, setPttGated, setPttPollingLive } from "@stores/voice.store";
import { createLogger } from "./logger";

const log = createLogger("ptt");

let listening = false;
let pttUnsubscribe: (() => void) | null = null;

/** True when the mute currently in effect is the one a PTT release applied,
 *  rather than one the user asked for. livekitSession.setMuted() writes
 *  localMuted for every caller, so that flag alone cannot tell "the user
 *  muted themselves" (which a press must never lift — v006) from "the last
 *  release muted the mic" (which it must). Reset on init/stop so a mute that
 *  outlived the previous PTT binding is treated as the user's. */
let pttOwnsMute = false;

// Well-known virtual key code names for display
const VK_NAMES: ReadonlyMap<number, string> = new Map([
  [0x01, "Mouse Left"],
  [0x02, "Mouse Right"],
  [0x04, "Mouse Middle"],
  [0x05, "Mouse 4"],
  [0x06, "Mouse 5"],
  [0x08, "Backspace"],
  [0x09, "Tab"],
  [0x0d, "Enter"],
  [0x1b, "Escape"],
  [0x20, "Space"],
  [0x21, "Page Up"],
  [0x22, "Page Down"],
  [0x23, "End"],
  [0x24, "Home"],
  [0x25, "Arrow Left"],
  [0x26, "Arrow Up"],
  [0x27, "Arrow Right"],
  [0x28, "Arrow Down"],
  [0x2d, "Insert"],
  [0x2e, "Delete"],
  [0x70, "F1"],
  [0x71, "F2"],
  [0x72, "F3"],
  [0x73, "F4"],
  [0x74, "F5"],
  [0x75, "F6"],
  [0x76, "F7"],
  [0x77, "F8"],
  [0x78, "F9"],
  [0x79, "F10"],
  [0x7a, "F11"],
  [0x7b, "F12"],
  [0x7c, "F13"],
  [0x7d, "F14"],
  [0x7e, "F15"],
  [0x7f, "F16"],
  [0xc0, "`"],
  [0xbd, "-"],
  [0xbb, "="],
  [0xdb, "["],
  [0xdd, "]"],
  [0xdc, "\\"],
  [0xba, ";"],
  [0xde, "'"],
  [0xbc, ","],
  [0xbe, "."],
  [0xbf, "/"],
]);

/** Get a human-readable name for a virtual key code. */
export function vkName(vk: number): string {
  if (VK_NAMES.has(vk)) return VK_NAMES.get(vk)!;
  // 0-9 keys
  if (vk >= 0x30 && vk <= 0x39) return String.fromCharCode(vk);
  // A-Z keys
  if (vk >= 0x41 && vk <= 0x5a) return String.fromCharCode(vk);
  // Numpad 0-9
  if (vk >= 0x60 && vk <= 0x69) return `Numpad ${vk - 0x60}`;
  return `Key 0x${vk.toString(16).toUpperCase()}`;
}

/** Start listening for PTT state changes from the Rust backend. */
export async function initPtt(): Promise<void> {
  const vk = loadPref<number>("pttVk", 0);
  if (vk === 0) return;

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const { listen } = await import("@tauri-apps/api/event");

    // Set the key and start the polling loop
    await invoke("ptt_set_key", { vkCode: vk });
    await invoke("ptt_start");

    // ptt_start spawns its thread unconditionally, so a running thread is NOT
    // evidence that PTT works — on macOS is_key_down is a stub and on
    // pure-Wayland Linux there is no reachable display. Ask the backend what
    // it can actually observe, so livekitSession only applies its join-time
    // PTT mute where a press can genuinely lift it again.
    const supported = await invoke<boolean>("ptt_polling_supported");
    setPttPollingLive(supported);
    if (!supported) {
      log.warn("PTT key polling unsupported on this platform — mic will not be gated at join");
    }

    // Clean up previous listener if any
    pttUnsubscribe?.();
    pttUnsubscribe = null;
    // A mute left over from a previous binding is no longer PTT's to lift.
    pttOwnsMute = false;

    // Listen for press/release events
    const unsub = await listen<boolean>("ptt-state", (event) => {
      // Only toggle mute when in a voice channel
      const channelId = voiceStore.getState().currentChannelId;
      if (channelId === null) return;

      const pressed = event.payload;
      // Track the PTT gate in the store regardless of whether we end up
      // calling setMuted below — this is the source of truth other code
      // (e.g. the widget) can read without depending on localMuted.
      setPttGated(!pressed);

      // livekitSession (and the ~1.3 MB livekit-client SDK behind it) is
      // loaded lazily so it stays out of the startup path. In a voice channel
      // the module is necessarily already loaded, so this import resolves
      // from the module cache in a microtask.
      void import("./livekitSession")
        .then(({ setMuted }) => {
          const { localMuted, localDeafened } = voiceStore.getState();
          if (pressed) {
            // Never let PTT lift a mute the user asked for — that would
            // republish the mic to every peer while voice_states.muted (and
            // every remote UI) still shows the user muted (v006). The mute a
            // previous release applied is PTT's own, so lifting that is fine.
            if (localDeafened || (localMuted && !pttOwnsMute)) {
              log.debug("PTT pressed — staying muted (user is self-muted or deafened)");
              return;
            }
            setMuted(false);
            pttOwnsMute = false;
            log.debug("PTT pressed — unmuted");
            return;
          }
          // Muting is always safe. setMuted() writes localMuted, so record
          // whether this release is what muted the mic — only then may the
          // next press lift it.
          setMuted(true);
          pttOwnsMute = !localMuted;
          log.debug("PTT released — muted");
        })
        .catch((e) => log.warn("Failed to apply PTT mute", e));
    });
    pttUnsubscribe = unsub;

    listening = true;
    log.info("PTT started", { vk, name: vkName(vk) });
  } catch (err) {
    // Not in Tauri environment (dev mode), or the backend rejected a command.
    // Either way no ptt-state event can arrive, so the poller is not live —
    // leaving a stale `true` here would let a later join mute the mic for good.
    setPttPollingLive(false);
    log.debug("PTT not available", { error: err });
  }
}

/** Stop PTT polling. */
export async function stopPtt(): Promise<void> {
  if (!listening) return;
  try {
    pttUnsubscribe?.();
    pttUnsubscribe = null;
    pttOwnsMute = false;
    // No further ptt-state events once the loop is torn down; clear the flag
    // before the await so a concurrent join cannot observe a stale `true`.
    setPttPollingLive(false);
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("ptt_stop");
    listening = false;
    log.info("PTT stopped");
  } catch {
    // ignore
  }
}

/** Update the PTT key and restart polling. */
export async function updatePttKey(vk: number): Promise<void> {
  savePref("pttVk", vk);
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("ptt_set_key", { vkCode: vk });
    if (!listening && vk !== 0) {
      await initPtt();
    }
    if (vk === 0) {
      await stopPtt();
    }
    log.info("PTT key updated", { vk, name: vk !== 0 ? vkName(vk) : "disabled" });
  } catch {
    // ignore
  }
}

/** Use Rust-side polling to capture the next key press (for the binding UI). */
export async function captureKeyPress(): Promise<number> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<number>("ptt_listen_for_key");
}
