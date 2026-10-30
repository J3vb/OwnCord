/**
 * The phone navigation's loader: swipes and Back-closes-overlays. Their code
 * stays out of the main-page chunk until the window is a phone (touch, narrow),
 * which is the only place they do anything. Both ask for the phone layout at
 * every touch or Back, so turning the device after they loaded needs nothing.
 */

import { createLogger } from "@lib/logger";
import { isPhoneLayout } from "@lib/ui/bottomSheet";
import type { PhoneGesturesOptions } from "./phoneGestures";

export interface PhoneNavOptions extends Pick<
  PhoneGesturesOptions,
  "signal" | "chatArea" | "drawerSurfaces" | "memberColumn" | "drawer" | "members"
> {
  /** The page root: dialogs are added to it. */
  readonly root: HTMLElement;
  /** Close the open content view and take its back path. */
  readonly closeView: () => void;
}

const log = createLogger("phone-nav");

export function installPhoneNavWhenPhone(opts: PhoneNavOptions): void {
  const { signal } = opts;
  let started = false;

  function start(): void {
    if (started || signal.aborted || !isPhoneLayout()) return;
    started = true;
    void Promise.all([import("./phoneGestures"), import("./overlayBack")]).then(
      ([gestures, overlays]) => {
        if (signal.aborted) return;
        try {
          gestures.installPhoneGestures(opts);
          overlays.installOverlayBack({ signal, root: opts.root, closeView: opts.closeView });
        } catch (err: unknown) {
          log.warn("Phone navigation failed to install", err);
        }
        return;
      },
      () => {
        // The chunks could not load: the next resize tries again.
        started = false;
      },
    );
  }

  // Turning a tablet or resizing a window moves it onto the phone layout.
  window.addEventListener("resize", start, { signal });
  start();
}
