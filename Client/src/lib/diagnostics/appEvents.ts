// Starts the diagnostic event log and records app.started, then, a little
// later, how the previous run ended (native.crash / native.exit) and the
// newest webview process failure, read back from the native log. Loaded lazily
// from main.ts so none of it sits on the startup path. Window visibility, the
// network coming back and waking from sleep are recorded by ws.ts, which
// already watches all three while signed in.
import { loadPref, savePref } from "@lib/prefs/preferences";
import type { AppMetadata } from "../../platform/contracts/appMetadata";
import type { LogFiles } from "../../platform/contracts/logFiles";
import { EVENT_LOG_PREF_KEY, recordEvent, setEventSinkEnabled } from "./eventSink";
import { startEventLog } from "./eventLog";
import { findLastExit, type ExitRecord, type WebviewFailure } from "./lastExit";

/** Long enough for the native side to write its "previous run" lines first. */
const LAST_EXIT_DELAY_MS = 10_000;

/** The native lines already copied, so a second start does not copy them again. */
const COPIED_KEY = "diagnosticEventLogCopied";

let lastExitTimer: ReturnType<typeof setTimeout> | null = null;

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

const CRASH_KINDS = ["signal", "exception", "panic", "x_error", "jvm", "native"] as const;
const EXIT_KINDS = [
  "normal",
  "signal",
  "unclean",
  "anr",
  "low_memory",
  "killed_by_user",
  "killed_by_system",
] as const;

function oneOf<T extends string>(list: readonly T[], value: string): T | "unknown" {
  return (list as readonly string[]).includes(value) ? (value as T) : "unknown";
}

function recordExit(exit: ExitRecord, platform: Platform, now: number): void {
  // Only a line the dying process wrote dates the crash; the "previous run"
  // lines are written at the next start, so their age says nothing.
  const atCrash = /^\[crash\] (?:fatal signal|unhandled exception|uncaught exception)/.test(
    exit.line,
  );
  const age = now - Date.parse(exit.at);
  const age_ms = atCrash && Number.isFinite(age) && age >= 0 ? age : null;
  if (exit.outcome === "crash") {
    recordEvent("native.crash", {
      platform,
      kind: oneOf(CRASH_KINDS, exit.kind),
      code: exit.code ?? null,
      module: exit.module ?? null,
      age_ms,
    });
    return;
  }
  recordEvent("native.exit", { platform, kind: oneOf(EXIT_KINDS, exit.kind) });
}

type WebviewProcess = "browser" | "renderer" | "gpu" | "utility" | "unknown";
type WebviewReason = "exited" | "crashed" | "unresponsive" | "killed" | "out_of_memory" | "unknown";

/** "[exit] webview gpu process failed: crashed, …" (Windows) or
 *  "[webview] render process gone: process=renderer reason=killed" (Android). */
export function webviewFailureFields(failure: WebviewFailure): {
  process: WebviewProcess;
  reason: WebviewReason;
} {
  const line = failure.line;
  const named = /webview (\w+) process failed|process=(\w+)/.exec(line);
  const word = named?.[1] ?? named?.[2] ?? (/render process/.test(line) ? "renderer" : "");
  const process = oneOf(["browser", "renderer", "gpu", "utility"] as const, word);
  const tail = line.replace(/^.*?(?:failed:|reason=)/, "");
  const reason: WebviewReason = /^\s*crashed/.test(tail)
    ? "crashed"
    : /^\s*unresponsive/.test(tail)
      ? "unresponsive"
      : /^\s*(?:killed|terminated)/.test(tail)
        ? "killed"
        : /^\s*out of memory/.test(tail)
          ? "out_of_memory"
          : /^\s*(?:unexpected|exited)/.test(tail)
            ? "exited"
            : "unknown";
  return { process, reason };
}

/** Copy the newest ending and webview failure once; a line copied by an
 *  earlier start is skipped. */
export async function copyLastExit(
  logFiles: Pick<LogFiles, "readNative">,
  platform: Platform,
  now: () => number = Date.now,
): Promise<void> {
  // Turned off since start: leave the lines for a start that records them.
  if (loadPref<boolean>(EVENT_LOG_PREF_KEY, true) === false) return;
  let files: readonly { readonly name: string; readonly text: string }[];
  try {
    files = await logFiles.readNative();
  } catch {
    return;
  }
  const found = findLastExit(files);
  const copied = loadPref<readonly string[]>(COPIED_KEY, []);
  const seen = new Set(Array.isArray(copied) ? copied : []);
  const next: string[] = [];
  if (found.last !== null) {
    const id = `${found.last.at} ${found.last.line}`;
    next.push(id);
    if (!seen.has(id)) recordExit(found.last, platform, now());
  }
  const webview = found.lastWebviewFailure;
  if (webview !== null) {
    const id = `${webview.at} ${webview.line}`;
    next.push(id);
    if (!seen.has(id)) recordEvent("native.webview_process_failed", webviewFailureFields(webview));
  }
  if (next.length > 0) savePref(COPIED_KEY, next);
}

export async function startAppEvents(
  meta: AppMetadata,
  logFiles?: Pick<LogFiles, "readNative">,
): Promise<void> {
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
  const platform = platformOf(ua, "__TAURI_INTERNALS__" in globalThis);
  recordEvent("app.started", {
    app_version: version,
    platform,
    webview_version: webviewVersion(ua),
  });
  if (lastExitTimer !== null) clearTimeout(lastExitTimer);
  lastExitTimer = null;
  if (on && logFiles !== undefined && platform !== "browser") {
    lastExitTimer = setTimeout(() => {
      lastExitTimer = null;
      void copyLastExit(logFiles, platform);
    }, LAST_EXIT_DELAY_MS);
  }
}
