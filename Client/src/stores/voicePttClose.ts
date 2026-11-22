// A push-to-talk release's store write waiting out its delay, split from
// voice.store.ts (which owns the write and re-exports the reads). The
// widget, the self-speaking indicator and the push-to-talk ticks follow
// pttGated, so a release's close is recorded only once its delay has run,
// when the voice actually stops. The mic's own close runs on the audio clock
// (AudioPipeline.setPttGated); this page timer only moves the flag, so in a
// hidden window only the indicator and the tick may lag.

let pendingClose: ReturnType<typeof setTimeout> | undefined;

/** Run `close` after `afterMs`, replacing a close still waiting. */
export function schedulePttClose(close: () => void, afterMs: number): void {
  cancelPttClose();
  pendingClose = setTimeout(() => {
    pendingClose = undefined;
    close();
  }, afterMs);
}

/** A release is still waiting out its delay: the mic is closing while the
 *  store still shows it open, so whoever opens a closed gate opens this one. */
export function isPttClosePending(): boolean {
  return pendingClose !== undefined;
}

/** Drop a close still waiting: a newer write of the gate, leaving the call or
 *  a session reset. */
export function cancelPttClose(): void {
  clearTimeout(pendingClose);
  pendingClose = undefined;
}
