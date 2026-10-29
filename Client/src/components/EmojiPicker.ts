// EmojiPicker — grid-based emoji selector with search and scrollable categories.
// Uses @lib/dom helpers exclusively. Never sets innerHTML with user content.

import { Disposable } from "@lib/disposable";
import { isImeCommit } from "@lib/ime";
import { createElement, setText, clearChildren } from "@lib/dom";
import { enableRovingNavigation, setRovingTabindex } from "@lib/a11y";
import { buildCustomEmojiNode } from "@components/message-list/custom-emoji";
import { messagingText } from "../i18n/messaging";
import { addRecentEmoji, getRecentEmoji } from "./emojiRecent";
import {
  emojiCatalog,
  emojiMatches,
  loadEmojiCatalog,
  setSkinTone,
  skinTone,
  withSkinTone,
  SKIN_TONES,
  type EmojiGroupKey,
} from "../features/messaging/emojiCatalog";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CustomEmoji {
  readonly shortcode: string;
  readonly url: string;
}

export interface EmojiPickerOptions {
  /**
   * The server's custom emoji, shown as a "Server" category above the unicode
   * ones. Selecting one inserts its `:shortcode:` — the composer sends text,
   * and the renderer turns that text back into the image.
   */
  readonly customEmoji?: readonly CustomEmoji[];
  /**
   * The second argument is passed only when Shift was held (click or
   * Shift+Enter): `keepOpen` then tells the owner to leave the picker open so
   * several emoji can be picked in a row. A plain pick passes the emoji alone.
   */
  readonly onSelect: (emoji: string, select?: EmojiSelectOptions) => void;
  readonly onClose: () => void;
}

export interface EmojiSelectOptions {
  readonly keepOpen: boolean;
}

/** The catalog key the server's own emoji appear under. */
export const SERVER_CATEGORY = "emoji.category.server" as const;

/** A category heading; the key is resolved through the messaging catalog. */
type EmojiCategoryKey =
  typeof SERVER_CATEGORY | "emoji.category.recent" | `emoji.category.${EmojiGroupKey}`;

interface EmojiCategory {
  readonly name: EmojiCategoryKey;
  readonly emoji: readonly string[];
}

/** The glyph each category shows in the side rail; Server uses its first emoji. */
const CATEGORY_ICONS: Readonly<Record<Exclude<EmojiCategoryKey, typeof SERVER_CATEGORY>, string>> =
  {
    "emoji.category.recent": "🕒",
    "emoji.category.smileys": "😀",
    "emoji.category.people": "👋",
    "emoji.category.nature": "🌿",
    "emoji.category.food": "🍔",
    "emoji.category.travel": "🚗",
    "emoji.category.activities": "⚽",
    "emoji.category.objects": "💡",
    "emoji.category.symbols": "💟",
    "emoji.category.flags": "🏁",
  };

function buildCategoryIcon(cat: EmojiCategory): Node {
  if (cat.name === SERVER_CATEGORY) {
    const first = cat.emoji[0];
    const image = first === undefined ? null : buildCustomEmojiNode(first);
    if (image !== null) return image;
    return document.createTextNode("⭐");
  }
  return document.createTextNode(CATEGORY_ICONS[cat.name]);
}

// ---------------------------------------------------------------------------
// EmojiPicker
// ---------------------------------------------------------------------------

function buildEmojiSpan(emoji: string): HTMLSpanElement {
  const span = createElement("span", {
    class: "ep-emoji",
    title: emoji,
    role: "option",
    // Mirrors the title (the character or :shortcode: token) — e2e specs
    // select cells by title, so the accessible name must never diverge.
    "aria-label": emoji,
    // Read by the delegated click handler on scrollArea (see mount-time
    // listener above) instead of a per-cell listener.
    "data-emoji": emoji,
  });
  // A `:shortcode:` entry shows its image; everything else is the character
  // itself. An unresolvable shortcode falls back to the text, which is what
  // it would render as in a message anyway.
  const image = buildCustomEmojiNode(emoji);
  if (image !== null) {
    span.classList.add("ep-emoji-custom");
    span.appendChild(image);
  } else {
    setText(span, emoji);
  }
  return span;
}

export function createEmojiPicker(options: EmojiPickerOptions): {
  readonly element: HTMLDivElement;
  destroy(): void;
} {
  const disposable = new Disposable();
  const signal = disposable.signal;

  let searchQuery = "";

  // Build DOM — matches mockup structure:
  // .emoji-picker.open > .ep-header > input.ep-search
  //   then repeating: .ep-category-label + .ep-grid > span.ep-emoji
  const root = createElement("div", { class: "emoji-picker open" });

  const header = createElement("div", { class: "ep-header" });
  const searchInput = createElement("input", {
    class: "ep-search",
    type: "text",
    placeholder: messagingText("emoji.searchPlaceholder"),
  });
  header.appendChild(searchInput);
  // Skin tone for every emoji that has one, remembered across pickers and the
  // composer's `:` popup. A native select keeps it one keyboard control.
  const toneSelect = createElement("select", {
    class: "ep-tone",
    title: messagingText("emoji.skinTone"),
    "aria-label": messagingText("emoji.skinTone"),
  });
  SKIN_TONES.forEach((mod, i) => {
    toneSelect.appendChild(createElement("option", { value: String(i) }, `✋${mod}`));
  });
  toneSelect.value = String(skinTone());
  header.appendChild(toneSelect);
  root.appendChild(header);

  // Body: a side rail of category icons next to the scrolling grid.
  const body = createElement("div", { class: "ep-body" });
  root.appendChild(body);

  // Category rail: one icon button per category jumps its heading into view,
  // as a single roving Tab stop (Up/Down between buttons). Built once from the
  // unfiltered set and rebuilt only on mount, so the targets stay put while a
  // search filters the grids underneath.
  const categoryBar = createElement("div", {
    class: "ep-categories",
    role: "toolbar",
    "aria-orientation": "vertical",
    "aria-label": messagingText("emoji.categoriesLabel"),
  });
  body.appendChild(categoryBar);
  enableRovingNavigation(categoryBar, ".ep-category-btn", signal, "vertical");

  // The picker grid is `.ep-grid { grid-template-columns: repeat(8, 1fr) }`,
  // so roving navigation is a grid with eight columns (ArrowDown = one row
  // within a category's grid).
  const GRID_COLUMNS = 8;

  // Scrollable content area (holds category labels + grids). Announced as a
  // single flat listbox — the category grids are visual grouping only, and
  // roving tabindex (DC-13) treats every .ep-emoji cell as one list.
  const scrollArea = createElement("div", {
    class: "ep-scroll",
    role: "listbox",
    "aria-label": messagingText("emoji.listLabel"),
  });
  body.appendChild(scrollArea);
  enableRovingNavigation(scrollArea, ".ep-emoji", signal, "grid", GRID_COLUMNS);

  // Single delegated listener for the whole grid, registered once at mount
  // time. renderAllCategories() discards and rebuilds every cell on each
  // search keystroke (~250 cells per render); a listener bound directly to
  // each cell would register (and, since it lives on the picker-lifetime
  // `signal`, never release) one abort algorithm per discarded cell for the
  // rest of the picker's life — the same pattern SearchOverlay.ts's
  // handleResultsClick already fixes for its rows.
  scrollArea.addEventListener(
    "click",
    (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const cell = target.closest<HTMLElement>(".ep-emoji");
      if (cell === null) return;
      const emoji = cell.dataset.emoji;
      if (emoji === undefined) return;
      handleEmojiClick(emoji, e.shiftKey);
    },
    { signal },
  );

  function renderCategoryBar(categories: readonly EmojiCategory[]): void {
    clearChildren(categoryBar);
    for (const cat of categories) {
      if (cat.emoji.length === 0) continue;
      const label = messagingText(cat.name);
      const btn = createElement("button", {
        class: "ep-category-btn",
        type: "button",
        title: label,
        "aria-label": label,
        "data-category": cat.name,
      });
      btn.appendChild(buildCategoryIcon(cat));
      btn.addEventListener(
        "click",
        () => {
          scrollArea
            .querySelector(`.ep-category-label[data-category="${cat.name}"]`)
            ?.scrollIntoView({ block: "start" });
        },
        { signal },
      );
      categoryBar.appendChild(btn);
    }
    setRovingTabindex(categoryBar, ".ep-category-btn");
    syncActiveCategory();
  }

  // The rail highlights the category whose heading was last scrolled past.
  function syncActiveCategory(): void {
    const labels = scrollArea.querySelectorAll<HTMLElement>(".ep-category-label");
    let current: string | undefined = labels[0]?.dataset.category;
    const top = scrollArea.scrollTop + 1;
    for (const label of labels) {
      if (label.offsetTop > top) break;
      current = label.dataset.category;
    }
    for (const btn of categoryBar.querySelectorAll<HTMLElement>(".ep-category-btn")) {
      btn.classList.toggle("active", btn.dataset.category === current);
    }
  }
  scrollArea.addEventListener("scroll", syncActiveCategory, { signal, passive: true });

  // Build categories with recent + custom, then the Unicode set once loaded.
  function getAllCategories(): readonly EmojiCategory[] {
    const recent = getRecentEmoji();
    const cats: EmojiCategory[] = [{ name: "emoji.category.recent", emoji: recent }];

    // The server's own emoji, as the `:shortcode:` tokens a message carries.
    if (options.customEmoji && options.customEmoji.length > 0) {
      cats.push({
        name: SERVER_CATEGORY,
        emoji: options.customEmoji.map((e) => `:${e.shortcode}:`),
      });
    }

    const tone = skinTone();
    for (const group of emojiCatalog()?.groups ?? []) {
      cats.push({
        name: `emoji.category.${group.key}`,
        emoji: group.emoji.map((e) => withSkinTone(e, tone)),
      });
    }

    return cats;
  }

  function handleEmojiClick(emoji: string, keepOpen: boolean): void {
    addRecentEmoji(emoji);
    if (keepOpen) options.onSelect(emoji, { keepOpen: true });
    else options.onSelect(emoji);
  }

  /** The load-failure row, built once while the load stays failed. It is kept
   *  in place across re-renders (a search keystroke must not re-announce it
   *  or stack listeners) and dropped when the failure ends. */
  let failureRow: HTMLElement | null = null;
  function ensureFailureRow(): HTMLElement {
    if (failureRow !== null) return failureRow;
    const failure = createElement("div", {
      class: "ep-load-failed",
      role: "alert",
      "data-testid": "emoji-load-failed",
    });
    const retry = createElement(
      "button",
      { class: "ep-retry", type: "button", "data-testid": "emoji-retry" },
      messagingText("retry"),
    );
    retry.addEventListener(
      "click",
      () => {
        loadFailed = false;
        renderAll();
        startCatalogLoad();
        // The row is gone: keep keyboard focus in the picker.
        searchInput.focus();
      },
      { signal },
    );
    failure.append(createElement("span", {}, messagingText("emoji.loadFailed")), retry);
    failureRow = failure;
    return failure;
  }

  function renderAllCategories(categories: readonly EmojiCategory[]): void {
    for (const child of Array.from(scrollArea.children)) {
      if (child !== failureRow) child.remove();
    }

    // A failed load says so, with a way to try again, above whatever Recent
    // and Server emoji are already showing.
    if (loadFailed && emojiCatalog() === null) {
      const row = ensureFailureRow();
      if (row.parentElement !== scrollArea) scrollArea.prepend(row);
    } else if (failureRow !== null) {
      failureRow.remove();
      failureRow = null;
    }

    // Shortcodes join words with "_", so "thumbs up" also searches as thumbs_up.
    const raw = searchQuery.toLowerCase();
    const q = raw.replace(/\s+/g, "_");
    const byChar = emojiCatalog()?.byChar;
    for (const cat of categories) {
      if (cat.emoji.length === 0) continue;

      const filtered = q
        ? cat.emoji.filter((e) => {
            // Match against emoji name/keywords (a toned Recent entry included)
            const entry = byChar?.get(e);
            if (entry !== undefined && (emojiMatches(entry, raw) || emojiMatches(entry, q))) {
              return true;
            }
            // Also match the character itself and custom shortcodes like :wave:
            const lower = e.toLowerCase();
            return lower.includes(raw) || lower.includes(q);
          })
        : cat.emoji;

      if (filtered.length === 0) continue;

      const label = createElement("div", {
        class: "ep-category-label",
        "data-category": cat.name,
      });
      setText(label, messagingText(cat.name));
      scrollArea.appendChild(label);

      const grid = createElement("div", { class: "ep-grid" });
      for (const emoji of filtered) {
        grid.appendChild(buildEmojiSpan(emoji));
      }
      scrollArea.appendChild(grid);
    }

    if (emojiCatalog() === null && !loadFailed) {
      scrollArea.appendChild(
        createElement("div", { class: "ep-loading" }, messagingText("emoji.loading")),
      );
    } else if (scrollArea.children.length === 0) {
      // Nothing rendered at all: show the empty state
      const empty = createElement(
        "div",
        {
          style: "padding: 24px; text-align: center; color: var(--text-faint); font-size: 13px;",
        },
        messagingText("emoji.empty"),
      );
      scrollArea.appendChild(empty);
    }

    // Every render rebuilds the cell set, so the single Tab stop must be
    // re-established or filtering would leave zero tabbable cells.
    setRovingTabindex(scrollArea, ".ep-emoji");
    syncActiveCategory();
  }

  function renderAll(): void {
    renderCategoryBar(getAllCategories());
    renderAllCategories(getAllCategories());
  }

  // Initial render: Recent and Server straight away, the Unicode set when its
  // lazy chunk lands (at once, if an earlier picker or popup loaded it).
  let loadFailed = false;
  function startCatalogLoad(): void {
    void loadEmojiCatalog().then(
      () => {
        if (!signal.aborted) renderAll();
      },
      () => {
        loadFailed = true;
        if (!signal.aborted) renderAll();
      },
    );
  }
  renderAll();
  if (emojiCatalog() === null) startCatalogLoad();

  toneSelect.addEventListener(
    "change",
    () => {
      setSkinTone(Number(toneSelect.value));
      renderAllCategories(getAllCategories());
    },
    { signal },
  );

  // Search handler
  searchInput.addEventListener(
    "input",
    () => {
      searchQuery = searchInput.value.trim();
      renderAllCategories(getAllCategories());
    },
    { signal },
  );

  // Enter in the search box picks the first visible match, so a typed search
  // is one Enter away from insertion. Empty results are a no-op.
  searchInput.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Enter") return;
      if (isImeCommit(e)) return;
      const first = scrollArea.querySelector<HTMLElement>(".ep-emoji");
      if (first === null) return;
      e.preventDefault();
      const emoji = first.dataset.emoji;
      if (emoji !== undefined) handleEmojiClick(emoji, e.shiftKey);
    },
    { signal },
  );

  // Close on Escape
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

  // Focus search on mount
  requestAnimationFrame(() => searchInput.focus());

  function destroy(): void {
    disposable.destroy();
  }

  return { element: root, destroy };
}
