/**
 * The People destination: what the shell imports. The view itself loads on
 * first open, so it stays out of the MainPage chunk.
 */

import { createElement } from "@lib/dom";
import type { FeatureViewContext } from "../navigation/destinations";

/** The People destination's view builder (navigation/destinations.ts). */
export function buildPeopleHome(ctx: FeatureViewContext): HTMLElement {
  const root = createElement("div", { class: "people-home", "data-testid": "people-home" });
  import("./PeopleHome").then(
    ({ renderPeopleHome }) => {
      if (!ctx.signal.aborted) renderPeopleHome(root, ctx);
    },
    // The view could not load: go back rather than leave an empty view open.
    () => {
      if (!ctx.signal.aborted) ctx.close();
    },
  );
  return root;
}
