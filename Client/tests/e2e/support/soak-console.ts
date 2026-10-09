// Console.error allow-list for the long-session soak, kept free of Playwright
// imports so it unit-tests under jsdom.

export interface ConsoleEntry {
  text: string;
  /** True while the soak's deliberate offline/online reconnect step is in flight. */
  duringReconnect: boolean;
  /** Playwright's console message type; absent means "error". */
  type?: string;
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

// A voice leave closes that room's signal socket twice over: room.disconnect()
// and the server's participant removal on the voice_leave, which can win and
// drop the socket without a close frame (1006). So the same SDK line is also
// excused for the room the app has just left, until it joins one again.
const SIGNAL_ERROR_ROOM = /error reading from signal stream \{room: channel-(\d+)/;
const JOINING = /\[voice-callbacks\] Joining voice channel \{channelId: (\d+)/;
const LEFT = /\[livekitSession\] Left voice session/;

/** The console.error lines that are not excused for the phase they were logged in. */
export function unexpectedConsoleErrors(entries: readonly ConsoleEntry[]): string[] {
  let joined: string | null = null;
  let left: string | null = null;
  const unexpected: string[] = [];
  for (const { text, duringReconnect, type = "error" } of entries) {
    const join = JOINING.exec(text);
    if (join !== null) {
      joined = join[1]!;
      left = null;
    } else if (LEFT.test(text)) {
      left = joined;
      joined = null;
    }
    if (type !== "error") continue;
    const patterns = duringReconnect ? [...ALWAYS_EXPECTED, ...RECONNECT_ONLY] : ALWAYS_EXPECTED;
    if (patterns.some((p) => p.test(text))) continue;
    if (left !== null && SIGNAL_ERROR_ROOM.exec(text)?.[1] === left) continue;
    unexpected.push(text);
  }
  return unexpected;
}
