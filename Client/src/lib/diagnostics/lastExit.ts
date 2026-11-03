// The support bundle's last-exit.json: how the app's newest run before this
// one ended, read back from the native log lines the Linux, Windows and
// Android code write (docs/architecture/client-diagnostics.md lists them).
// Pure: it reads the log text it is given and returns a summary.

export type ExitOutcome = "crash" | "exit" | "normal";

export interface ExitRecord {
  /** When the line was written, as an ISO time (the log's UTC stamp). */
  readonly at: string;
  readonly outcome: ExitOutcome;
  /** As in the native.crash and native.exit event codes. */
  readonly kind: string;
  readonly code?: string;
  readonly module?: string;
  /** The log file the line came from. */
  readonly file: string;
  /** The message, without the stamp, target and level. */
  readonly line: string;
}

export interface WebviewFailure {
  readonly at: string;
  readonly file: string;
  readonly line: string;
}

export interface LastExit {
  readonly found: boolean;
  /** The newest line that says how a run ended. */
  readonly last: ExitRecord | null;
  /** How many such lines the bundled native logs hold. */
  readonly endings: number;
  /** The newest webview helper process failure, which can freeze a camera. */
  readonly lastWebviewFailure: WebviewFailure | null;
}

const LINE_RE = /^\[(\d{4}-\d{2}-\d{2})\]\[(\d{2}:\d{2}:\d{2})\]\[[^\]]*\]\[[A-Z]+\] (.*)$/;

type Parsed = Omit<ExitRecord, "at" | "file" | "line">;

/** key=value pairs of an Android line. */
function pairs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/(\w+)=(\S+)/g)) out[m[1]!] = m[2]!;
  return out;
}

const ANDROID_EXIT_KINDS = new Set([
  "normal",
  "signal",
  "unclean",
  "anr",
  "low_memory",
  "killed_by_user",
  "killed_by_system",
]);

function withOptional(base: Parsed, code?: string, module?: string): Parsed {
  return {
    ...base,
    ...(code === undefined || code === "" ? {} : { code }),
    ...(module === undefined || module === "" ? {} : { module }),
  };
}

const MATCHERS: readonly ((message: string) => Parsed | null)[] = [
  (m) => {
    const hit = /^\[crash\] fatal signal (SIG[A-Z0-9]+)/.exec(m);
    return hit ? withOptional({ outcome: "crash", kind: "signal" }, hit[1]) : null;
  },
  (m) => {
    const hit = /^\[exit\] ended by signal (SIG[A-Z0-9]+)/.exec(m);
    return hit ? withOptional({ outcome: "exit", kind: "signal" }, hit[1]) : null;
  },
  (m) => {
    const hit =
      /^\[crash\] unhandled exception (0x[0-9A-Fa-f]+)\b.*? in (?:an unknown module|([^\s+]+)\+)/.exec(
        m,
      );
    return hit ? withOptional({ outcome: "crash", kind: "exception" }, hit[1], hit[2]) : null;
  },
  (m) =>
    /^\[crash\] (?:X error |lost the connection to the X server)/.test(m)
      ? { outcome: "crash", kind: "x_error" }
      : null,
  (m) => {
    const hit =
      /^\[exit\] Windows recorded a crash of the previous run \(pid \d+\): (?:exception (0x[0-9A-Fa-f]+)|an unknown exception).*? in module '([^']*)'/.exec(
        m,
      );
    if (!hit) return null;
    const module = hit[2] === "unknown" ? undefined : hit[2];
    return withOptional({ outcome: "crash", kind: "exception" }, hit[1], module);
  },
  (m) =>
    /^\[exit\] Windows recorded that the previous run \(pid \d+\) stopped responding/.test(m)
      ? { outcome: "exit", kind: "anr" }
      : null,
  (m) => {
    const hit =
      /^\[exit\] coredump pid \d+: .*?\bSIG([A-Z]+)\b/.exec(m) ??
      /^\[exit\] coredump pid \d+: .*?Signal: \d+ \(([A-Z]+)\)/.exec(m);
    return hit ? withOptional({ outcome: "crash", kind: "signal" }, `SIG${hit[1]}`) : null;
  },
  (m) =>
    /^\[exit\] the previous run \(pid \d+\) ended without a normal exit/.test(m)
      ? { outcome: "exit", kind: "unclean" }
      : null,
  (m) =>
    /^\[exit\] the previous run \(pid \d+\) ended for an update/.test(m)
      ? { outcome: "normal", kind: "normal" }
      : null,
  (m) =>
    /^\[exit\] .*; normal exit after /.test(m) ? { outcome: "normal", kind: "normal" } : null,
  (m) => {
    const hit = /^\[crash\] (?:the previous run crashed|uncaught exception): (.*)$/.exec(m);
    if (!hit) return null;
    const p = pairs(hit[1]!);
    const kind = p.kind === "jvm" || p.kind === "native" ? p.kind : "unknown";
    return withOptional({ outcome: "crash", kind }, p.code, p.module);
  },
  (m) => {
    const hit = /^\[exit\] the previous run ended: (.*)$/.exec(m);
    if (!hit) return null;
    const p = pairs(hit[1]!);
    const kind = p.kind !== undefined && ANDROID_EXIT_KINDS.has(p.kind) ? p.kind : "unknown";
    return withOptional({ outcome: kind === "normal" ? "normal" : "exit", kind }, p.code);
  },
];

const WEBVIEW_RE =
  /^\[(?:exit\] webview (?:\w+ process failed|process ended)|webview\] render process gone)/;

/** Read the native log files (any order) and summarise the newest ending. */
export function findLastExit(
  files: readonly { readonly name: string; readonly text: string }[],
): LastExit {
  let last: ExitRecord | null = null;
  let webview: WebviewFailure | null = null;
  let endings = 0;
  for (const file of files) {
    for (const raw of file.text.split("\n")) {
      const hit = LINE_RE.exec(raw.trimEnd());
      if (!hit) continue;
      const at = `${hit[1]}T${hit[2]}Z`;
      const message = hit[3]!;
      if (WEBVIEW_RE.test(message)) {
        if (webview === null || at >= webview.at) webview = { at, file: file.name, line: message };
        continue;
      }
      for (const match of MATCHERS) {
        const parsed = match(message);
        if (parsed === null) continue;
        endings++;
        if (last === null || at >= last.at)
          last = { at, ...parsed, file: file.name, line: message };
        break;
      }
    }
  }
  return { found: last !== null, last, endings, lastWebviewFailure: webview };
}
