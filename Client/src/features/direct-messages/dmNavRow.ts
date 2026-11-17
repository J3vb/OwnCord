/**
 * The navigation rows at the top of DM mode ("People", "Message requests"):
 * an icon, a label and, for a row with a count, a red badge that hides at
 * zero. The row marks itself current while its content view is open.
 */
import { appendChildren, createElement, setText } from "@lib/dom";
import { createIcon, type IconName } from "@lib/icons";
import { formatBadgeCount } from "@lib/text/formatting";
import { trackCurrentView } from "../navigation/contentView";
import type { ContentViewId, CountSource } from "../navigation/destinations";

export interface DmNavRowOptions {
  readonly testId: string;
  readonly icon: IconName;
  readonly label: string;
  readonly view: ContentViewId;
  readonly onOpen: (opener: HTMLElement) => void;
  /** A live count for the badge; the row's accessible name then carries it. */
  readonly count?: CountSource;
  readonly countLabel?: (count: number) => string;
}

/** Build one row; every subscription it makes goes on `unsubs`. */
export function createDmNavRow(
  opts: DmNavRowOptions,
  unsubs: Array<() => void>,
): HTMLButtonElement {
  const row = createElement("button", {
    type: "button",
    class: "dm-nav-row",
    "data-testid": opts.testId,
  });
  const icon = createIcon(opts.icon, 20);
  icon.classList.add("dm-nav-row-icon");
  const label = createElement("span", { class: "dm-nav-row-label" }, opts.label);
  appendChildren(row, icon, label);
  row.addEventListener("click", () => opts.onOpen(row));
  unsubs.push(trackCurrentView(row, opts.view));

  const source = opts.count;
  if (source !== undefined) {
    const badge = createElement("span", {
      class: "dm-header-unread-badge",
      "aria-hidden": "true",
      "data-testid": `${opts.testId}-badge`,
    });
    row.appendChild(badge);
    const render = (): void => {
      const count = source.get();
      badge.hidden = count === 0;
      setText(badge, count === 0 ? "" : formatBadgeCount(count));
      if (count > 0 && opts.countLabel !== undefined) {
        row.setAttribute("aria-label", opts.countLabel(count));
      } else {
        row.removeAttribute("aria-label");
      }
    };
    render();
    unsubs.push(source.subscribe(render));
  }
  return row;
}
