/**
 * Where a control bar keeps its hold-to-talk button. Only the Android app has
 * one (Push to Talk there is the on-screen button, not a key), and the button's
 * module loads on first use, so a desktop never fetches it. The button hides
 * itself outside Push to Talk mode.
 */

import { createControlSlot, type ControlSlot } from "./controlSlot";
import type { TalkVariant } from "./talkButton";

/** A redraw while the button is held moves it, so the speaker is not cut off. */
export type TalkSlot = ControlSlot;

export function createTalkSlot(variant: TalkVariant): TalkSlot {
  return createControlSlot("talk", () =>
    import("./talkButton").then((m) => (signal) => m.createTalkButton(variant, signal)),
  );
}
