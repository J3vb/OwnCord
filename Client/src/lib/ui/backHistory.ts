/**
 * The Back button, shared. The Android app maps Back to the webview's history,
 * so every panel that should close on Back needs a history entry to consume,
 * and two modules pushing their own would fight over which one a Back pops.
 *
 * This module owns the one entry. Anything that wants Back claims it
 * (`claimBack`); a Back closes the claim made last, so the order is simply the
 * order things opened in: a sheet over a dialog over the drawer. Claims share
 * the entry, so a chain of sheets handing over to each other pushes one.
 *
 * The Android app also keeps the entry while nothing is open (`holdBackGuard`):
 * with it, Back on a chat has something to pop and lands in the guard's own
 * action (opening the drawer) instead of leaving the app. While the guard is
 * off there is no entry, so the next Back leaves the app.
 *
 * Our own `history.back()` is counted, and its popstate is ours, never a user's.
 * A claim made while one is on its way waits for it, so the entry it pushes is
 * not the one that pending Back pops. The listener for a user's Back exists only
 * while something wants the entry.
 */

import { Disposable } from "../disposable";
import { registerSessionReset } from "../net/sessionRegistry";

const HISTORY_KEY = "owncordBack";

interface Claim {
  readonly onBack: () => void;
}

export interface BackClaim {
  /** Give the claim up (the panel closed another way). Safe to repeat. */
  release(): void;
}

export interface BackGuard {
  /** Hold the entry while nothing is open (on) or let the next Back leave (off). */
  setActive(active: boolean): void;
  release(): void;
}

const claims: Claim[] = [];
let guard: { readonly onBack: () => void; active: boolean } | null = null;
/** Whether the history entry on top is the one this module pushed. */
let entryOnTop = false;
/** Our own history.back() calls whose popstate has not arrived yet. */
let popsPending = 0;
let listener: Disposable | null = null;

// Module lifetime: a claim or guard from the old server never outlives a switch.
void registerSessionReset("backHistory:claims", () => {
  claims.length = 0;
  guard = null;
  reconcile();
});

function onOurEntry(): boolean {
  const state: unknown = history.state;
  return typeof state === "object" && state !== null && HISTORY_KEY in state;
}

function wantsEntry(): boolean {
  return claims.length > 0 || guard?.active === true;
}

/** Push or pop the entry so it exists exactly while something wants it. */
function reconcile(): void {
  if (popsPending === 0) {
    const want = wantsEntry();
    if (want && !entryOnTop) {
      history.pushState({ [HISTORY_KEY]: true }, "");
      entryOnTop = true;
    } else if (!want && entryOnTop) {
      entryOnTop = false;
      popsPending += 1;
      window.addEventListener("popstate", onOwnPop, { once: true });
      history.back();
    }
  }
  syncListener();
}

/** The listener for user Backs: on while something wants the entry. */
function syncListener(): void {
  if (wantsEntry() && listener === null) {
    const owner = new Disposable();
    window.addEventListener("popstate", onUserPop, { signal: owner.signal });
    listener = owner;
  } else if (!wantsEntry() && listener !== null) {
    listener.destroy();
    listener = null;
  }
}

/** Popstates our own back already accounted for, whichever listener ran first. */
const ours = new WeakSet<Event>();

function onOwnPop(e: Event): void {
  ours.add(e);
  popsPending -= 1;
  // Whatever changed while the back was on its way can go on now.
  reconcile();
}

function onUserPop(e: Event): void {
  if (popsPending > 0 || ours.has(e)) return;
  // Still on an entry of ours (a push that landed late): nothing was popped.
  if (!entryOnTop || onOurEntry()) return;
  entryOnTop = false;
  const top = claims.pop();
  if (top !== undefined) top.onBack();
  else if (guard?.active === true) guard.onBack();
  reconcile();
}

/**
 * Claim the Back button until `release()` or `signal` aborts. A Back calls
 * `onBack` on the most recent claim, after dropping it; `onBack` closes the
 * panel and must not rely on a later `release()` to do so.
 */
export function claimBack(onBack: () => void, signal?: AbortSignal): BackClaim {
  const claim: Claim = { onBack };
  const release = (): void => {
    const index = claims.indexOf(claim);
    if (index === -1) return;
    claims.splice(index, 1);
    reconcile();
  };
  if (signal?.aborted === true) return { release };
  claims.push(claim);
  signal?.addEventListener("abort", release, { once: true });
  reconcile();
  return { release };
}

/**
 * Keep the entry while nothing is claimed, so a Back with nothing open runs
 * `onBack` instead of leaving. One guard at a time; it starts off.
 */
export function holdBackGuard(onBack: () => void, signal: AbortSignal): BackGuard {
  const mine = { onBack, active: false };
  const release = (): void => {
    if (guard !== mine) return;
    guard = null;
    reconcile();
  };
  if (signal.aborted) return { setActive: () => undefined, release };
  guard = mine;
  signal.addEventListener("abort", release, { once: true });
  return {
    setActive(active: boolean): void {
      if (guard !== mine || mine.active === active) return;
      mine.active = active;
      reconcile();
    },
    release,
  };
}
