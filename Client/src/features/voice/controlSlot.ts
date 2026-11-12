/**
 * Where a control bar keeps a control only the Android app has (the
 * hold-to-talk button, the sound route button). The control's module loads on
 * first use, so a desktop never fetches it.
 */

import { Disposable } from "../../lib/disposable";
import { createLogger } from "../../lib/logger";
import { isAndroidApp } from "./native/platform";

const log = createLogger("control-slot");

export interface ControlSlot {
  /** Put the control into `bar`, before `before`; at the bar's start when
   *  there is none or it has left the bar. A bar drawn again gets the same
   *  control moved in, so a redraw does not replace one that is held or has a
   *  sheet open. `onPlaced` runs once it is in. */
  attach(bar: HTMLElement, before?: Node | null, onPlaced?: () => void): void;
  /** Take the control down; one still loading never appears. */
  clear(): void;
}

/** `load` fetches the control's module and answers with what builds it. The
 *  control is built only if the slot still wants it; its `signal` aborts when
 *  the slot is cleared. `tag` names the control in the log. */
export function createControlSlot(
  tag: string,
  load: () => Promise<(signal: AbortSignal) => HTMLButtonElement>,
): ControlSlot {
  let owner: Disposable | null = null;
  let button: HTMLButtonElement | null = null;
  /** The latest place asked for, where a control still loading goes. */
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
    void load()
      .then((build) => {
        if (mine.signal.aborted) return;
        const btn = build(mine.signal);
        mine.addCleanup(() => btn.remove());
        button = btn;
        place(btn);
      })
      .catch((err: unknown) => log.warn(`The ${tag} control failed to load`, err));
  }

  return { attach, clear };
}
