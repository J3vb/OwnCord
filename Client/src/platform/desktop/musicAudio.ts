// Music share host calls: the Windows capture commands and the Linux app list.
// Every call goes through `tryInvoke`, so a rejection (no Tauri host, an
// unsupported OS, a failed call) becomes a typed answer, never a throw.
import { isAndroidHost } from "@lib/hostPlatform";
import { createLogger } from "@lib/logger";
import type {
  AudioApp,
  MusicAppList,
  MusicAudio,
  MusicErrorCode,
  MusicStart,
  MusicSupport,
} from "../contracts/musicAudio";
import { tryInvoke } from "./nativeInvoke";

const log = createLogger("musicAudio");

const CODES: readonly MusicErrorCode[] = [
  "unavailable",
  "not_found",
  "activation_failed",
  "superseded",
  "internal",
];

type Host = "windows" | "linux" | "other";

function hostOs(): Host {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent;
  if (/\bWindows\b/.test(ua)) return "windows";
  if (/\bLinux\b/.test(ua) && !/Android/.test(ua)) return "linux";
  return "other";
}

/** The host answers a refusal with its code as the error string. */
function codeOf(reason: unknown): MusicErrorCode {
  return typeof reason === "string" && (CODES as readonly string[]).includes(reason)
    ? (reason as MusicErrorCode)
    : "unavailable";
}

function parseApps(raw: unknown): AudioApp[] | null {
  if (!Array.isArray(raw)) return null;
  const apps: AudioApp[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== "object" || item === null) return null;
    const { id, name, icon, playing } = item as Record<string, unknown>;
    if (typeof id !== "string" || typeof name !== "string") return null;
    apps.push({
      id,
      name,
      icon: typeof icon === "string" && icon !== "" ? icon : null,
      playing: playing === true,
    });
  }
  return apps;
}

async function listApps(): Promise<MusicAppList> {
  const os = hostOs();
  if (os === "other") return { ok: false, code: "unavailable" };
  const result =
    os === "windows"
      ? await tryInvoke<unknown>("list_audio_apps")
      : await tryInvoke<unknown>("native_voice_list_audio_apps");
  if (!result.ok) return { ok: false, code: codeOf(result.error.reason) };
  const apps = parseApps(result.value);
  return apps === null ? { ok: false, code: "internal" } : { ok: true, apps };
}

async function support(): Promise<MusicSupport> {
  if (isAndroidHost()) return { ok: false, reason: "android" };
  const os = hostOs();
  if (os === "other") return { ok: false, reason: "platform" };
  if (os === "windows") {
    const available = await tryInvoke<boolean>("app_audio_available");
    return available.ok && available.value === true
      ? { ok: true }
      : { ok: false, reason: "windowsOld" };
  }
  const listed = await listApps();
  return listed.ok ? { ok: true } : { ok: false, reason: "noSoundServer" };
}

async function start(appId: string): Promise<MusicStart> {
  if (hostOs() !== "windows") return { ok: false, code: "unavailable" };
  const result = await tryInvoke<unknown>("start_music_audio", { appId });
  if (!result.ok) return { ok: false, code: codeOf(result.error.reason) };
  return typeof result.value === "string" && result.value !== ""
    ? { ok: true, url: result.value }
    : { ok: false, code: "internal" };
}

async function stop(): Promise<void> {
  if (hostOs() !== "windows") return;
  const result = await tryInvoke<void>("stop_music_audio");
  if (!result.ok) log.debug("stop_music_audio failed", result.error);
}

export const musicAudio: MusicAudio = { support, listApps, start, stop };
