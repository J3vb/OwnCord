/**
 * QuickSwitchOverlay — modal for switching between saved server profiles.
 * Appears when the user clicks the disconnect/switch button in UserBar.
 * Uses @lib/dom helpers exclusively. Never sets innerHTML with user content.
 */

import { applyDialogSemantics, focusDialog, trapFocus } from "@lib/a11y";
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
  let restoreFocus: (() => void) | null = null;

  function mount(container: Element): void {
    root = createElement("div", {
      class: "quick-switch-backdrop",
      "data-testid": "quick-switch-overlay",
    });

    // Close on backdrop click (not on modal content)
    root.addEventListener(
      "click",
      (e) => {
        if (e.target === root) options.onClose();
      },
      { signal: ac.signal },
    );

    const modal = createElement("div", { class: "quick-switch-modal" });
    applyDialogSemantics(modal, { label: "Switch server" });
    trapFocus(modal, ac.signal);

    // Header
    const header = createElement("div", { class: "quick-switch-header" });
    const title = createElement("h2", {}, "Switch Server");
    const subtitle = createElement(
      "p",
      { class: "quick-switch-subtitle" },
      "You\u2019ll disconnect from the current server.",
    );
    appendChildren(header, title, subtitle);

    // Server list
    const list = createElement("div", { class: "quick-switch-list" });

    for (const profile of options.profiles) {
      const isCurrent = profile.host === options.currentHost;
      const attrs: Record<string, string> = {
        class: `quick-switch-item${isCurrent ? " current" : ""}`,
        "data-testid": "server-item",
        "data-host": profile.host,
      };
      // Only actionable rows get button semantics — the connected row has no
      // click handler, and a "button" that does nothing lies to screen readers.
      if (!isCurrent) {
        attrs["role"] = "button";
        attrs["tabindex"] = "0";
      }
      const item = createElement("div", attrs);

      const icon = createElement("div", { class: "quick-switch-icon" });
      setText(icon, profile.name.charAt(0).toUpperCase());

      const info = createElement("div", { class: "quick-switch-info" });
      const nameEl = createElement("div", { class: "quick-switch-name" }, profile.name);
      const hostEl = createElement(
        "div",
        { class: "quick-switch-host" },
        `${profile.host}${isCurrent ? " \u00B7 Connected" : ""}`,
      );
      appendChildren(info, nameEl, hostEl);

      if (isCurrent) {
        const dot = createElement("div", { class: "quick-switch-connected-dot" });
        appendChildren(item, icon, info, dot);
      } else {
        appendChildren(item, icon, info);
        item.addEventListener(
          "click",
          () => {
            options.onSwitch(profile.host, profile.name);
          },
          { signal: ac.signal },
        );
        // Divs get no native key activation; Enter/Space mirrors the click
        // so the row honors the button role it advertises.
        item.addEventListener(
          "keydown",
          (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              options.onSwitch(profile.host, profile.name);
            }
          },
          { signal: ac.signal },
        );
      }

      list.appendChild(item);
    }

    // Add new server button
    const addItem = createElement("div", {
      class: "quick-switch-item add-new",
      "data-testid": "add-server-btn",
      role: "button",
      tabindex: "0",
    });
    const addIcon = createElement("div", { class: "quick-switch-icon add" }, "+");
    const addInfo = createElement("div", { class: "quick-switch-info" });
    const addName = createElement("div", { class: "quick-switch-name" }, "Add new server");
    const addHost = createElement(
      "div",
      { class: "quick-switch-host" },
      "Connect to another OwnCord server",
    );
    appendChildren(addInfo, addName, addHost);
    appendChildren(addItem, addIcon, addInfo);
    addItem.addEventListener("click", () => options.onAddServer(), { signal: ac.signal });
    addItem.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          options.onAddServer();
        }
      },
      { signal: ac.signal },
    );
    list.appendChild(addItem);

    // Footer
    const footer = createElement("div", { class: "quick-switch-footer" }, "Press Escape to cancel");

    appendChildren(modal, header, list, footer);
    root.appendChild(modal);
    container.appendChild(root);

    // Move focus onto the first actionable row (or the modal itself) and
    // remember the opener — the UserBar switch button — for destroy().
    restoreFocus = focusDialog(modal);

    // Escape key closes overlay
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape") options.onClose();
      },
      { signal: ac.signal },
    );
  }

  function destroy(): void {
    ac.abort();
    if (root !== null) {
      root.remove();
      root = null;
    }
    // Restore after removal so focus cannot land on a node inside the
    // just-detached overlay.
    restoreFocus?.();
    restoreFocus = null;
  }

  return { mount, destroy };
}
