/**
 * QuickSwitchOverlay — modal for switching between saved server profiles.
 * Appears when the user clicks the disconnect/switch button in UserBar.
 * Uses @lib/dom helpers exclusively. Never sets innerHTML with user content.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QuickSwitchProfile {
  readonly name: string;
  readonly host: string;
}

export interface QuickSwitchOverlayOptions {
  readonly profiles: readonly QuickSwitchProfile[];
  readonly currentHost: string;
  readonly onSwitch: (host: string, name: string) => void;
  readonly onAddServer: () => void;
  readonly onClose: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createQuickSwitchOverlay(options: QuickSwitchOverlayOptions): MountableComponent {
  const ac = new AbortController();
  let root: HTMLDivElement | null = null;

  function mount(container: Element): void {
    root = createElement("div", {
      class: "quick-switch-backdrop",
      "data-testid": "quick-switch-overlay",
    });

    // Close on backdrop click (not on modal content)
    root.addEventListener("click", (e) => {
      if (e.target === root) options.onClose();
    }, { signal: ac.signal });

    const modal = createElement("div", { class: "quick-switch-modal" });

    // Header
    const header = createElement("div", { class: "quick-switch-header" });
    const title = createElement("h2", {}, "Switch Server");
    const subtitle = createElement("p", { class: "quick-switch-subtitle" },
      "You\u2019ll disconnect from the current server.");
    appendChildren(header, title, subtitle);

    // Server list
    const list = createElement("div", { class: "quick-switch-list" });

    for (const profile of options.profiles) {
      const isCurrent = profile.host === options.currentHost;
      const item = createElement("div", {
        class: `quick-switch-item${isCurrent ? " current" : ""}`,
        "data-testid": "server-item",
        "data-host": profile.host,
      });

      const icon = createElement("div", { class: "quick-switch-icon" });
      setText(icon, profile.name.charAt(0).toUpperCase());

      const info = createElement("div", { class: "quick-switch-info" });
      const nameEl = createElement("div", { class: "quick-switch-name" }, profile.name);
      const hostEl = createElement("div", { class: "quick-switch-host" },
        `${profile.host}${isCurrent ? " \u00B7 Connected" : ""}`);
      appendChildren(info, nameEl, hostEl);

      if (isCurrent) {
        const dot = createElement("div", { class: "quick-switch-connected-dot" });
        appendChildren(item, icon, info, dot);
      } else {
        appendChildren(item, icon, info);
        item.addEventListener("click", () => {
          options.onSwitch(profile.host, profile.name);
        }, { signal: ac.signal });
      }

      list.appendChild(item);
    }

    // Add new server button
    const addItem = createElement("div", {
      class: "quick-switch-item add-new",
      "data-testid": "add-server-btn",
    });
    const addIcon = createElement("div", { class: "quick-switch-icon add" }, "+");
    const addInfo = createElement("div", { class: "quick-switch-info" });
    const addName = createElement("div", { class: "quick-switch-name" }, "Add new server");
    const addHost = createElement("div", { class: "quick-switch-host" }, "Connect to another OwnCord server");
    appendChildren(addInfo, addName, addHost);
    appendChildren(addItem, addIcon, addInfo);
    addItem.addEventListener("click", () => options.onAddServer(), { signal: ac.signal });
    list.appendChild(addItem);

    // Footer
    const footer = createElement("div", { class: "quick-switch-footer" }, "Press Escape to cancel");

    appendChildren(modal, header, list, footer);
    root.appendChild(modal);
    container.appendChild(root);

    // Escape key closes overlay
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") options.onClose();
    }, { signal: ac.signal });
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
