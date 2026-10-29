// StickerPicker — the Stickers tab of the expression popup (WP 8.8): a search
// box, a Recent row and a grid of the server's custom stickers. Clicking one
// picks it; the owner sends it at once. Uses @lib/dom helpers exclusively and
// never sets innerHTML.

import { Disposable } from "@lib/disposable";
import { isImeCommit } from "@lib/ime";
import { createElement, clearChildren } from "@lib/dom";
import { enableRovingNavigation, setRovingTabindex } from "@lib/a11y";
import { stickersStore, type Sticker } from "@stores/stickers.store";
import { loadStickerImage } from "@components/message-list/sticker";
import { stickersText } from "../i18n/stickers";
import { addRecentSticker, getRecentStickerIds } from "./stickerRecent";

export interface StickerPickerOptions {
  /** Whether the viewer holds MANAGE_SERVER, so the empty state can say where to add stickers. */
  readonly canManage: boolean;
  readonly onSelect: (sticker: Sticker) => void;
  readonly onClose: () => void;
}

const GRID_COLUMNS = 4;

/** Whether a sticker matches the search text: its name or its related emoji. */
export function stickerMatches(sticker: Sticker, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return sticker.name.toLowerCase().includes(q) || (sticker.emoji?.includes(q) ?? false);
}

export function createStickerPicker(options: StickerPickerOptions): {
  readonly element: HTMLDivElement;
  destroy(): void;
} {
  const disposable = new Disposable();
  const signal = disposable.signal;
  // Owns the image loads of the cells currently drawn; replaced on each render.
  let cellsOwner = new Disposable();

  const root = createElement("div", {
    class: "sticker-picker open",
    "data-testid": "sticker-picker",
  });
  const header = createElement("div", { class: "sp-header" });
  const searchInput = createElement("input", {
    class: "sp-search",
    type: "text",
    placeholder: stickersText("picker.search"),
    "aria-label": stickersText("picker.searchLabel"),
    "data-testid": "sticker-search",
    autocomplete: "off",
  });
  header.appendChild(searchInput);
  const body = createElement("div", { class: "sp-body" });
  root.append(header, body);

  function buildCell(sticker: Sticker): HTMLDivElement {
    const cell = createElement("div", {
      class: "sp-item",
      role: "option",
      tabindex: "-1",
      title: sticker.name,
      "aria-label": stickersText("picker.itemLabel", { name: sticker.name }),
      "data-sticker-id": String(sticker.id),
    });
    const img = createElement("img", {
      class: "sp-img",
      alt: sticker.name,
      loading: "lazy",
      draggable: "false",
    });
    cell.appendChild(img);
    loadStickerImage(img, cell, sticker.url, cellsOwner.signal);
    return cell;
  }

  function appendSection(label: string | null, list: readonly Sticker[], testId: string): void {
    if (label !== null) {
      body.appendChild(createElement("div", { class: "sp-label" }, label));
    }
    const grid = createElement("div", {
      class: "sp-grid",
      role: "listbox",
      "aria-label": label ?? stickersText("picker.listLabel"),
      "data-testid": testId,
    });
    for (const sticker of list) grid.appendChild(buildCell(sticker));
    body.appendChild(grid);
  }

  function render(): void {
    cellsOwner.destroy();
    cellsOwner = new Disposable();
    clearChildren(body);
    const all = stickersStore.getState().stickers;
    header.hidden = all.length === 0;
    if (all.length === 0) {
      const empty = createElement(
        "div",
        { class: "sp-empty", "data-testid": "sticker-empty" },
        stickersText("picker.empty"),
      );
      if (options.canManage) {
        empty.appendChild(
          createElement(
            "div",
            { class: "sp-empty-hint", "data-testid": "sticker-empty-hint" },
            stickersText("picker.emptyAdminHint"),
          ),
        );
      }
      body.appendChild(empty);
      return;
    }
    const query = searchInput.value;
    const matching = all.filter((s) => stickerMatches(s, query));
    if (matching.length === 0) {
      body.appendChild(
        createElement(
          "div",
          { class: "sp-empty", "data-testid": "sticker-no-match" },
          stickersText("picker.none"),
        ),
      );
      return;
    }
    // Recent first, only while not searching and only what the server still has.
    if (query.trim() === "") {
      const byId = new Map(all.map((s) => [s.id, s]));
      const recent = getRecentStickerIds()
        .map((id) => byId.get(id))
        .filter((s): s is Sticker => s !== undefined);
      if (recent.length > 0) appendSection(stickersText("picker.recent"), recent, "sticker-recent");
      appendSection(stickersText("picker.all"), matching, "sticker-all");
    } else {
      appendSection(null, matching, "sticker-all");
    }
    setRovingTabindex(body, ".sp-item");
  }

  function pick(id: number): void {
    // Resolve against the live set: a sticker deleted while the picker was open
    // has already left the grid, and one that raced the click is not sent.
    const sticker = stickersStore.getState().stickers.find((s) => s.id === id);
    if (sticker === undefined) return;
    addRecentSticker(sticker.id);
    options.onSelect(sticker);
  }

  body.addEventListener(
    "click",
    (e) => {
      const cell = (e.target as Element | null)?.closest<HTMLElement>(".sp-item");
      if (cell === null || cell === undefined) return;
      const id = Number(cell.dataset["stickerId"]);
      if (Number.isInteger(id)) pick(id);
    },
    { signal },
  );
  enableRovingNavigation(body, ".sp-item", signal, "grid", GRID_COLUMNS);

  searchInput.addEventListener("input", render, { signal });
  searchInput.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Enter" || isImeCommit(e)) return;
      const first = body.querySelector<HTMLElement>(".sp-item");
      if (first === null) return;
      e.preventDefault();
      const id = Number(first.dataset["stickerId"]);
      if (Number.isInteger(id)) pick(id);
    },
    { signal },
  );
  root.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && !isImeCommit(e)) {
        e.preventDefault();
        options.onClose();
      }
    },
    { signal },
  );

  // A sticker_update while the picker is open redraws the grid in place.
  disposable.onStoreChange(
    stickersStore,
    (s) => s.stickers,
    () => render(),
  );
  render();

  requestAnimationFrame(() => searchInput.focus());

  function destroy(): void {
    cellsOwner.destroy();
    disposable.destroy();
  }

  return { element: root, destroy };
}
