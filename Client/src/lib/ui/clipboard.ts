/**
 * The one door to the system clipboard for text
 * (src/features/clipboardDoor.test.ts holds that). Every copy reports its
 * result to the user, either as a toast or on the button that was pressed.
 */
import { setText } from "../dom";
import { showToast } from "./toast";

/**
 * Copy `text`. True once it is on the clipboard; false when the write is
 * refused or there is no clipboard (a page that is not a secure context).
 * Never rejects.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Copy `text` and say how it went in a toast. */
export function copyThenToast(text: string, done: string, failed: string): void {
  void copyText(text).then((ok) => showToast(ok ? done : failed, ok ? "success" : "error"));
}

export interface CopyLabels {
  readonly idle: string;
  readonly done: string;
  readonly failed: string;
}

const pendingResets = new WeakMap<Element, () => void>();

/**
 * Copy `text` and say how it went on `button`'s own label for `ms`, then put
 * the idle label back. A second press restarts the wait instead of letting the
 * first one's reset cut it short. When `signal` aborts, a pending reset is
 * dropped; without one, the reset touches only the button.
 */
export function copyThenRelabel(
  text: string,
  button: Element,
  labels: CopyLabels,
  options: { readonly signal?: AbortSignal; readonly ms?: number } = {},
): void {
  const { signal, ms = 1500 } = options;
  void copyText(text).then((ok) => {
    if (signal?.aborted === true) return;
    pendingResets.get(button)?.();
    setText(button, ok ? labels.done : labels.failed);
    const cancel = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      pendingResets.delete(button);
    };
    const timer = setTimeout(() => {
      cancel();
      setText(button, labels.idle);
    }, ms);
    signal?.addEventListener("abort", cancel, { once: true });
    pendingResets.set(button, cancel);
  });
}
