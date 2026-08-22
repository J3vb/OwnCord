// Step 8.60 — Quick switcher modal (Ctrl+K) for fast channel navigation.
// Uses @lib/dom helpers exclusively. Never sets innerHTML with user content.

import { applyDialogSemantics, focusDialog, trapFocus } from "@lib/a11y";
import { createElement, setText, appendChildren, clearChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { channelsStore } from "@stores/channels.store";
import type { Channel } from "@stores/channels.store";
import type { MountableComponent } from "@lib/safe-render";

export interface QuickSwitcherOptions {
  readonly onSelectChannel: (channelId: number) => void;
  readonly onClose: () => void;
}

export function createQuickSwitcher(options: QuickSwitcherOptions): MountableComponent {
  const ac = new AbortController();
  const signal = ac.signal;

  let root: HTMLDivElement | null = null;
  let resultsDiv: HTMLDivElement;
  let input: HTMLInputElement;
  let activeIndex = 0;
  let filteredChannels: readonly Channel[] = [];
  let unsubscribe: (() => void) | null = null;
  let restoreFocus: (() => void) | null = null;

  function getChannelIcon(ch: Channel): SVGSVGElement {
    return ch.type === "voice" ? createIcon("volume-2", 14) : createIcon("hash", 14);
  }

  function getFilteredChannels(query: string): readonly Channel[] {
    const state = channelsStore.getState();
    // DM rows are synthesized into channelsStore once opened, but they have
    // their own sidebar path (full clearDmUnread/setSidebarMode handling) —
    // listing them here too would select via a bare setActiveChannel and
    // leave their unread/mention badge lit forever.
    const all = Array.from(state.channels.values()).filter((ch) => ch.type !== "dm");
    const sorted = [...all].toSorted((a, b) => a.position - b.position);

    if (query.length === 0) return sorted;

    const lower = query.toLowerCase();
    return sorted.filter((ch) => ch.name.toLowerCase().includes(lower));
  }

  function renderResults(): void {
    clearChildren(resultsDiv);
    activeIndex = Math.min(activeIndex, Math.max(0, filteredChannels.length - 1));

    for (let i = 0; i < filteredChannels.length; i++) {
      const ch = filteredChannels[i]!;
      const isActive = i === activeIndex;

      const item = createElement("div", {
        class: isActive
          ? "quick-switcher__item quick-switcher__item--active"
          : "quick-switcher__item",
        "data-channelid": String(ch.id),
        // Combobox option wiring: the id feeds aria-activedescendant so a
        // screen reader tracks the roving --active highlight without the
        // input ever losing DOM focus.
        id: `qs-option-${i}`,
        role: "option",
        "aria-selected": isActive ? "true" : "false",
      });

      const icon = createElement("span", { class: "quick-switcher__icon" });
      icon.appendChild(getChannelIcon(ch));
      const name = createElement("span", { class: "quick-switcher__name" });
      setText(name, ch.name);

      const parts: (Element | string)[] = [icon, name];

      if (ch.category !== null) {
        const category = createElement("span", { class: "quick-switcher__category" });
        setText(category, ch.category);
        parts.push(category);
      }

      appendChildren(item, ...parts);

      resultsDiv.appendChild(item);
    }

    // Re-point aria-activedescendant on every render — arrow keys, filtering
    // and store refreshes all funnel through here, so it can never go stale.
    // An empty result set clears it; pointing at a missing id is worse than
    // pointing at nothing.
    if (filteredChannels.length > 0) {
      input.setAttribute("aria-activedescendant", `qs-option-${activeIndex}`);
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function handleInput(): void {
    const query = input.value.trim();
    filteredChannels = getFilteredChannels(query);
    activeIndex = 0;
    renderResults();
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      options.onClose();
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filteredChannels.length > 0) {
        activeIndex = (activeIndex + 1) % filteredChannels.length;
        renderResults();
      }
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filteredChannels.length > 0) {
        activeIndex = (activeIndex - 1 + filteredChannels.length) % filteredChannels.length;
        renderResults();
      }
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      const selected = filteredChannels[activeIndex];
      if (selected !== undefined) {
        options.onSelectChannel(selected.id);
        options.onClose();
      }
    }
  }

  function handleBackdropClick(e: MouseEvent): void {
    if (e.target === root) {
      options.onClose();
    }
  }

  function handleGlobalKeydown(e: KeyboardEvent): void {
    // Same case-insensitive, altKey-excluding match as
    // OverlayManagers.ts's open handler (OC-0150) — otherwise this close
    // path goes dead under CapsLock and AltGr swallows a keystroke for
    // nothing.
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== "k") return;
    e.preventDefault();
    if (root !== null && root.parentNode !== null) {
      options.onClose();
    }
  }

  function refreshFromStore(): void {
    const query = input?.value.trim() ?? "";
    filteredChannels = getFilteredChannels(query);
    renderResults();
  }

  function mount(container: Element): void {
    // Overlay backdrop
    root = createElement("div", {
      class: "quick-switcher-overlay",
      style:
        "position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 1000; display: flex; justify-content: center; padding-top: 20vh;",
    });

    // Modal container
    const modal = createElement("div", { class: "quick-switcher" });
    applyDialogSemantics(modal, { label: "Quick switcher" });
    trapFocus(modal, signal);

    // Search input — combobox over the results listbox: the input keeps DOM
    // focus while aria-activedescendant (set in renderResults) names the row
    // the arrow keys have highlighted. The list is always rendered, so
    // aria-expanded is statically true.
    input = createElement("input", {
      class: "quick-switcher__input",
      type: "text",
      placeholder: "Where do you want to go?",
      role: "combobox",
      "aria-expanded": "true",
      "aria-autocomplete": "list",
      "aria-controls": "quick-switcher-results",
    });

    // Results list
    resultsDiv = createElement("div", {
      class: "quick-switcher__results",
      id: "quick-switcher-results",
      role: "listbox",
    });

    appendChildren(modal, input, resultsDiv);
    root.appendChild(modal);
    container.appendChild(root);

    // Capture the opener before anything inside grabs focus — Ctrl+K comes
    // from the composer, and a keyboard user needs destroy() to land them
    // back there, not at the top of the document.
    restoreFocus = focusDialog(modal);

    // Initial render
    filteredChannels = getFilteredChannels("");
    renderResults();

    // Event listeners
    input.addEventListener("input", handleInput, { signal });
    input.addEventListener("keydown", handleKeydown, { signal });
    root.addEventListener("click", handleBackdropClick, { signal });
    document.addEventListener("keydown", handleGlobalKeydown, { signal });

    // Delegated row click — renderResults() rebuilds every row from scratch
    // on each keystroke, arrow key, and store refresh, so a per-row listener
    // registered against this overlay-lifetime `signal` would never be freed
    // until the overlay closes (OC-0307). One listener on the (stable)
    // container instead, keyed off the data-channelid each row already
    // carries.
    resultsDiv.addEventListener(
      "click",
      (e) => {
        const row = (e.target as HTMLElement | null)?.closest<HTMLElement>(".quick-switcher__item");
        const id = row?.dataset.channelid;
        if (id !== undefined) {
          options.onSelectChannel(Number(id));
          options.onClose();
        }
      },
      { signal },
    );

    // Subscribe to store changes
    unsubscribe = channelsStore.subscribeSelector((s) => s.channels, refreshFromStore);

    // Auto-focus
    requestAnimationFrame(() => input.focus());
  }

  function destroy(): void {
    ac.abort();
    if (unsubscribe !== null) {
      unsubscribe();
      unsubscribe = null;
    }
    root?.remove();
    root = null;
    // Restore after the overlay is gone, so focus cannot land on a node the
    // removal is about to detach.
    restoreFocus?.();
    restoreFocus = null;
  }

  return { mount, destroy };
}
