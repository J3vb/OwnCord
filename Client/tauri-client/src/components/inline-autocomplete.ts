/**
 * inline-autocomplete — the shared listbox the composer opens over the textarea
 * for "@" mentions and ":" emoji. Both popups are the same widget: a filtered,
 * keyboard-navigable list whose rows are chosen on mousedown (never click, so
 * the textarea keeps focus). Only the suggestion source, the row contents, and
 * a couple of flags differ, so those are injected and everything else — arrow
 * navigation, Enter/Tab/Escape handling, AbortController cleanup — lives here
 * once instead of being duplicated in each popup.
 *
 * Uses @lib/dom helpers exclusively. Never sets innerHTML with user content.
 */

import { createElement, clearChildren, appendChildren } from "@lib/dom";

export interface InlineAutocompleteConfig<T> {
  /**
   * CSS class(es) on the root element. Mentions use `"mention-autocomplete"`;
   * emoji use `"mention-autocomplete emoji-autocomplete"` (sharing the base
   * class deliberately — a composer test selects
   * `.mention-autocomplete:not(.emoji-autocomplete)` to tell them apart).
   */
  readonly rootClass: string;
  /** `data-testid` on the root element. */
  readonly rootTestId: string;
  /** Suggestions for the text typed after the trigger, already ordered/capped. */
  readonly filter: (query: string) => T[];
  /** The value passed to onSelect when a row is chosen (token / insert text). */
  readonly valueOf: (item: T) => string;
  /** `data-testid` for one row. */
  readonly rowTestId: (item: T) => string;
  /** The children of one row (name/detail spans, an optional preview, …). */
  readonly renderRow: (item: T) => readonly HTMLElement[];
  /**
   * When true, prime the list with `setQuery("")` on creation so the popup
   * opens already populated (mentions list every member; emoji stay empty
   * until the composer types past the minimum query).
   */
  readonly primeOnCreate?: boolean;
  /** Called with `valueOf(picked)` when a row is chosen. */
  readonly onSelect: (value: string) => void;
  /** Called when the user dismisses the popup (Escape). */
  readonly onClose: () => void;
}

export interface InlineAutocompleteComponent {
  readonly element: HTMLDivElement;
  /**
   * Re-filter for `query`. Returns false when nothing matches, which the
   * composer treats as "close the popup" rather than leaving an empty box.
   */
  setQuery(query: string): boolean;
  /** Handle a composer keydown. Returns true when the key was consumed. */
  handleKeydown(e: KeyboardEvent): boolean;
  destroy(): void;
}

export function createInlineAutocomplete<T>(
  cfg: InlineAutocompleteConfig<T>,
): InlineAutocompleteComponent {
  const ac = new AbortController();
  const signal = ac.signal;

  let suggestions: T[] = [];
  let activeIndex = 0;

  const root = createElement("div", {
    class: cfg.rootClass,
    role: "listbox",
    "data-testid": cfg.rootTestId,
  });
  const list = createElement("div", { class: "ma-list" });
  root.appendChild(list);

  function choose(index: number): void {
    const picked = suggestions[index];
    if (picked === undefined) return;
    cfg.onSelect(cfg.valueOf(picked));
  }

  function render(): void {
    clearChildren(list);
    for (let i = 0; i < suggestions.length; i++) {
      const s = suggestions[i]!;
      const row = createElement("div", {
        class: i === activeIndex ? "ma-item ma-item--active" : "ma-item",
        role: "option",
        "aria-selected": i === activeIndex ? "true" : "false",
        "data-testid": cfg.rowTestId(s),
      });
      appendChildren(row, ...cfg.renderRow(s));
      // mousedown, not click: the textarea must not lose focus before the
      // insertion runs.
      row.addEventListener(
        "mousedown",
        (e: MouseEvent) => {
          e.preventDefault();
          choose(i);
        },
        { signal },
      );
      list.appendChild(row);
    }
  }

  function setQuery(query: string): boolean {
    suggestions = cfg.filter(query);
    activeIndex = 0;
    render();
    return suggestions.length > 0;
  }

  function handleKeydown(e: KeyboardEvent): boolean {
    if (suggestions.length === 0) return false;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        activeIndex = (activeIndex + 1) % suggestions.length;
        render();
        return true;
      case "ArrowUp":
        e.preventDefault();
        activeIndex = (activeIndex - 1 + suggestions.length) % suggestions.length;
        render();
        return true;
      case "Enter":
      case "Tab":
        e.preventDefault();
        choose(activeIndex);
        return true;
      case "Escape":
        e.preventDefault();
        cfg.onClose();
        return true;
      default:
        return false;
    }
  }

  function destroy(): void {
    ac.abort();
    root.remove();
  }

  if (cfg.primeOnCreate === true) setQuery("");

  return { element: root, setQuery, handleKeydown, destroy };
}
