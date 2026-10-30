/**
 * Who-reacted tooltip — hovering a reaction pill names the people behind the
 * count.
 *
 * The reactor list itself (fetch, cache, invalidation) lives in
 * `features/messaging/reactionUsers.ts`, below the UI layer, so the messaging
 * `reaction_update` handler can invalidate it without importing this component.
 * This module renders the tooltip and wires the hover that triggers the load.
 *
 * Hover is debounced 300ms: a pointer crossing a row of pills must not fire a
 * request per pill.
 */

import { createElement, setText, appendChildren } from "@lib/dom";
import { membersStore, memberDisplayName } from "@stores/members.store";
import type { ReactionUser } from "@lib/types";
import { messageStatusText } from "../../i18n/messageStatus";
import { loadReactionUsers } from "../../features/messaging/reactionUsers";

/** Debounce before the hover turns into a fetch + tooltip. */
export const REACTION_TOOLTIP_DEBOUNCE_MS = 300;

/** How many names are spelled out before collapsing into "and N others". */
const MAX_NAMES = 3;

/** "A, B and C" — no Oxford comma, matching the existing phrasing. The list
 *  separator is locale-owned formatting, not app copy, so it stays a locale
 *  constant rather than a catalog entry; the English output is unchanged. */
const LIST_LOCALE = "en-GB";
const listFormatter = new Intl.ListFormat(LIST_LOCALE, { type: "conjunction" });

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
    return messageStatusText("reaction.others", {
      count: others,
      n: String(others),
      names: shown.join(", "),
    });
  }
  return listFormatter.format(shown);
}

// ---------------------------------------------------------------------------
// Tooltip DOM
// ---------------------------------------------------------------------------

/** Build the tooltip body. Names resolve through memberDisplayName — the
 *  nickname when the members store has the reactor, the raw username
 *  otherwise (a reactor who has since left, or whose member row has not
 *  loaded yet) — matching the member list, typing indicator, voice roster
 *  and message rows. Text only — names are user-controlled, so they go in
 *  via textContent, never markup. */
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
      users.map((u) => {
        const member = membersStore.getState().members.get(u.id);
        return member !== undefined ? memberDisplayName(member) : u.username;
      }),
      totalCount,
    ),
  );
  const reacted = createElement("span", { class: "reaction-tooltip-emoji" });
  setText(reacted, messageStatusText("reaction.reactedWith", { emoji }));
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
