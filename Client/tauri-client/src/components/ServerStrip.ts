/**
 * ServerStrip component — vertical strip on the far left showing server icons.
 * Single-server for now: Home button, separator, add server button.
 */

import { createElement, appendChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";

export function createServerStrip(): MountableComponent {
  const ac = new AbortController();
  let root: HTMLDivElement | null = null;

  function mount(container: Element): void {
    root = createElement("div", { class: "server-strip", "data-testid": "server-strip" });

    const homeIcon = createElement(
      "div",
      { class: "server-icon active", style: "background: var(--accent)" },
      "O",
    );

    const separator = createElement("div", { class: "server-separator" });

    const addIcon = createElement("div", { class: "server-icon add" }, "+");

    // Add server button click — placeholder for future multi-server support
    addIcon.addEventListener(
      "click",
      () => {
        // No-op for single-server mode
      },
      { signal: ac.signal },
    );

    appendChildren(root, homeIcon, separator, addIcon);
    container.appendChild(root);
  }

  function destroy(): void {
    ac.abort();
    if (root !== null) {
      root.remove();
      root = null;
    }
  }

  return { mount, destroy };
}
