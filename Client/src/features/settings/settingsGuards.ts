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

/** What would be lost, which decides the wording of the question. */
export type UnsavedTopic = "profile" | "theme" | "secret";

// The one that costs most comes first: it names the prompt when several apply.
const TOPIC_ORDER: readonly UnsavedTopic[] = ["secret", "theme", "profile"];

export interface UnsavedGuard {
  /**
   * Set by the tab on screen when it holds a form that can be left half-typed
   * or a secret shown once. `topic` (profile by default) is the part it covers;
   * with no topic, `null` drops every check.
   */
  setDirtyCheck(check: (() => boolean) | null, topic?: UnsavedTopic): void;
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
  const checks = new Map<UnsavedTopic, () => boolean>();
  const dirtyTopic = (): UnsavedTopic | null =>
    TOPIC_ORDER.find((topic) => checks.get(topic)?.() === true) ?? null;
  /** Closes the open "discard unsaved changes?" prompt; null when none is open. */
  let closeUnsavedPrompt: (() => void) | null = null;
  return {
    setDirtyCheck: (check, topic) => {
      if (check !== null) checks.set(topic ?? "profile", check);
      else if (topic === undefined) checks.clear();
      else checks.delete(topic);
    },
    isDirty: () => dirtyTopic() !== null,
    blockedByUnsaved: (retry) => {
      const topic = dirtyTopic();
      if (topic === null) return false;
      if (closeUnsavedPrompt !== null) return true;
      closeUnsavedPrompt = confirmDiscardUnsaved({
        topic,
        signal,
        container: getContainer(),
        onDiscard: () => {
          checks.clear();
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
