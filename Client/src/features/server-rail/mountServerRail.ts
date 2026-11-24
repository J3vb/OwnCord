/** Loading the server rail into the page on demand. */

import { createElement } from "@lib/dom";
import { createLogger } from "@lib/logger";
import { switcherOptions, type ServerSwitcherDeps } from "./switcherOptions";

const log = createLogger("main-page");

/**
 * Classic's rail: appends its slot to `app`, marks `app` and loads the rail on
 * demand. The slot holds the rail's width while the rail's code loads, keeping
 * it out of the eager MainPage chunk.
 */
export function mountServerRail(app: HTMLElement, deps: ServerSwitcherDeps): HTMLDivElement | null {
  const slot = createElement("div", { class: "server-rail-slot" });
  app.classList.add("has-server-rail");
  app.appendChild(slot);
  void import("./ServerRail")
    .then(({ createServerRail }) => {
      if (deps.isTornDown()) return;
      const rail = createServerRail(switcherOptions(deps));
      rail.mount(slot);
      deps.own(() => rail.destroy?.());
    })
    .catch((err: unknown) => log.warn("Server rail failed to load", err));
  return slot;
}
