import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { savePref } from "@lib/prefs/preferences";
import { EVENT_LOG_PREF_KEY, attachRecorder } from "./eventSink";
import { copyLastExit, webviewFailureFields } from "./appEvents";

type Seen = { code: string; fields: Readonly<Record<string, unknown>> };

const stamp = (time: string, message: string): string =>
  `[2026-11-03][${time}][owncord_client_lib::crash_log][WARN] ${message}`;

const native = (...lines: string[]) => ({
  readNative: () =>
    Promise.resolve([{ name: "owncord-client.log", text: `${lines.join("\n")}\n` }]),
});

const CRASH = stamp("10:00:00", "[crash] fatal signal SIGSEGV (11) on thread 'owncord-screen'");
const GPU = stamp(
  "09:59:00",
  "[exit] webview gpu process failed: crashed, exit code 0x00000005; the camera restarts",
);

const fiveMinutesLater = () => Date.parse("2026-11-03T10:05:00Z");
const webviewFields = (line: string) => webviewFailureFields({ at: "", file: "", line });

describe("copying how the last run ended", () => {
  let seen: Seen[];
  let detach: () => void;
  beforeEach(() => {
    localStorage.clear();
    seen = [];
    detach = attachRecorder((code, fields) => seen.push({ code, fields }));
  });
  afterEach(() => detach());

  it("copies the newest ending and webview failure once across starts", async () => {
    await copyLastExit(native(GPU, CRASH), "linux", fiveMinutesLater);
    await copyLastExit(native(GPU, CRASH), "linux", fiveMinutesLater);

    expect(seen).toEqual([
      {
        code: "native.crash",
        fields: {
          platform: "linux",
          kind: "signal",
          code: "SIGSEGV",
          module: null,
          age_ms: 300000,
        },
      },
      { code: "native.webview_process_failed", fields: { process: "gpu", reason: "crashed" } },
    ]);
  });

  it("copies a newer ending after one it already copied", async () => {
    await copyLastExit(native(CRASH), "windows");
    const later = stamp("11:00:00", "[exit] window closed; normal exit after 12 min");
    await copyLastExit(native(CRASH, later), "windows");
    expect(seen.map((e) => e.code)).toEqual(["native.crash", "native.exit"]);
    expect(seen[1]!.fields).toEqual({ platform: "windows", kind: "normal" });
  });

  it("leaves out the age of a crash only recorded at the next start", async () => {
    const wer = stamp(
      "10:04:50",
      "[exit] Windows recorded a crash of the previous run (pid 7): exception 0xC0000005 in module 'x.dll'",
    );
    await copyLastExit(native(wer), "windows", fiveMinutesLater);
    expect(seen[0]!.fields).toMatchObject({ kind: "exception", age_ms: null });
  });

  it("keeps the lines for a later start while the event log is off", async () => {
    savePref(EVENT_LOG_PREF_KEY, false);
    await copyLastExit(native(CRASH), "linux");
    savePref(EVENT_LOG_PREF_KEY, true);
    await copyLastExit(native(CRASH), "linux");
    expect(seen.map((e) => e.code)).toEqual(["native.crash"]);
  });

  it("records nothing when the native log cannot be read", async () => {
    await copyLastExit({ readNative: () => Promise.reject(new Error("gone")) }, "linux");
    expect(seen).toEqual([]);
  });
});

describe("webview failure fields", () => {
  it("reads the Windows and Android lines", () => {
    expect(
      webviewFields(
        "[exit] webview utility process failed: unexpected (Video Capture), exit code 1",
      ),
    ).toEqual({ process: "utility", reason: "exited" });
    expect(webviewFields("[webview] render process gone: process=renderer reason=crashed")).toEqual(
      {
        process: "renderer",
        reason: "crashed",
      },
    );
    expect(webviewFields("[webview] render process gone: process=renderer reason=killed")).toEqual({
      process: "renderer",
      reason: "killed",
    });
  });

  it("says unknown for words it does not know", () => {
    expect(webviewFields("[exit] webview mystery process failed: melted")).toEqual({
      process: "unknown",
      reason: "unknown",
    });
  });
});
