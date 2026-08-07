/**
 * Who-reacted tooltip — hovering a reaction pill names the people behind the
 * count.
 *
 * The reactor list is not part of the message payload (a page of chat carries
 * dozens of pills and almost none are ever hovered), so it is fetched on demand
 * from GET /channels/{id}/messages/{messageId}/reactions/{emoji}/users and
 * cached per message+emoji. The cache is invalidated by `reaction_update` for
 * that message, which is the only event that can change the answer.
 *
 * Hover is debounced 300ms, mirroring lib/streamPreview.ts: a pointer crossing
 * a row of pills must not fire a request per pill.
 */

import { createElement, setText, appendChildren } from "@lib/dom";
import { createLogger } from "@lib/logger";
import type { ReactionUser } from "@lib/types";

const log = createLogger("reaction-tooltip");

/** Debounce before the hover turns into a fetch + tooltip. */
export const REACTION_TOOLTIP_DEBOUNCE_MS = 300;

/** How many names are spelled out before collapsing into "and N others". */
const MAX_NAMES = 3;

// ---------------------------------------------------------------------------
// Fetcher injection
// ---------------------------------------------------------------------------

export type ReactionUsersFetcher = (
  channelId: number,
  messageId: number,
  emoji: string,
) => Promise<readonly ReactionUser[]>;

let fetcher: ReactionUsersFetcher | null = null;

/**
 * Register the transport used to fetch reactor lists. Called once from
 * MainPage with the live ApiClient, the same way setServerHost is. Until it is
 * set, hovering a pill is a no-op rather than an error — the renderer is used
 * by tests and previews that have no server.
 */
export function setReactionUsersFetcher(next: ReactionUsersFetcher | null): void {
  fetcher = next;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/** NUL separator: the server rejects control characters in an emoji, so no
 *  emoji can contain it and no two (message, emoji) pairs can collide. */
function cacheKey(messageId: number, emoji: string): string {
  return `${messageId}\u0000${emoji}`;
}

/** Resolved reactor lists, keyed by message+emoji. */
const cache = new Map<string, readonly ReactionUser[]>();
/** In-flight requests, so a re-hover during the fetch does not duplicate it. */
const inFlight = new Map<string, Promise<readonly ReactionUser[] | null>>();

/**
 * Drop every cached reactor list for a message. Called from the `reaction_update`
 * dispatch: any add/remove on that message makes all of its lists stale, and
 * the event carries only the one emoji that changed, so scoping the eviction to
 * that emoji would leave the others silently wrong after a race.
 */
export function invalidateReactionUsers(messageId: number): void {
  // Deleting the key currently being visited is well-defined for a Map
  // iterator, so no snapshot of the key set is needed.
  const prefix = `${messageId}\u0000`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
  for (const key of inFlight.keys()) {
    if (key.startsWith(prefix)) inFlight.delete(key);
  }
}

/** Drop every cached reactor list (channel switch, logout, reconnect). */
export function clearReactionUsersCache(): void {
  cache.clear();
  inFlight.clear();
}

/** Cached reactor list for a message+emoji, or undefined when not fetched. */
export function getCachedReactionUsers(
  messageId: number,
  emoji: string,
): readonly ReactionUser[] | undefined {
  return cache.get(cacheKey(messageId, emoji));
}

/**
 * Reactor list for a message+emoji, from cache when present. Returns null when
 * there is no fetcher registered or the request failed — callers show nothing
 * rather than an error, since this is a hover affordance.
 */
export function loadReactionUsers(
  channelId: number,
  messageId: number,
  emoji: string,
): Promise<readonly ReactionUser[] | null> {
  const key = cacheKey(messageId, emoji);

  const cached = cache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);

  const existing = inFlight.get(key);
  if (existing !== undefined) return existing;

  const activeFetcher = fetcher;
  if (activeFetcher === null) return Promise.resolve(null);

  const promise = activeFetcher(channelId, messageId, emoji).then(
    (users) => {
      // A concurrent invalidation dropped this key: the response describes a
      // state that has already changed, so it must not repopulate the cache.
      if (inFlight.get(key) === promise) {
        cache.set(key, users);
      }
      return users;
    },
    (err: unknown) => {
      log.warn("failed to load reaction users", {
        messageId,
        emoji,
        error: String(err),
      });
      return null;
    },
  );

  inFlight.set(key, promise);
  void promise.finally(() => {
    if (inFlight.get(key) === promise) {
      inFlight.delete(key);
    }
  });

  return promise;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * "A", "A and B", "A, B and C", "A, B, C and 4 others".
 *
 * `totalCount` is the pill's count, which can exceed the fetched list (the
 * server caps it at 100) — the overflow phrasing is driven by it so a pill
 * reading 250 does not claim only 100 people reacted.
 */
export function formatReactorNames(
  usernames: readonly string[],
  totalCount = usernames.length,
): string {
  if (usernames.length === 0) return "";

  const total = Math.max(totalCount, usernames.length);
  const shown = usernames.slice(0, MAX_NAMES);
  const others = total - shown.length;

  if (others > 0) {
    return `${shown.join(", ")} and ${others} ${others === 1 ? "other" : "others"}`;
  }
  if (shown.length === 1) return shown[0]!;
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]!}`;
}

// ---------------------------------------------------------------------------
// Tooltip DOM
// ---------------------------------------------------------------------------

/** Build the tooltip body. Text only — usernames are user-controlled, so they
 *  go in via textContent, never markup. */
export function buildReactionTooltip(
  emoji: string,
  users: readonly ReactionUser[],
  totalCount: number,
): HTMLDivElement {
  const tip = createElement("div", {
    class: "reaction-tooltip",
    role: "tooltip",
    "data-testid": "reaction-tooltip",
  });
  const names = createElement("span", { class: "reaction-tooltip-names" });
  setText(
    names,
    formatReactorNames(
      users.map((u) => u.username),
      totalCount,
    ),
  );
  const reacted = createElement("span", { class: "reaction-tooltip-emoji" });
  setText(reacted, `reacted with ${emoji}`);
  appendChildren(tip, names, reacted);
  return tip;
}

// ---------------------------------------------------------------------------
// Hover wiring
// ---------------------------------------------------------------------------

export interface ReactionTooltipTarget {
  readonly channelId: number;
  readonly messageId: number;
  readonly emoji: string;
  /** The pill's displayed count, used for the "and N others" tail. */
  readonly count: number;
}

interface HoverState {
  timer: number;
  /** Bumped on every hide so a late fetch cannot show a stale tooltip. */
  generation: number;
}

const hoverStates = new WeakMap<HTMLElement, HoverState>();

/**
 * Chips currently mid-hover (debounce timer running or tooltip showing),
 * keyed by the message list's AbortSignal. A single abort listener per signal
 * hides whatever is in the set instead of registering a bare, never-removed
 * `abort` listener per chip on every render — the latter permanently pinned
 * every past chip (and, via parentNode, its whole detached row) in memory for
 * the rest of the channel visit. start()/stop() add/remove the chip, so the
 * set only ever holds the handful of chips actually being hovered.
 */
const hoveringChips = new WeakMap<AbortSignal, Set<HTMLElement>>();

function chipSetFor(signal: AbortSignal): Set<HTMLElement> {
  const existing = hoveringChips.get(signal);
  if (existing !== undefined) return existing;
  const set = new Set<HTMLElement>();
  hoveringChips.set(signal, set);
  signal.addEventListener(
    "abort",
    () => {
      for (const chip of set) hide(chip);
      set.clear();
    },
    { once: true },
  );
  return set;
}

function removeTooltip(chip: HTMLElement): void {
  chip.querySelector(".reaction-tooltip")?.remove();
}

function hide(chip: HTMLElement): void {
  const state = hoverStates.get(chip);
  if (state !== undefined) {
    clearTimeout(state.timer);
    state.generation += 1;
  }
  removeTooltip(chip);
}

/**
 * Attach who-reacted hover behaviour to a reaction pill. Listeners are removed
 * with the message list's AbortSignal; the debounce timer is cleared on
 * mouseleave/focusout and on abort.
 */
export function attachReactionTooltip(
  chip: HTMLElement,
  target: ReactionTooltipTarget,
  signal: AbortSignal,
): void {
  const show = (): void => {
    const state = hoverStates.get(chip);
    if (state === undefined) return;
    const generation = state.generation;

    void loadReactionUsers(target.channelId, target.messageId, target.emoji).then((users) => {
      if (users === null || users.length === 0) return;
      // The pointer left (or the row was rebuilt) while the fetch was in
      // flight — do not pop a tooltip nobody is hovering.
      const current = hoverStates.get(chip);
      if (current === undefined || current.generation !== generation) return;
      if (!chip.isConnected) return;
      removeTooltip(chip);
      chip.appendChild(buildReactionTooltip(target.emoji, [...users], target.count));
    });
  };

  const chips = chipSetFor(signal);

  const start = (): void => {
    hide(chip);
    const existing = hoverStates.get(chip);
    const generation = existing === undefined ? 0 : existing.generation;
    const timer = window.setTimeout(show, REACTION_TOOLTIP_DEBOUNCE_MS);
    hoverStates.set(chip, { timer, generation });
    chips.add(chip);
  };

  const stop = (): void => {
    chips.delete(chip);
    hide(chip);
  };

  chip.addEventListener("mouseenter", start, { signal });
  chip.addEventListener("mouseleave", stop, { signal });
  // Keyboard accessibility: focus mirrors hover.
  chip.addEventListener("focusin", start, { signal });
  chip.addEventListener("focusout", stop, { signal });
}
