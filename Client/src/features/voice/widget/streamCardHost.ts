/**
 * The voice widget's share card while you share: loaded on the first share,
 * dropped when it ends. Inline (Classic, the phone layout) the card shows
 * above the call controls and the share button stops the share. Under Deck on
 * a desktop the card is a popover over the share button, which opens and
 * closes it while the share runs; Stop sharing is in the card.
 *
 * The card, its popover and every listener of theirs share one scope, so a
 * share that ends while its card is open (stopped elsewhere, the shared window
 * closed) takes the open card down with it and the button back to its plain
 * state.
 */
import { Disposable } from "@lib/disposable";
import type { StreamCard } from "../voiceWidget/streamCard";
import { createDeckPopover, isDeckPopoverMode, type DeckPopover } from "./deckPopover";

export interface StreamCardHostOptions {
  /** Where the card goes, and the element it goes before (the controls). */
  readonly place: () => { parent: HTMLElement; before: Element } | null;
  /** The share button the popover hangs from. */
  readonly button: () => HTMLButtonElement | null;
  /** Starts or stops the share (the card's Stop, the button inline). */
  readonly toggleShare: () => void;
  /** Told whenever the card opens or closes, to redraw the button. */
  readonly onChange: () => void;
}

export interface StreamCardHost {
  /** Load, redraw or drop the card as the share is live or not. */
  sync(sharing: boolean): void;
  /** The share button's press: the card's popover while it has one, else
   *  the share itself (start, or stop where the card is inline). */
  press(): void;
  /** Whether the share button now opens the card rather than stopping. */
  opensCard(): boolean;
  destroy(): void;
}

export function createStreamCardHost(options: StreamCardHostOptions): StreamCardHost {
  let card: StreamCard | null = null;
  let popover: DeckPopover | null = null;
  /** Owns the current card's listeners; ended when the card goes. */
  let scope: Disposable | null = null;
  /** Bumped on every drop, so a load that lands late stays out. */
  let load = 0;

  function drop(): void {
    load++;
    scope?.destroy();
    scope = null;
    card?.el.remove();
    card = null;
    popover = null;
  }

  function attach(created: (onStop: () => void, signal: AbortSignal) => StreamCard): void {
    const spot = options.place();
    const button = options.button();
    if (spot === null) return;
    scope = new Disposable();
    card = created(options.toggleShare, scope.signal);
    spot.parent.insertBefore(card.el, spot.before);
    if (button !== null) {
      popover = createDeckPopover({
        panel: card.el,
        anchor: button,
        openClass: "vw-pop--open",
        inlineToggle: false,
        signal: scope.signal,
        onChange: options.onChange,
      });
    }
    options.onChange();
  }

  function sync(sharing: boolean): void {
    if (!sharing) {
      const had = card !== null;
      drop();
      if (had) options.onChange();
      return;
    }
    if (card !== null) {
      card.update();
      popover?.sync();
      return;
    }
    const ticket = ++load;
    void import("../voiceWidget/streamCard").then(({ createStreamCard }) => {
      if (ticket === load && card === null) attach(createStreamCard);
    });
  }

  function opensCard(): boolean {
    return popover !== null && isDeckPopoverMode();
  }

  return {
    sync,
    opensCard,
    press() {
      if (opensCard()) popover?.toggle();
      else options.toggleShare();
    },
    destroy: drop,
  };
}
