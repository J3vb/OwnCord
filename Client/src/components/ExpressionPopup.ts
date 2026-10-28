// ExpressionPopup — the one popup the composer's GIF, sticker and emoji
// buttons share (WP 8.8): a tab row (GIFs | Stickers | Emoji) over a panel
// that holds the matching picker. Each button opens the popup on its own tab.
//
// The popup owns only the shell: the tablist, its keyboard, and which tab's
// panel is mounted. The panels (the existing GifPicker and EmojiPicker, and the
// StickerPicker) are built by the owner through `mountPanel`, so their code
// keeps loading on first use and the owner keeps every behaviour that depends
// on the composer (inserting an emoji, sending a GIF or a sticker).

import { isImeCommit } from "@lib/ime";
import { Disposable } from "@lib/disposable";
import { createElement } from "@lib/dom";
import { stickersText } from "../i18n/stickers";

export type ExpressionTab = "gif" | "sticker" | "emoji";

/** What a mounted picker offers the popup. */
export interface ExpressionPanel {
  readonly element: HTMLElement;
  destroy(): void;
}

export interface ExpressionPopupOptions {
  /** The tabs on offer, in display order. A tab that is not here has no button. */
  readonly tabs: readonly ExpressionTab[];
  readonly initial: ExpressionTab;
  /**
   * Build the picker for a tab, possibly after loading its code. Resolves null
   * when it cannot be built (the owner reports that itself). A result that
   * arrives after the popup moved to another tab, or closed, is destroyed.
   */
  readonly mountPanel: (tab: ExpressionTab) => Promise<ExpressionPanel | null>;
  /** Escape, or a picker asking to close. May be called more than once. */
  readonly onClose: () => void;
}

export interface ExpressionPopup {
  readonly element: HTMLDivElement;
  activeTab(): ExpressionTab;
  /** Switch to a tab (a no-op for the current one, or one not on offer). */
  showTab(tab: ExpressionTab): void;
  destroy(): void;
}

function tabLabel(tab: ExpressionTab): string {
  if (tab === "gif") return stickersText("tab.gif");
  return tab === "sticker" ? stickersText("tab.sticker") : stickersText("tab.emoji");
}

export function createExpressionPopup(options: ExpressionPopupOptions): ExpressionPopup {
  const disposable = new Disposable();
  const signal = disposable.signal;
  const tabs = options.tabs;

  let active: ExpressionTab = tabs.includes(options.initial) ? options.initial : tabs[0]!;
  let panel: ExpressionPanel | null = null;
  // Set while a panel loads; a later switch replaces it, which cancels the mount.
  let ticket: object | null = null;

  const root = createElement("div", {
    class: "expression-popup open",
    role: "dialog",
    "aria-label": stickersText("popup.label"),
    "data-testid": "expression-popup",
  });
  const tabRow = createElement("div", {
    class: "xp-tabs",
    role: "tablist",
    "aria-label": stickersText("tabs.label"),
  });
  const panelHost = createElement("div", {
    class: "xp-panel",
    role: "tabpanel",
    "data-testid": "expression-panel",
  });
  root.append(tabRow, panelHost);

  const tabButtons = new Map<ExpressionTab, HTMLButtonElement>();
  for (const tab of tabs) {
    const btn = createElement(
      "button",
      {
        class: "xp-tab",
        type: "button",
        role: "tab",
        id: `xp-tab-${tab}`,
        "data-tab": tab,
        "data-testid": `xp-tab-${tab}`,
      },
      tabLabel(tab),
    );
    tabButtons.set(tab, btn);
    tabRow.appendChild(btn);
  }

  function paintTabs(): void {
    for (const [tab, btn] of tabButtons) {
      const on = tab === active;
      btn.setAttribute("aria-selected", String(on));
      btn.setAttribute("tabindex", on ? "0" : "-1");
      btn.classList.toggle("active", on);
    }
    panelHost.setAttribute("aria-labelledby", `xp-tab-${active}`);
  }

  function dropPanel(): void {
    if (panel === null) return;
    panel.element.remove();
    panel.destroy();
    panel = null;
  }

  function mountActive(refocusTab: boolean): void {
    dropPanel();
    const mine = {};
    ticket = mine;
    const wanted = active;
    void options.mountPanel(wanted).then((built) => {
      if (built === null) return;
      if (ticket !== mine || signal.aborted) {
        built.destroy();
        return;
      }
      ticket = null;
      panel = built;
      panelHost.appendChild(built.element);
      // A picker focuses its search box as it mounts; keyboard users stepping
      // through the tabs stay on the tab they chose. Queued after the picker's
      // own frame callback, so it runs last.
      if (refocusTab) requestAnimationFrame(() => tabButtons.get(wanted)?.focus());
    });
  }

  function select(tab: ExpressionTab, refocusTab: boolean): void {
    if (signal.aborted || tab === active || !tabButtons.has(tab)) return;
    active = tab;
    paintTabs();
    mountActive(refocusTab);
  }

  for (const [tab, btn] of tabButtons) {
    btn.addEventListener("click", () => select(tab, false), { signal });
  }

  tabRow.addEventListener(
    "keydown",
    (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const at = tabs.indexOf(active);
      let to: number;
      if (e.key === "ArrowRight") to = (at + 1) % tabs.length;
      else if (e.key === "ArrowLeft") to = (at - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") to = 0;
      else if (e.key === "End") to = tabs.length - 1;
      else return;
      e.preventDefault();
      const next = tabs[to]!;
      tabButtons.get(next)?.focus();
      select(next, true);
    },
    { signal },
  );

  root.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || isImeCommit(e)) return;
      e.preventDefault();
      options.onClose();
    },
    { signal },
  );

  paintTabs();
  mountActive(false);

  return {
    element: root,
    activeTab: () => active,
    showTab: (tab) => select(tab, false),
    destroy(): void {
      ticket = null;
      dropPanel();
      disposable.destroy();
    },
  };
}
