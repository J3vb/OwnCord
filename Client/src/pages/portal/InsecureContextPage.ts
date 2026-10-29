// The web portal's page for a browser context that is not secure:
// one notice, no form. The browser platform keeps its credential, network and
// storage adapters inert there, so nothing on this page may reach them.

import { createElement, appendChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import { portalText } from "../../i18n/portal";

export function createInsecureContextPage(): MountableComponent {
  let root: HTMLElement | null = null;
  return {
    mount(container: Element): void {
      root = createElement("main", { class: "portal-insecure", role: "alert" });
      appendChildren(
        root,
        createElement("h1", { class: "portal-insecure-title" }, portalText("insecure.title")),
        createElement("p", { class: "portal-insecure-body" }, portalText("insecure.body")),
      );
      container.appendChild(root);
    },
    destroy(): void {
      root?.remove();
      root = null;
    },
  };
}
