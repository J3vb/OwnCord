/**
 * The Moderation Center destination (B9-11, Q2): what the shell imports. The
 * queue and its evidence load on first open, so they stay out of the MainPage
 * chunk, and nothing is read until a MODERATE_MEMBERS holder opens it.
 */

import { createElement } from "@lib/dom";
import type { FeatureViewContext } from "../navigation/destinations";

/** The moderation destination's view builder (navigation/destinations.ts). */
export function buildModerationCenter(ctx: FeatureViewContext): HTMLElement {
  const root = createElement("div", { class: "mod-center", "data-testid": "mod-center" });
  import("./Queue").then(
    ({ renderModerationCenter }) => {
      if (!ctx.signal.aborted) renderModerationCenter(root, ctx);
    },
    // The view could not load: go back rather than leave an empty view open.
    () => {
      if (!ctx.signal.aborted) ctx.close();
    },
  );
  return root;
}
