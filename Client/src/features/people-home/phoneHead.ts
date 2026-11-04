/**
 * The phone's Messages drawer head: a "Messages" title, a row with Search,
 * People and New message, and Active now across the top. Loaded on demand so
 * the MainPage chunk carries only the call that mounts it.
 */
import { appendChildren, createElement } from "@lib/dom";
import { createIcon, type IconName } from "@lib/icons";
import { navigationText } from "../../i18n/navigation";
import { peopleHomeText as t } from "../../i18n/peopleHome";
import { renderActiveStrip } from "./activeStrip";

export interface PhoneHeadOptions {
  readonly signal: AbortSignal;
  /** Opens or closes the conversation filter; answers whether it is open now. */
  readonly onSearch: () => boolean;
  /** Absent when the shell has no People destination. */
  readonly onPeople?: (opener: HTMLElement) => void;
  /** Keeps the People button's aria-current in step with the open view. */
  readonly trackPeople?: (el: HTMLElement) => () => void;
  readonly onNew: () => void;
  readonly onOpenUser: (userId: number) => void;
}

function button(cls: string, testId: string, icon: IconName, label?: string): HTMLButtonElement {
  const btn = createElement("button", {
    type: "button",
    class: `dm-phone-btn ${cls}`,
    "data-testid": testId,
  });
  if (label !== undefined) {
    btn.setAttribute("aria-label", label);
    btn.title = label;
  }
  const svg = createIcon(icon, 20);
  svg.setAttribute("aria-hidden", "true");
  btn.appendChild(svg);
  return btn;
}

export function renderPhoneHead(head: HTMLElement, opts: PhoneHeadOptions): void {
  const { signal } = opts;
  const actions = createElement("div", { class: "dm-phone-actions" });

  const search = button("dm-phone-search", "dm-phone-search", "search", t("phone.search"));
  search.setAttribute("aria-expanded", "false");
  search.addEventListener(
    "click",
    () => search.setAttribute("aria-expanded", String(opts.onSearch())),
    { signal },
  );
  actions.appendChild(search);

  const onPeople = opts.onPeople;
  if (onPeople !== undefined) {
    const people = button("dm-phone-people", "dm-phone-people", "users");
    people.appendChild(createElement("span", {}, navigationText("people.title")));
    people.addEventListener("click", () => onPeople(people), { signal });
    const untrack = opts.trackPeople?.(people);
    if (untrack !== undefined) signal.addEventListener("abort", untrack, { once: true });
    actions.appendChild(people);
  }

  const add = button("dm-phone-plus", "dm-phone-new", "plus", t("phone.new"));
  add.addEventListener("click", () => opts.onNew(), { signal });
  actions.appendChild(add);

  const strip = createElement("ul", {
    class: "dm-active-strip",
    "aria-label": t("active.title"),
    "data-testid": "dm-active-strip",
  });
  appendChildren(
    head,
    createElement("h2", { class: "dm-phone-title" }, t("phone.title")),
    actions,
    strip,
  );
  renderActiveStrip(strip, { signal, onOpen: opts.onOpenUser });
}
