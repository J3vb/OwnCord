// A single choice shown as a grid of cards: icon, name and a one-line
// description each. It is a radio group: one tab stop on the checked card,
// arrow keys move the choice (wrapping, as native radios do), and the checked
// card shows a filled dot as well as its accent border, so colour is never
// the only signal. A narrow window shows the cards as names only, with the
// checked card's description in one line under the group.
import { appendChildren, createElement } from "../dom";
import { createIcon, type IconName } from "../icons";

export interface RadioCardOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly description: string;
  readonly icon: IconName;
}

export interface RadioCardsOptions<T extends string> {
  readonly signal: AbortSignal;
  /** Id of the visible element that names the group. */
  readonly labelledBy: string;
  /** data-testid of the group; each card is `<testId>-<value>`. */
  readonly testId: string;
  readonly options: readonly RadioCardOption<T>[];
  readonly value: T;
  readonly onChange?: (value: T) => void;
}

export interface RadioCards<T extends string> {
  /** The group with its description line; mount this. */
  readonly el: HTMLDivElement;
  /** The radiogroup itself. */
  readonly group: HTMLDivElement;
  value(): T;
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
  const icon = createElement("span", { class: "radio-card-icon", "aria-hidden": "true" });
  icon.appendChild(createIcon(option.icon, 20));
  const text = createElement("span", { class: "radio-card-text" });
  appendChildren(
    text,
    createElement("span", { class: "radio-card-label" }, option.label),
    createElement("span", { class: "radio-card-desc" }, option.description),
  );
  const dot = createElement("span", { class: "radio-card-dot", "aria-hidden": "true" });
  appendChildren(card, icon, text, dot);
  return card;
}

export function createRadioCards<T extends string>(opts: RadioCardsOptions<T>): RadioCards<T> {
  const el = createElement("div", { class: "radio-cards-wrap" });
  const group = createElement("div", {
    class: "radio-cards",
    role: "radiogroup",
    "aria-labelledby": opts.labelledBy,
    "data-testid": opts.testId,
  });
  // Each card already carries its description for assistive tech.
  const hint = createElement("div", { class: "radio-cards-hint", "aria-hidden": "true" });
  const cards = opts.options.map((option) => buildCard(option, opts.testId));
  const fallback = opts.options[0]?.value ?? opts.value;
  let current: T = opts.options.some((o) => o.value === opts.value) ? opts.value : fallback;

  const paint = (): void => {
    opts.options.forEach((option, i) => {
      const on = option.value === current;
      cards[i]?.setAttribute("aria-checked", String(on));
      cards[i]?.setAttribute("tabindex", on ? "0" : "-1");
    });
    group.setAttribute("data-value", current);
    hint.textContent = opts.options.find((o) => o.value === current)?.description ?? "";
  };
  const choose = (index: number): void => {
    const option = opts.options[index];
    if (option === undefined) return;
    const changed = option.value !== current;
    current = option.value;
    paint();
    if (changed) opts.onChange?.(current);
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
      const to = keyTarget(e.key, from, cards.length);
      if (to === null) return;
      e.preventDefault();
      choose(to);
      cards[to]?.focus();
    },
    { signal: opts.signal },
  );

  appendChildren(group, ...cards);
  appendChildren(el, group, hint);
  paint();
  return { el, group, value: () => current };
}
