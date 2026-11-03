import { describe, expect, it } from "vitest";
import { findLastExit } from "./lastExit";

const at = (stamp: string, target: string, level: string, message: string): string =>
  `[${stamp.slice(0, 10)}][${stamp.slice(11, 19)}][${target}][${level}] ${message}`;

const file = (name: string, ...lines: string[]) => ({ name, text: `${lines.join("\n")}\n` });

describe("findLastExit", () => {
  it("reports nothing found for a log without an ending", () => {
    expect(
      findLastExit([
        file(
          "owncord-client.log",
          "[startup] no stamp",
          at("2026-11-03T10:00:00", "app", "INFO", "[startup] frontend ready"),
        ),
      ]),
    ).toEqual({
      found: false,
      last: null,
      endings: 0,
      lastWebviewFailure: null,
    });
  });

  const CASES = [
    {
      platform: "Linux fatal signal",
      line: at(
        "2026-10-02T16:27:19",
        "owncord_client_lib::crash_log",
        "ERROR",
        "[crash] fatal signal SIGSEGV (11) on thread 'owncord-screen'",
      ),
      want: { outcome: "crash", kind: "signal", code: "SIGSEGV" },
    },
    {
      platform: "Linux ended by signal",
      line: at(
        "2026-10-02T16:27:19",
        "owncord_client_lib::crash_log",
        "WARN",
        "[exit] ended by signal SIGTERM (15) on thread 'owncord-client', sent by pid 4242 (kwin_wayland)",
      ),
      want: { outcome: "exit", kind: "signal", code: "SIGTERM" },
    },
    {
      platform: "Linux X error",
      line: at(
        "2026-10-02T16:27:19",
        "owncord_client_lib::crash_log",
        "WARN",
        "[crash] X error 3 on request 1.2 (serial 9, resource 0x1); GDK exits on one it did not expect",
      ),
      want: { outcome: "crash", kind: "x_error" },
    },
    {
      platform: "Linux coredump",
      line: at(
        "2026-10-02T16:30:00",
        "owncord_client_lib::system_crash_report",
        "WARN",
        "[exit] coredump pid 4242: Signal: 11 (SEGV)",
      ),
      want: { outcome: "crash", kind: "signal", code: "SIGSEGV" },
    },
    {
      platform: "Windows exception filter",
      line: at(
        "2026-10-02T16:27:19",
        "owncord_client_lib::exception_log",
        "ERROR",
        "[crash] unhandled exception 0xC0000005 (access violation) in nvwgf2umx.dll+0x1A2B3C on thread 4242",
      ),
      want: { outcome: "crash", kind: "exception", code: "0xC0000005", module: "nvwgf2umx.dll" },
    },
    {
      platform: "Windows exception in an unknown module",
      line: at(
        "2026-10-02T16:27:19",
        "owncord_client_lib::exception_log",
        "ERROR",
        "[crash] unhandled exception 0xE06D7363 (C++ exception) in an unknown module at 0x7FF60000 on the main thread",
      ),
      want: { outcome: "crash", kind: "exception", code: "0xE06D7363" },
    },
    {
      platform: "Windows event log crash",
      line: at(
        "2026-10-02T16:30:00",
        "owncord_client_lib::system_crash_report",
        "WARN",
        "[exit] Windows recorded a crash of the previous run (pid 11288): exception 0xC0000409 (fail fast) in module 'ucrtbase.dll' version 10.0 at offset 0x1, app version 2.7.0",
      ),
      want: { outcome: "crash", kind: "exception", code: "0xC0000409", module: "ucrtbase.dll" },
    },
    {
      platform: "Windows hang",
      line: at(
        "2026-10-02T16:30:00",
        "owncord_client_lib::system_crash_report",
        "WARN",
        "[exit] Windows recorded that the previous run (pid 11288) stopped responding and was closed (Application Hang), version 2.7.0",
      ),
      want: { outcome: "exit", kind: "anr" },
    },
    {
      platform: "desktop unclean exit",
      line: at(
        "2026-10-02T16:30:00",
        "owncord_client_lib::exit_watch",
        "WARN",
        "[exit] the previous run (pid 7) ended without a normal exit or a logged signal: x. Its last record: rss_mb=400",
      ),
      want: { outcome: "exit", kind: "unclean" },
    },
    {
      platform: "desktop normal exit",
      line: at(
        "2026-10-02T16:30:00",
        "owncord_client_lib::exit_watch",
        "INFO",
        "[exit] window closed; normal exit after 12 min",
      ),
      want: { outcome: "normal", kind: "normal" },
    },
    {
      platform: "Android exit",
      line: at(
        "2026-10-02T16:30:00",
        "owncord_client::android",
        "WARN",
        "[exit] the previous run ended: kind=low_memory reason=low_memory importance=cached age_ms=1 memory_mb=300 at=1",
      ),
      want: { outcome: "exit", kind: "low_memory" },
    },
    {
      platform: "Android native crash",
      line: at(
        "2026-10-02T16:30:00",
        "owncord_client::android",
        "ERROR",
        "[crash] the previous run crashed: kind=native code=SIGSEGV importance=foreground age_ms=1 memory_mb=1 at=1",
      ),
      want: { outcome: "crash", kind: "native", code: "SIGSEGV" },
    },
    {
      platform: "Android uncaught exception",
      line: at(
        "2026-10-02T16:30:00",
        "owncord_client::android",
        "ERROR",
        "[crash] uncaught exception: kind=jvm code=java.lang.IllegalStateException cause=java.io.IOException thread=main module=com.owncord.client.MainActivity",
      ),
      want: {
        outcome: "crash",
        kind: "jvm",
        code: "java.lang.IllegalStateException",
        module: "com.owncord.client.MainActivity",
      },
    },
  ] as const;

  for (const sample of CASES) {
    it(`reads a ${sample.platform} line`, () => {
      const result = findLastExit([file("owncord-client.log", sample.line)]);
      expect(result.found).toBe(true);
      expect(result.endings).toBe(1);
      expect(result.last).toEqual({
        at: `${sample.line.slice(1, 11)}T${sample.line.slice(13, 21)}Z`,
        ...sample.want,
        file: "owncord-client.log",
        line: sample.line.slice(sample.line.indexOf("] [") + 2),
      });
    });
  }

  it("takes the newest ending across files and the later line at the same second", () => {
    const result = findLastExit([
      file(
        "owncord-client.log",
        at(
          "2026-10-05T09:00:00",
          "x",
          "WARN",
          "[exit] the previous run (pid 7) ended without a normal exit or a logged signal: y",
        ),
        at(
          "2026-10-05T09:00:00",
          "x",
          "WARN",
          "[exit] Windows recorded a crash of the previous run (pid 7): exception 0xC0000005 (access violation) in module 'a.dll' version 1 at offset 2, app version 3",
        ),
      ),
      file(
        "owncord-client_2026-10-01.log",
        at(
          "2026-10-01T09:00:00",
          "x",
          "ERROR",
          "[crash] fatal signal SIGABRT (6) on thread 'main'",
        ),
      ),
    ]);
    expect(result.endings).toBe(3);
    expect(result.last).toMatchObject({
      outcome: "crash",
      module: "a.dll",
      file: "owncord-client.log",
    });
  });

  it("keeps the newest webview process failure apart from the ending", () => {
    const result = findLastExit([
      file(
        "owncord-client.log",
        at(
          "2026-10-05T09:00:00",
          "x",
          "WARN",
          "[exit] webview utility process failed: unexpected (Video Capture), exit code 0x00000001; the camera restarts",
        ),
        at(
          "2026-10-05T09:01:00",
          "x",
          "WARN",
          "[webview] render process gone: process=renderer reason=crashed priority=important",
        ),
      ),
    ]);
    expect(result.found).toBe(false);
    expect(result.lastWebviewFailure).toEqual({
      at: "2026-10-05T09:01:00Z",
      file: "owncord-client.log",
      line: "[webview] render process gone: process=renderer reason=crashed priority=important",
    });
  });
});
