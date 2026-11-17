// A single choice shown as a grid of cards: icon, name and a one-line
// description each. It is a radio group: one tab stop on the checked card,
// arrow keys move the choice (wrapping, as native radios do), and the checked
// card shows a filled dot as well as its accent border, so colour is never
// the only signal. A narrow window shows the cards as names only, with the
// checked card's description in one line under the group.
//
// The tile layout puts a drawn preview over each name instead of an icon and a
// description; the checked tile shows a ring and a check mark by its name.
import { appendChildren, createElement } from "../dom";
import { createIcon, type IconName } from "../icons";

export interface RadioCardOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly description?: string;
  readonly icon?: IconName;
  /** A decorative picture of the choice, shown over the name (tile layout). */
  readonly preview?: HTMLElement;
}

export interface RadioCardsOptions<T extends string> {
  readonly signal: AbortSignal;
  /** Id of the visible element that names the group. */
  readonly labelledBy: string;
  /** data-testid of the group; each card is `<testId>-<value>`. */
  readonly testId: string;
  readonly options: readonly RadioCardOption<T>[];
  /** The checked choice; null checks none, and the first card takes the tab stop. */
  readonly value: T | null;
  /** "tiles": previews in a wrapping row. Default: icon cards in two columns. */
  readonly layout?: "cards" | "tiles";
  readonly onChange?: (value: T) => void;
}

/** V is T when the group starts checked, and T | null when it may start empty. */
export interface RadioCards<T extends string, V extends T | null = T> {
  /** The group with its description line; mount this. */
  readonly el: HTMLDivElement;
  /** The radiogroup itself. */
  readonly group: HTMLDivElement;
  value(): V;
}

const NEXT_KEYS: ReadonlySet<string> = new Set(["ArrowRight", "ArrowDown"]);
const PREV_KEYS: ReadonlySet<string> = new Set(["ArrowLeft", "ArrowUp"]);

/** The index a key moves the choice to, or null for a key that does not move it. */
function keyTarget(key: string, from: number, count: number): number | null {
  if (NEXT_KEYS.has(key)) return (from + 1) % count;
  if (PREV_KEYS.has(key)) return (from - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

function buildCard<T extends string>(
  option: RadioCardOption<T>,
  testId: string,
): HTMLButtonElement {
  const card = createElement("button", {
    class: "radio-card",
    type: "button",
    role: "radio",
    "aria-checked": "false",
    tabindex: "-1",
    "data-value": option.value,
    "data-testid": `${testId}-${option.value}`,
  });
  const text = createElement("span", { class: "radio-card-text" });
  const label = createElement("span", { class: "radio-card-label" }, option.label);
  if (option.preview !== undefined) {
    // Tile: the picture, then the name led by a check mark when checked.
    const preview = createElement("span", { class: "radio-card-preview", "aria-hidden": "true" });
    const check = createElement("span", { class: "radio-card-check", "aria-hidden": "true" });
    preview.appendChild(option.preview);
    check.appendChild(createIcon("check", 14));
    appendChildren(text, check, label);
    appendChildren(card, preview, text);
    return card;
  }
  if (option.icon !== undefined) {
    const icon = createElement("span", { class: "radio-card-icon", "aria-hidden": "true" });
    icon.appendChild(createIcon(option.icon, 20));
    card.appendChild(icon);
  }
  text.appendChild(label);
  if (option.description !== undefined) {
    text.appendChild(createElement("span", { class: "radio-card-desc" }, option.description));
  }
  const dot = createElement("span", { class: "radio-card-dot", "aria-hidden": "true" });
  appendChildren(card, text, dot);
  return card;
}

export function createRadioCards<T extends string>(
  opts: RadioCardsOptions<T> & { readonly value: T },
): RadioCards<T>;
export function createRadioCards<T extends string>(
  opts: RadioCardsOptions<T>,
): RadioCards<T, T | null>;
export function createRadioCards<T extends string>(
  opts: RadioCardsOptions<T>,
): RadioCards<T, T | null> {
  const tiles = opts.layout === "tiles";
  const el = createElement("div", {
    class: tiles ? "radio-cards-wrap radio-cards-tiles" : "radio-cards-wrap",
  });
  const group = createElement("div", {
    class: "radio-cards",
    role: "radiogroup",
    "aria-labelledby": opts.labelledBy,
    "data-testid": opts.testId,
  });
  // Each card already carries its description for assistive tech.
  const hint = createElement("div", { class: "radio-cards-hint", "aria-hidden": "true" });
  const cards = opts.options.map((option) => buildCard(option, opts.testId));
  const known = opts.options.some((o) => o.value === opts.value);
  // An unknown value falls back to the first card, as before; null stays empty.
  let current: T | null =
    known || opts.value === null ? opts.value : (opts.options[0]?.value ?? opts.value);

  const paint = (): void => {
    opts.options.forEach((option, i) => {
      const on = option.value === current;
      cards[i]?.setAttribute("aria-checked", String(on));
      // With nothing checked, the first card is the way in.
      const stop = on || (current === null && i === 0);
      cards[i]?.setAttribute("tabindex", stop ? "0" : "-1");
    });
    if (current === null) group.removeAttribute("data-value");
    else group.setAttribute("data-value", current);
    hint.textContent = opts.options.find((o) => o.value === current)?.description ?? "";
  };
  const choose = (index: number): void => {
    const option = opts.options[index];
    if (option === undefined) return;
    const changed = option.value !== current;
    current = option.value;
    paint();
    if (changed) opts.onChange?.(option.value);
  };

  cards.forEach((card, i) => {
    // A click does not focus a button everywhere (Safari), and arrow keys
    // start from the focused card.
    card.addEventListener(
      "click",
      () => {
        choose(i);
        card.focus();
      },
      { signal: opts.signal },
    );
  });
  group.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const from = cards.findIndex((card) => card === e.target);
      if (from === -1) return;
      // Enter and Space check the focused card, which matters when nothing
      // is checked yet and focus sits on an unchecked one.
      const to = e.key === "Enter" || e.key === " " ? from : keyTarget(e.key, from, cards.length);
      if (to === null) return;
      e.preventDefault();
      choose(to);
      cards[to]?.focus();
    },
    { signal: opts.signal },
  );

  appendChildren(group, ...cards);
  // Only a group whose cards describe themselves has a description line.
  if (opts.options.some((o) => o.description !== undefined)) appendChildren(el, group, hint);
  else el.appendChild(group);
  paint();
  return { el, group, value: () => current };
}
