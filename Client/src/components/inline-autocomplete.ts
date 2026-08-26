/**
 * inline-autocomplete — the shared listbox the composer opens over the textarea
 * for "@" mentions and ":" emoji. Both popups are the same widget: a filtered,
 * keyboard-navigable list whose rows are chosen on mousedown (never click, so
 * the textarea keeps focus). Only the suggestion source, the row contents, and
 * a couple of flags differ, so those are injected and everything else — arrow
 * navigation, Enter/Tab/Escape handling, AbortController cleanup — lives here
 * once instead of being duplicated in each popup.
 *
 * Accessibility-wise this is a WAI-ARIA combobox, not a menu: DOM focus stays
 * in the composer textarea the whole time (moving it into the list would stop
 * keystrokes from reaching the textarea, so the rows deliberately get no
 * roving tabindex) and the "focused" row is conveyed purely through
 * aria-activedescendant on the textarea, pointing at per-row ids stamped on
 * every render.
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
  /**
   * The composer control this popup completes for (the textarea). While the
   * popup exists it carries combobox semantics — role="combobox",
   * aria-autocomplete="list", aria-expanded="true", aria-controls={list id} —
   * plus aria-activedescendant tracking the active row; destroy() removes
   * them all again. DOM focus never moves here: it must stay in the textarea
   * so typing keeps working, which is why the rows have no tabindex.
   */
  readonly comboboxInput?: HTMLElement;
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

/** The combobox state a popup stamps on its input, removed again on destroy. */
const COMBOBOX_ATTRS = [
  "role",
  "aria-autocomplete",
  "aria-expanded",
  "aria-controls",
  "aria-activedescendant",
] as const;

export function createInlineAutocomplete<T>(
  cfg: InlineAutocompleteConfig<T>,
): InlineAutocompleteComponent {
  const ac = new AbortController();
  const signal = ac.signal;

  let suggestions: T[] = [];
  let activeIndex = 0;

  // The testid is already unique per widget, so it doubles as a stable DOM id
  // for aria-controls / aria-activedescendant to point at.
  const rootId = cfg.rootTestId;

  const root = createElement("div", {
    class: cfg.rootClass,
    id: rootId,
    role: "listbox",
    "data-testid": cfg.rootTestId,
  });
  const list = createElement("div", { class: "ma-list" });
  root.appendChild(list);

  const input = cfg.comboboxInput ?? null;
  if (input !== null) {
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    // The popup only exists while it is open (the composer destroys it to
    // close), so "expanded" holds for this component's whole lifetime.
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-controls", rootId);
  }

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
        id: `${rootId}-option-${i}`,
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
    // Rows are rebuilt with index-based ids, so the pointer must be re-aimed
    // on every render, not just when activeIndex moves.
    if (input !== null) {
      if (suggestions.length > 0) {
        input.setAttribute("aria-activedescendant", `${rootId}-option-${activeIndex}`);
      } else {
        input.removeAttribute("aria-activedescendant");
      }
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
    // Another popup may have claimed the input between this one's open and
    // close (the composer opens the mention popup before closing the emoji
    // one), so only strip the combobox state while it still points here.
    if (input !== null && input.getAttribute("aria-controls") === rootId) {
      for (const attr of COMBOBOX_ATTRS) input.removeAttribute(attr);
    }
    root.remove();
  }

  if (cfg.primeOnCreate === true) setQuery("");

  return { element: root, setQuery, handleKeydown, destroy };
}
