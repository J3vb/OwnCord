// Step 8.60 — Quick switcher modal (Ctrl+K) for fast channel navigation.
// Uses @lib/dom helpers exclusively. Never sets innerHTML with user content.

import { createElement, setText, appendChildren, clearChildren } from "@lib/dom";
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

  function getChannelIcon(ch: Channel): string {
    return ch.type === "voice" ? "\ud83d\udd0a" : "#";
  }

  function getFilteredChannels(query: string): readonly Channel[] {
    const state = channelsStore.getState();
    const all = Array.from(state.channels.values());
    const sorted = [...all].sort((a, b) => a.position - b.position);

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
      });

      const icon = createElement("span", { class: "quick-switcher__icon" }, getChannelIcon(ch));
      const name = createElement("span", { class: "quick-switcher__name" });
      setText(name, ch.name);

      const parts: (Element | string)[] = [icon, name];

      if (ch.category !== null) {
        const category = createElement("span", { class: "quick-switcher__category" });
        setText(category, ch.category);
        parts.push(category);
      }

      appendChildren(item, ...parts);

      item.addEventListener("click", () => {
        options.onSelectChannel(ch.id);
        options.onClose();
      }, { signal });

      resultsDiv.appendChild(item);
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
    if ((e.ctrlKey || e.metaKey) && e.key === "k") {
      e.preventDefault();
      if (root !== null && root.parentNode !== null) {
        options.onClose();
      }
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
      style: "position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 1000; display: flex; justify-content: center; padding-top: 20vh;",
    });

    // Modal container
    const modal = createElement("div", { class: "quick-switcher" });

    // Search input
    input = createElement("input", {
      class: "quick-switcher__input",
      type: "text",
      placeholder: "Where do you want to go?",
    }) as HTMLInputElement;

    // Results list
    resultsDiv = createElement("div", { class: "quick-switcher__results" });

    appendChildren(modal, input, resultsDiv);
    root.appendChild(modal);
    container.appendChild(root);

    // Initial render
    filteredChannels = getFilteredChannels("");
    renderResults();

    // Event listeners
    input.addEventListener("input", handleInput, { signal });
    input.addEventListener("keydown", handleKeydown, { signal });
    root.addEventListener("click", handleBackdropClick, { signal });
    document.addEventListener("keydown", handleGlobalKeydown, { signal });

    // Subscribe to store changes
    unsubscribe = channelsStore.subscribeSelector(
      (s) => s.channels,
      refreshFromStore,
    );

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
  }

  return { mount, destroy };
}
