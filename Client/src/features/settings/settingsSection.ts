// The one section pattern every Settings page shares: a small uppercase
// heading (an h2 under the page's h1) above a card that holds the section's
// rows, with a hairline between rows (styles: settings.css). The head row can
// carry a status pill or a button beside the heading.
import { createElement } from "@lib/dom";

export interface SettingsSectionOptions {
  readonly label: string;
  /** Attributes of the heading: an id to label by, a tabindex to focus it. */
  readonly headingAttrs?: Readonly<Record<string, string>>;
  /** Attributes of the section element (a test id, an extra class). */
  readonly attrs?: Readonly<Record<string, string>>;
  /** An element that already is the section's card; a plain one otherwise. */
  readonly card?: HTMLElement;
}

export interface SettingsSection {
  readonly el: HTMLElement;
  readonly head: HTMLDivElement;
  readonly heading: HTMLHeadingElement;
  readonly card: HTMLElement;
}

export function buildSettingsSection(opts: SettingsSectionOptions): SettingsSection {
  const { class: extra, ...attrs } = opts.attrs ?? {};
  const el = createElement("section", {
    ...attrs,
    class: extra === undefined ? "settings-section" : `settings-section ${extra}`,
  });
  const head = createElement("div", { class: "settings-section-head" });
  const heading = createElement(
    "h2",
    { ...opts.headingAttrs, class: "settings-section-label" },
    opts.label,
  );
  head.appendChild(heading);
  const card = opts.card ?? createElement("div", {});
  card.classList.add("settings-card");
  el.append(head, card);
  return { el, head, heading, card };
}
