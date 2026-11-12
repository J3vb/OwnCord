// The host side of `systemIdle.follow`, loaded in the Android app only
// (`src-tauri/src/idle_android.rs`, `IdlePlugin.kt`). The plugin sends `look`
// when the app comes back into view, and each time it has been out of view
// for the delay it was last given. The delay goes out one command at a time:
// the host runs each as a task of its own, and two on their way at once could
// reach the plugin either way round.
import { addPluginListener, type PluginListener } from "@tauri-apps/api/core";
import { createLogger } from "@lib/logger";
import { tryInvoke } from "./nativeInvoke";

const log = createLogger("systemIdle");

/** Bumped by each `follow`: the newest follower owns the plugin's delay. */
let generation = 0;
/** Settles when the last delay sent was answered; the next goes out then. */
let answered: Promise<unknown> = Promise.resolve();

/** Give the plugin its delay; 0 ends its alarm. `tryInvoke` never rejects, so
 *  one refused command does not hold up the next. */
function sendDelay(thresholdMs: number): void {
  answered = answered
    .then(() => tryInvoke<void>("system_idle_follow", { thresholdMs }))
    .then((result) => {
      if (!result.ok) log.warn("system_idle_follow failed", result.error.message);
    });
}

function stop(listener: PluginListener): void {
  void listener.unregister().catch((err: unknown) => log.debug("Unlisten failed", err));
}

export function follow(signal: AbortSignal, thresholdMs: number, ask: () => void): void {
  // An owner that is gone already takes nothing over.
  if (signal.aborted) return;
  const mine = ++generation;
  void addPluginListener<unknown>("owncord-idle", "look", () => {
    if (!signal.aborted && mine === generation) ask();
  }).then(
    (listener) => {
      if (signal.aborted || mine !== generation) {
        stop(listener);
        // An older follower's delay is nobody's now.
        if (mine === generation) sendDelay(0);
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          stop(listener);
          if (mine === generation) sendDelay(0);
        },
        { once: true },
      );
      sendDelay(thresholdMs);
      // Asked only from here: with the listener in, this read and every
      // `look` after it arrive, and nothing that happened in between is lost.
      ask();
    },
    // The poll still reads the time; it just does not run on a sleeping phone.
    (err: unknown) => log.warn("Idle events unavailable; the status waits for the poll", err),
  );
}
