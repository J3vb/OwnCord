// Starts the diagnostic event log and records app.started. Loaded lazily from
// main.ts so none of it sits on the startup path. Window visibility and the
// network coming back are recorded by ws.ts's wake listeners, which already
// watch both while signed in.
import { loadPref } from "@lib/prefs/preferences";
import type { AppMetadata } from "../../platform/contracts/appMetadata";
import { EVENT_LOG_PREF_KEY, recordEvent, setEventSinkEnabled } from "./eventSink";
import { startEventLog } from "./eventLog";

type Platform = "windows" | "linux" | "macos" | "android" | "browser" | "unknown";

function platformOf(ua: string, native: boolean): Platform {
  if (!native) return "browser";
  if (/Android/.test(ua)) return "android";
  if (/\bWindows\b/.test(ua)) return "windows";
  if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) return "macos";
  if (/\bLinux\b/.test(ua)) return "linux";
  return "unknown";
}

/** The engine version: the first of Chrome/, Edg/ or Version/ in the user agent. */
function webviewVersion(ua: string): string | null {
  const match = /\b(?:Edg|Chrome|Version)\/(\d+(?:\.\d+){0,3})/.exec(ua);
  return match?.[1] ?? null;
}

export async function startAppEvents(meta: AppMetadata): Promise<void> {
  const on = loadPref<boolean>(EVENT_LOG_PREF_KEY, true) !== false;
  setEventSinkEnabled(on);
  startEventLog();

  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  let version: string | null;
  try {
    version = await meta.getVersion();
  } catch {
    version = null;
  }
  recordEvent("app.started", {
    app_version: version,
    platform: platformOf(ua, "__TAURI_INTERNALS__" in globalThis),
    webview_version: webviewVersion(ua),
  });
}
