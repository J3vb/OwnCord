/**
 * The voice widget's share card while you share: loaded on the first share,
 * dropped when it ends. Inline (Classic, the phone layout) the card shows
 * above the call controls and the share button stops the share. Under Deck on
 * a desktop the card is a popover over the share button, which opens and
 * closes it while the share runs; Stop sharing is in the card. The preview in
 * a closed popover plays nothing.
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
  /** The top the popover sits above (the status bar). */
  readonly base?: () => Element | null;
  /** Told whenever the card opens or closes, to redraw the button. */
  readonly onChange: () => void;
}

export interface StreamCardHost {
  /** Load, redraw or drop the card as the share is live or not. */
  sync(sharing: boolean): void;
  /** The share button's press: the card's popover while it has one, else
   *  the share itself (start, or stop where the card is inline). From the
   *  keyboard, an opened card takes the focus. */
  press(viaKeyboard?: boolean): void;
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

  /** The card goes. Where it held the focus (Stop pressed inside it), the
   *  focus goes back to the share button rather than to the page. */
  function drop(): void {
    load++;
    const active = document.activeElement;
    const hadFocus = active !== null && card?.el.contains(active) === true;
    scope?.destroy();
    scope = null;
    card?.el.remove();
    card = null;
    popover = null;
    if (hadFocus) options.button()?.focus();
  }

  /** Inline the card is always on screen; as a popover only while open. */
  function refreshShown(): void {
    card?.setShown(!opensCard() || popover?.isOpen() === true);
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
        base: options.base,
        onChange: () => {
          refreshShown();
          options.onChange();
        },
        onModeChange: () => {
          refreshShown();
          options.onChange();
        },
      });
    }
    refreshShown();
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
      refreshShown();
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
    press(viaKeyboard = false) {
      if (opensCard()) popover?.toggle(viaKeyboard);
      else options.toggleShare();
    },
    destroy: drop,
  };
}
