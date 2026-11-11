/**
 * The two guards that can keep the Settings overlay from closing or switching
 * tabs: a one-time secret still in flight, and unsaved edits in the open tab.
 */

import { confirmDiscardUnsaved } from "./unsavedConfirm";

export interface SecretHold {
  /**
   * A recovery kit or recovery codes response is the only copy of the new
   * secret, and the request has already invalidated the old one. While one is
   * in flight, ignore close and tab switches so the tab's signal cannot abort
   * before the secret is shown. Logout/destroy still tear down regardless.
   */
  holdOpen<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R>;
  /** True while a secret request is in flight. */
  held(): boolean;
}

export function createSecretHold(): SecretHold {
  let secretRequests = 0;
  return {
    holdOpen:
      (fn) =>
      async (...args) => {
        secretRequests++;
        try {
          return await fn(...args);
        } finally {
          secretRequests--;
        }
      },
    held: () => secretRequests > 0,
  };
}

export interface UnsavedGuard {
  /** Set by the tab on screen when it holds a form that can be left half-typed. */
  setDirtyCheck(check: (() => boolean) | null): void;
  isDirty(): boolean;
  /**
   * True when the open tab has unsaved edits: the user is asked first, and
   * `retry` runs the same switch or close again only if they choose Discard.
   */
  blockedByUnsaved(retry: () => void): boolean;
  promptOpen(): boolean;
  /** Dismiss the open prompt without discarding; a no-op when none is open.
   *  With `forget`, also drop the handle (teardown). */
  closePrompt(forget?: boolean): void;
}

export function createUnsavedGuard(
  signal: AbortSignal,
  getContainer: () => HTMLElement | undefined,
): UnsavedGuard {
  let dirtyCheck: (() => boolean) | null = null;
  /** Closes the open "discard unsaved changes?" prompt; null when none is open. */
  let closeUnsavedPrompt: (() => void) | null = null;
  return {
    setDirtyCheck: (check) => {
      dirtyCheck = check;
    },
    isDirty: () => dirtyCheck?.() === true,
    blockedByUnsaved: (retry) => {
      if (dirtyCheck?.() !== true) return false;
      if (closeUnsavedPrompt !== null) return true;
      closeUnsavedPrompt = confirmDiscardUnsaved({
        signal,
        container: getContainer(),
        onDiscard: () => {
          dirtyCheck = null;
          retry();
        },
        onClosed: () => {
          closeUnsavedPrompt = null;
        },
      });
      return true;
    },
    promptOpen: () => closeUnsavedPrompt !== null,
    closePrompt: (forget = false) => {
      closeUnsavedPrompt?.();
      if (forget) closeUnsavedPrompt = null;
    },
  };
}
