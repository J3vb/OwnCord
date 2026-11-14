// The PTT key poller's liveness: a process-wide platform capability, split
// from voice.store.ts (which re-exports it).

/** Whether the Rust-side PTT key poller can report key state on this platform.
 *  A process-wide platform capability, not per-session state, so
 *  `resetVoiceStore()` must NOT clear it. It lives here, not in
 *  livekitSession.ts, so `ptt.ts` can write it at startup without pulling in
 *  the livekit-client SDK. Defaults to false so an unsupported poller never
 *  causes a join-time mute that nothing can later lift. */
let pttPollingLive = false;
const pttPollingListeners = new Set<() => void>();

/** Report whether the PTT key-polling backend can actually observe key state
 *  (the `ptt_polling_supported` command), not merely whether a key is bound:
 *  without a live backend no `ptt-state` event arrives to lift a join-time mute. */
export function setPttPollingLive(live: boolean): void {
  if (pttPollingLive === live) return;
  pttPollingLive = live;
  for (const listener of pttPollingListeners) listener();
}

/** Run `listener` whenever the poller goes live or stops, so the sensitivity
 *  gate can hand over to Push to Talk only once a key can actually gate. */
export function onPttPollingLiveChange(listener: () => void): () => void {
  pttPollingListeners.add(listener);
  return () => pttPollingListeners.delete(listener);
}

/** Whether the PTT poller is live (see `setPttPollingLive`). */
export function isPttPollingLive(): boolean {
  return pttPollingLive;
}
