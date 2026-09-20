// The console guard for the unit suite (C-04): a green run prints nothing
// unexplained. console.warn and console.error are captured per test, and a
// test that provokes one claims it with expectConsole — which asserts the
// message and stops it failing the run. Anything left over fails the test that
// produced it, with the text it printed.
//
// tests/setup.ts installs this; tests never call installConsoleGuard directly.
import { afterEach, beforeEach, vi } from "vitest";

export type GuardedLevel = "warn" | "error";

interface RecordedCall {
  readonly level: GuardedLevel;
  readonly args: readonly unknown[];
}

// The guard's own list. Deliberately not `mock.calls` of the spies below: a
// test may install its own console spy (or call vi.restoreAllMocks), which
// would replace or remove ours, so the guard reads this and nothing else.
let recorded: RecordedCall[] = [];

function printable(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

// The whole call, not just the first argument: the app logger prints
// `console.warn(prefix, message, data)`, so the message a test cares about is
// arg 1 while arg 0 is only a timestamped component prefix.
function text(call: RecordedCall): string {
  return call.args.map(printable).join(" ");
}

function matches(message: string, matcher: string | RegExp): boolean {
  return typeof matcher === "string" ? message.includes(matcher) : matcher.test(message);
}

/**
 * Claim one recorded console.<level> call whose first argument matches
 * `matcher` (substring for a string, .test() for a RegExp). Fails the test if
 * there is no such call.
 */
export function expectConsole(level: GuardedLevel, matcher: string | RegExp): void {
  const index = recorded.findIndex((call) => call.level === level && matches(text(call), matcher));
  if (index === -1) {
    const sameLevel = recorded.filter((call) => call.level === level).map(text);
    throw new Error(
      `expectConsole: no console.${level} matching ${String(matcher)} was recorded.` +
        (sameLevel.length > 0 ? ` Recorded: ${JSON.stringify(sameLevel)}` : ""),
    );
  }
  recorded.splice(index, 1);
}

/** Install the guard. Called once, from tests/setup.ts. */
export function installConsoleGuard(): void {
  beforeEach(() => {
    recorded = [];
    for (const level of ["warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        recorded.push({ level, args });
      });
    }
  });

  afterEach(() => {
    const unclaimed = recorded;
    recorded = [];
    if (unclaimed.length === 0) return;
    const [first] = unclaimed;
    throw new Error(
      `Unexpected console.${first!.level}: ${text(first!)}` +
        (unclaimed.length > 1 ? `\n(+${unclaimed.length - 1} more unclaimed)` : ""),
    );
  });
}
