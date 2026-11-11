import { Disposable } from "../lib/disposable";
import { desktop } from "../platform/desktop";

/** App-lifetime listener, shared by every server and released when the window closes. */
export function startNetworkMonitoring(): Promise<void> {
  const owner = new Disposable();
  window.addEventListener("beforeunload", () => owner.destroy(), {
    once: true,
    signal: owner.signal,
  });
  return desktop.meteredNetwork.start(owner.signal);
}
