// Console.error allow-list for the long-session soak, kept free of Playwright
// imports so it unit-tests under jsdom.

export interface ConsoleEntry {
  text: string;
  /** True while the soak's deliberate offline/online reconnect step is in flight. */
  duringReconnect: boolean;
}

// Excused in any phase. The reconnect and logout steps drop the socket, so the
// client logs its own transport failure; only the exact messages those steps
// emit are listed, so a genuine error that merely mentions "reconnect" fails.
const ALWAYS_EXPECTED = [
  // `ws_send` on a closed socket (lib/ws.ts:539).
  /\[ws\] ws_send failed \{error: WS is not open/,
  // livekit-client's own log of a receive-side key race at join (OC-0452).
  // Matches the bare message or the SDK's `[timestamp] [ERROR] [livekit]`
  // logger prefix, never the app's judgement of it: the
  // `[roomEventHandlers] LiveKit E2EE encryption error` line, which a race
  // that persists still prints and this list does not excuse.
  /^(?:\[[^\]]+\] \[ERROR\] \[livekit\] )?InvalidKey: Decryption failed: /,
];

// LiveKit's signaling socket, dropped by the every-5th-cycle reconnect; the
// SDK's own console line, whose cause prints as `error: ConnectionError: WS closed`.
// Excused only inside the reconnect window, so a signaling failure during a
// join, a voice operation or the idle phase still fails the run.
const RECONNECT_ONLY = [/error reading from signal stream \{room: channel-\d+/];

/** The console.error lines that are not excused for the phase they were logged in. */
export function unexpectedConsoleErrors(entries: readonly ConsoleEntry[]): string[] {
  return entries
    .filter(({ text, duringReconnect }) => {
      const patterns = duringReconnect ? [...ALWAYS_EXPECTED, ...RECONNECT_ONLY] : ALWAYS_EXPECTED;
      return !patterns.some((p) => p.test(text));
    })
    .map((e) => e.text);
}
