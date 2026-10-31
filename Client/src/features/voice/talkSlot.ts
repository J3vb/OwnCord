/**
 * Where a control bar keeps its hold-to-talk button. Only the Android app has
 * one (Push to Talk there is the on-screen button, not a key), and the button's
 * module loads on first use, so a desktop never fetches it. The button hides
 * itself outside Push to Talk mode.
 */

import { Disposable } from "../../lib/disposable";
import { createLogger } from "../../lib/logger";
import { isAndroidApp } from "./native/platform";
import type { TalkVariant } from "./talkButton";

const log = createLogger("talk-button");

export interface TalkSlot {
  /** Put the button into `bar`, before `before` (its first child by default).
   *  A bar drawn again gets the same button moved in, so a redraw while it is
   *  held does not cut the speaker off. `onPlaced` runs once it is in. */
  attach(bar: HTMLElement, before?: Node | null, onPlaced?: () => void): void;
  /** Take the button down; one still loading never appears. */
  clear(): void;
}

export function createTalkSlot(variant: TalkVariant): TalkSlot {
  let owner: Disposable | null = null;
  let button: HTMLButtonElement | null = null;
  /** The latest place asked for, where a button still loading goes. */
  let target: { bar: HTMLElement; before: Node | null; onPlaced?: () => void } | null = null;

  function place(btn: HTMLButtonElement): void {
    if (target === null) return;
    const { bar, before, onPlaced } = target;
    bar.insertBefore(btn, before !== null && before.parentNode === bar ? before : bar.firstChild);
    onPlaced?.();
  }

  function clear(): void {
    owner?.destroy();
    owner = null;
    button = null;
    target = null;
  }

  function attach(bar: HTMLElement, before?: Node | null, onPlaced?: () => void): void {
    if (!isAndroidApp()) return;
    target = { bar, before: before === undefined ? bar.firstChild : before, onPlaced };
    if (button !== null) {
      place(button);
      return;
    }
    if (owner !== null) return;
    const mine = new Disposable();
    owner = mine;
    void import("./talkButton")
      .then((m) => {
        if (mine.signal.aborted) return;
        const btn = m.createTalkButton(variant, mine.signal);
        mine.addCleanup(() => btn.remove());
        button = btn;
        place(btn);
      })
      .catch((err: unknown) => log.warn("Talk button failed to load", err));
  }

  return { attach, clear };
}
