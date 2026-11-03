/**
 * The People destination: what the shell imports. The view itself loads on
 * first open, so it stays out of the MainPage chunk.
 */

import { createElement } from "@lib/dom";
import { peopleHomeText as t } from "../../i18n/peopleHome";
import type { FeatureViewContext } from "../navigation/destinations";

/** The People destination's view builder (navigation/destinations.ts). */
export function buildPeopleHome(ctx: FeatureViewContext): HTMLElement {
  const root = createElement("div", { class: "people-home", "data-testid": "people-home" });
  // The view could not load or draw: say so, and the header's Close still works.
  const failed = (): void => {
    if (ctx.signal.aborted) return;
    root.replaceChildren(
      createElement("p", { class: "member-list-empty-text people-empty" }, t("loadFailed")),
    );
  };
  import("./PeopleHome").then(({ renderPeopleHome }) => {
    if (ctx.signal.aborted) return;
    try {
      renderPeopleHome(root, ctx);
    } catch {
      failed();
    }
  }, failed);
  return root;
}
