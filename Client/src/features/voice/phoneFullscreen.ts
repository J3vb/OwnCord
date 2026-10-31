/**
 * What a phone adds to a full-screen stream tile: the Back button leaves full
 * screen, and the screen turns to landscape where the browser allows it.
 *
 * `beginPhoneFullscreen` is called when a tile goes full screen on a phone and
 * `end()` when it comes back. The orientation lock is a request: most engines
 * refuse it outside real full screen, or have no `screen.orientation.lock` at
 * all, and a refusal just leaves the screen as it is. Nothing here throws.
 */

import { claimBack } from "../../lib/ui/backHistory";
import { createLogger } from "../../lib/logger";

const log = createLogger("phone-fullscreen");

interface LockableOrientation {
  lock?: (orientation: string) => Promise<void>;
  unlock?: () => void;
}

export interface PhoneFullscreen {
  /** Give Back up and let the screen turn freely again. Safe to repeat. */
  end(): void;
}

function orientationOf(): LockableOrientation | undefined {
  try {
    return typeof screen === "undefined"
      ? undefined
      : (screen.orientation as LockableOrientation | undefined);
  } catch {
    return undefined;
  }
}

/** Ask for landscape; true when the browser granted it. */
async function lockLandscape(): Promise<boolean> {
  try {
    const orientation = orientationOf();
    if (typeof orientation?.lock !== "function") return false;
    await orientation.lock("landscape");
    return true;
  } catch (err) {
    log.debug("Orientation lock refused", { err });
    return false;
  }
}

function unlock(): void {
  try {
    orientationOf()?.unlock?.();
  } catch (err) {
    log.debug("Orientation unlock failed", { err });
  }
}

/**
 * Claim Back for a full-screen tile and ask for landscape. `onBack` leaves
 * full screen; the claim is already dropped when it runs.
 */
export function beginPhoneFullscreen(onBack: () => void): PhoneFullscreen {
  let ended = false;
  let locked = false;
  const claim = claimBack(() => {
    // A Back ends this too: the screen is free to turn before full screen goes.
    end();
    onBack();
  });
  void lockLandscape().then((granted) => {
    locked = granted;
    // Full screen ended while the lock was pending: give it straight back.
    if (granted && ended) unlock();
  });
  function end(): void {
    if (ended) return;
    ended = true;
    claim.release();
    if (locked) unlock();
  }
  return { end };
}
