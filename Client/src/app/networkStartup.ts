import { Disposable } from "../lib/disposable";
import { setOwnedTimeout } from "../lib/dom";
import { desktop } from "../platform/desktop";

/** Longest the chat mount waits for the first network reading; a slow or stuck host never blocks it. */
export const NETWORK_STARTUP_WAIT_MS = 1_000;

/** App-lifetime listener, shared by every server and released when the window closes. */
export function startNetworkMonitoring(): Promise<void> {
  const owner = new Disposable();
  window.addEventListener("beforeunload", () => owner.destroy(), {
    once: true,
    signal: owner.signal,
  });
  const started = desktop.meteredNetwork.start(owner.signal);
  return new Promise<void>((resolve) => {
    const cancel = setOwnedTimeout(owner.signal, resolve, NETWORK_STARTUP_WAIT_MS);
    const done = (): void => {
      cancel();
      resolve();
    };
    started.then(done, done);
  });
}
