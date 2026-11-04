// The one settings row pattern: title and description on the left, the
// control on the right, a hairline between rows. A wide control (theme tiles,
// a slider with its value, a list) uses the stacked row: title over control.
// The single-choice control is a segmented row of radios that never wraps;
// when the pane is too narrow for it (styles: settings.css, container query on
// .settings-pane) the same choice shows as a <select> instead.
import { appendChildren, createElement } from "@lib/dom";
import { enableRovingNavigation, setRovingTabindex } from "@lib/ui/a11y";

export interface SettingRowOptions {
  readonly label: string;
  readonly desc?: string;
  readonly control: HTMLElement;
  /** Title over a full-width control instead of beside it. */
  readonly stacked?: boolean;
}

export function buildSettingRow(opts: SettingRowOptions): HTMLDivElement {
  const row = createElement("div", {
    class: opts.stacked === true ? "setting-row stacked" : "setting-row",
  });
  const info = createElement("div", { class: "setting-info" });
  info.appendChild(createElement("div", { class: "setting-label" }, opts.label));
  if (opts.desc !== undefined) {
    info.appendChild(createElement("div", { class: "setting-desc" }, opts.desc));
  }
  appendChildren(row, info, opts.control);
  return row;
}

export interface SegmentedOptions<T extends string> {
  readonly signal: AbortSignal;
  /** Accessible name of the group and the select. */
  readonly label: string;
  /** data-testid of the radiogroup; each radio is `<testId>-<value>`, the select `<testId>-select`. */
  readonly testId: string;
  readonly options: readonly (readonly [T, string])[];
  readonly current: () => T;
  readonly save: (value: T) => void;
}

export interface Segmented {
  readonly el: HTMLDivElement;
  /** Re-read `current` into both forms of the control. */
  paint(): void;
}

export function createSegmented<T extends string>(opts: SegmentedOptions<T>): Segmented {
  const el = createElement("div", { class: "segmented-wrap" });
  const group = createElement("div", {
    class: "level-options segmented",
    role: "radiogroup",
    "aria-label": opts.label,
    "data-testid": opts.testId,
  });
  const select = createElement("select", {
    class: "settings-select segmented-select",
    "aria-label": opts.label,
    "data-testid": `${opts.testId}-select`,
  });
  const buttons = new Map<T, HTMLButtonElement>();

  const paint = (): void => {
    const current = opts.current();
    for (const [value, button] of buttons) {
      const on = value === current;
      button.classList.toggle("active", on);
      button.setAttribute("aria-checked", String(on));
    }
    select.value = current;
  };
  const choose = (value: T): void => {
    opts.save(value);
    paint();
  };

  for (const [value, text] of opts.options) {
    const button = createElement(
      "button",
      {
        class: "level-opt",
        type: "button",
        role: "radio",
        "aria-checked": "false",
        tabindex: "-1",
        "data-testid": `${opts.testId}-${value}`,
        "data-value": value,
      },
      text,
    );
    button.addEventListener("click", () => choose(value), { signal: opts.signal });
    buttons.set(value, button);
    group.appendChild(button);
    select.appendChild(createElement("option", { value }, text));
  }
  select.addEventListener(
    "change",
    () => {
      const picked = opts.options.find(([value]) => value === select.value);
      if (picked !== undefined) choose(picked[0]);
    },
    { signal: opts.signal },
  );

  paint();
  setRovingTabindex(group, "[role='radio']");
  enableRovingNavigation(group, "[role='radio']", opts.signal);
  appendChildren(el, group, select);
  return { el, paint };
}

/** A setting row whose control is a segmented choice. */
export function buildChoiceRow<T extends string>(
  opts: SegmentedOptions<T> & { readonly desc?: string },
): { readonly row: HTMLDivElement; readonly paint: () => void } {
  const control = createSegmented(opts);
  const row = buildSettingRow({
    label: opts.label,
    ...(opts.desc !== undefined ? { desc: opts.desc } : {}),
    control: control.el,
  });
  return { row, paint: control.paint };
}
