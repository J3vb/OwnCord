// Step 8.60 — Quick switcher modal (Ctrl+K) for fast channel navigation.
// Uses @lib/dom helpers exclusively. Never sets innerHTML with user content.

import { Disposable } from "@lib/disposable";
import { isImeCommit } from "@lib/ime";
import { applyDialogSemantics, focusDialog, trapFocus } from "@lib/a11y";
import { createElement, setText, appendChildren, clearChildren } from "@lib/dom";
import { closeOnBackdropClick } from "@lib/modalFactory";
import { createIcon } from "@lib/icons";
import { channelsStore } from "@stores/channels.store";
import type { Channel } from "@stores/channels.store";
import { dmStore, dmDisplayName } from "@stores/dm.store";
import { isChannelMuted } from "@lib/channel-mutes";
import type { MountableComponent } from "@lib/safe-render";
import { shellText } from "../i18n/shell";

export interface QuickSwitcherOptions {
  readonly onSelectChannel: (channelId: number) => void;
  readonly onClose: () => void;
}

/** One switcher row: a channel or a DM conversation, reduced to what the row draws. */
interface QuickSwitcherEntry {
  readonly id: number;
  readonly name: string;
  readonly type: Channel["type"];
  readonly category: string | null;
  readonly unreadCount: number;
  readonly mentionCount: number;
}

function getEntryIcon(entry: QuickSwitcherEntry): SVGSVGElement {
  if (entry.type === "voice") return createIcon("volume-2", 14);
  if (entry.type === "announcement") return createIcon("megaphone", 14);
  if (entry.type === "forum") return createIcon("messages-square", 14);
  if (entry.type === "dm") return createIcon("user", 14);
  return createIcon("hash", 14);
}

function getFilteredEntries(query: string): readonly QuickSwitcherEntry[] {
  const state = channelsStore.getState();
  // DM mirror rows in channelsStore only exist once a DM was opened, so the
  // conversations come from dmStore (every DM from `ready`) instead; picking
  // one is routed through the DM path by the manager (OverlayManagers).
  const channels: QuickSwitcherEntry[] = Array.from(state.channels.values())
    .filter((ch) => ch.type !== "dm")
    .toSorted((a, b) => a.position - b.position)
    .map((ch) => ({
      id: ch.id,
      name: ch.name,
      type: ch.type,
      category: ch.category,
      unreadCount: ch.unreadCount,
      mentionCount: ch.mentionCount,
    }));
  const dms: QuickSwitcherEntry[] = dmStore.getState().channels.map((dm) => ({
    id: dm.channelId,
    name: dmDisplayName(dm),
    type: "dm",
    category: null,
    unreadCount: dm.unreadCount,
    mentionCount: dm.mentionCount,
  }));
  const all = [...channels, ...dms];

  if (query.length === 0) return all;

  // Prefix matches rank ahead of substring matches; the sort is stable, so
  // each tier keeps the channel order above.
  const lower = query.toLowerCase();
  const prefix: QuickSwitcherEntry[] = [];
  const substring: QuickSwitcherEntry[] = [];
  for (const entry of all) {
    const name = entry.name.toLowerCase();
    if (name.startsWith(lower)) prefix.push(entry);
    else if (name.includes(lower)) substring.push(entry);
  }
  return [...prefix, ...substring];
}

export function createQuickSwitcher(options: QuickSwitcherOptions): MountableComponent {
  const disposable = new Disposable();
  const signal = disposable.signal;

  let root: HTMLDivElement | null = null;
  let resultsDiv: HTMLDivElement;
  let emptyDiv: HTMLDivElement;
  let input: HTMLInputElement;
  let activeIndex = 0;
  let filteredChannels: readonly QuickSwitcherEntry[] = [];
  let unsubscribe: (() => void) | null = null;
  let unsubscribeDms: (() => void) | null = null;
  let restoreFocus: (() => void) | null = null;

  function renderResults(): void {
    clearChildren(resultsDiv);
    // The empty-state line lives outside the listbox (a listbox holds only
    // options) in a polite live region, so it is announced as the list empties.
    setText(emptyDiv, filteredChannels.length === 0 ? shellText("quickSwitcher.noResults") : "");
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
      icon.appendChild(getEntryIcon(ch));
      const name = createElement("span", { class: "quick-switcher__name" });
      setText(name, ch.name);

      const parts: (Element | string)[] = [icon, name];

      if (ch.category !== null) {
        const category = createElement("span", { class: "quick-switcher__category" });
        setText(category, ch.category);
        parts.push(category);
      }

      // Mention count outranks the plain unread dot, as in the sidebar; a
      // muted channel only shows its mentions.
      if (ch.mentionCount > 0) {
        const badge = createElement(
          "span",
          { class: "quick-switcher__mentions", "data-testid": `qs-mentions-${ch.id}` },
          String(ch.mentionCount),
        );
        parts.push(badge);
      } else if (ch.type !== "voice" && ch.unreadCount > 0 && !isChannelMuted(ch.id)) {
        parts.push(
          createElement("span", {
            class: "quick-switcher__unread",
            "data-testid": `qs-unread-${ch.id}`,
            title: shellText("channel.unread"),
          }),
        );
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
      // The results box is a fixed max-height scroller, so the roving
      // highlight otherwise walks off the bottom while Enter still opens the
      // hidden row. Mirrors the inline autocomplete (OC-0370).
      (resultsDiv.children[activeIndex] as HTMLElement | undefined)?.scrollIntoView({
        block: "nearest",
      });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function handleInput(): void {
    const query = input.value.trim();
    filteredChannels = getFilteredEntries(query);
    activeIndex = 0;
    renderResults();
  }

  function handleKeydown(e: KeyboardEvent): void {
    // While an input method composes, Enter, arrows and Escape belong to it.
    if (isImeCommit(e)) return;
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

  function handleGlobalKeydown(e: KeyboardEvent): void {
    // Same case-insensitive, altKey-excluding match as
    // OverlayManagers.ts's open handler (OC-0150) — otherwise this close
    // path goes dead under CapsLock and AltGr swallows a keystroke for
    // nothing.
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== "k") return;
    e.preventDefault();
    // The press that opened the switcher may still be held down.
    if (e.repeat) return;
    if (root !== null && root.parentNode !== null) {
      options.onClose();
    }
  }

  function refreshFromStore(): void {
    const query = input?.value.trim() ?? "";
    filteredChannels = getFilteredEntries(query);
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
    applyDialogSemantics(modal, { label: shellText("quickSwitcher.label") });
    trapFocus(modal, signal);

    // Search input — combobox over the results listbox: the input keeps DOM
    // focus while aria-activedescendant (set in renderResults) names the row
    // the arrow keys have highlighted. The list is always rendered, so
    // aria-expanded is statically true.
    input = createElement("input", {
      class: "quick-switcher__input",
      type: "text",
      placeholder: shellText("quickSwitcher.placeholder"),
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

    emptyDiv = createElement("div", {
      class: "quick-switcher__empty",
      role: "status",
      "data-testid": "quick-switcher-empty",
    });

    appendChildren(modal, input, resultsDiv, emptyDiv);
    root.appendChild(modal);
    container.appendChild(root);

    // Capture the opener before anything inside grabs focus — Ctrl+K comes
    // from the composer, and a keyboard user needs destroy() to land them
    // back there, not at the top of the document.
    restoreFocus = focusDialog(modal);

    // Initial render
    filteredChannels = getFilteredEntries("");
    renderResults();

    // Event listeners
    input.addEventListener("input", handleInput, { signal });
    input.addEventListener("keydown", handleKeydown, { signal });
    closeOnBackdropClick(root, () => options.onClose(), signal);
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
    unsubscribeDms = dmStore.subscribeSelector((s) => s.channels, refreshFromStore);

    // Auto-focus
    requestAnimationFrame(() => input.focus());
  }

  function destroy(): void {
    disposable.destroy();
    if (unsubscribe !== null) {
      unsubscribe();
      unsubscribe = null;
    }
    if (unsubscribeDms !== null) {
      unsubscribeDms();
      unsubscribeDms = null;
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
