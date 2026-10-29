// Windows per-app share audio (`src-tauri/src/windows_app_audio.rs`).
// Every host call is wrapped here: a rejection (no Tauri host, a non-Windows
// build, a failed call) becomes a typed "unavailable" result, never a throw.
import { invoke } from "@tauri-apps/api/core";
import { createLogger } from "@lib/logger";
import type { AppAudio, AppAudioErrorCode, AppAudioStart } from "../contracts/appAudio";

const log = createLogger("appAudio");

const CODES: readonly AppAudioErrorCode[] = [
  "unavailable",
  "not_window",
  "own_window",
  "ancestor",
  "not_found",
  "ambiguous",
  "activation_failed",
  "superseded",
  "internal",
];

/** The host answers a refusal with its code as the error string. */
function codeOf(err: unknown): AppAudioErrorCode {
  return typeof err === "string" && (CODES as readonly string[]).includes(err)
    ? (err as AppAudioErrorCode)
    : "unavailable";
}

export async function appAudioAvailable(): Promise<boolean> {
  try {
    return (await invoke<boolean>("app_audio_available")) === true;
  } catch (err) {
    log.debug("app_audio_available failed", err);
    return false;
  }
}

export async function startAppAudio(label: string, surface: string): Promise<AppAudioStart> {
  try {
    const started = await invoke<{ url?: unknown }>("start_app_audio", { label, surface });
    return typeof started?.url === "string" && started.url !== ""
      ? { ok: true, url: started.url }
      : { ok: false, code: "internal" };
  } catch (err) {
    return { ok: false, code: codeOf(err) };
  }
}

export async function stopAppAudio(): Promise<void> {
  try {
    await invoke<void>("stop_app_audio");
  } catch (err) {
    log.debug("stop_app_audio failed", err);
  }
}

export const appAudio: AppAudio = {
  available: appAudioAvailable,
  start: startAppAudio,
  stop: stopAppAudio,
};
