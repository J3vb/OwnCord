/**
 * Phase B Step 6 — Solid.js mount helper.
 *
 * Wraps Solid's `render(...)` so a Solid component conforms to the
 * `{ mount, destroy }` factory contract used everywhere else in the vanilla
 * codebase. Existing container components can host a Solid leaf without
 * being aware of Solid at all:
 *
 *   import { mountSolid } from "@lib/solidMount";
 *   import { Badge } from "@components/solid/Badge";
 *
 *   const handle = mountSolid(() => Badge({ label: "online" }), parentEl);
 *   // …later
 *   handle.destroy();
 */

import { render, type JSX } from "solid-js/web";

export interface SolidMount {
  /** The DOM element the Solid root is rendered into. */
  el: HTMLElement;
  /** Tear the Solid root down and remove it from the DOM. */
  destroy(): void;
}

export function mountSolid(component: () => JSX.Element, parent: HTMLElement): SolidMount {
  const host = document.createElement("div");
  host.dataset.solidRoot = "true";
  parent.appendChild(host);
  const dispose = render(component, host);
  return {
    el: host,
    destroy() {
      dispose();
      host.remove();
    },
  };
}
