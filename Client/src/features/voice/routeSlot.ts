/**
 * Where a control bar keeps its sound route button (speaker, earpiece,
 * headset). Only the Android app has one, and its module loads on first use.
 * The button hides itself where there is nothing to choose.
 */

import { createControlSlot, type ControlSlot } from "./controlSlot";
import type { RouteVariant } from "./routeButton";

export function createRouteSlot(variant: RouteVariant): ControlSlot {
  return createControlSlot("route", () =>
    import("./routeButton").then((m) => (signal) => m.createRouteButton(variant, signal)),
  );
}
