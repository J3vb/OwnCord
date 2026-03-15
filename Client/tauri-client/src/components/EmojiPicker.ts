// EmojiPicker — grid-based emoji selector with search and custom server emoji.
// Uses @lib/dom helpers exclusively. Never sets innerHTML with user content.

import { createElement, setText, appendChildren, clearChildren } from "@lib/dom";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CustomEmoji {
  readonly shortcode: string;
  readonly url: string;
}

export interface EmojiPickerOptions {
  readonly customEmoji?: readonly CustomEmoji[];
  readonly onSelect: (emoji: string) => void;
  readonly onClose: () => void;
}

// ---------------------------------------------------------------------------
// Built-in emoji data (common subset by category)
// ---------------------------------------------------------------------------

interface EmojiCategory {
  readonly name: string;
  readonly emoji: readonly string[];
}

const CATEGORIES: readonly EmojiCategory[] = [
  {
    name: "Recent",
    emoji: [], // populated at runtime from localStorage
  },
  {
    name: "Smileys",
    emoji: [
      "😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😂", "🙂", "😊",
      "😇", "🥰", "😍", "🤩", "😘", "😗", "😋", "😛", "😜", "🤪",
      "😝", "🤑", "🤗", "🤭", "🤫", "🤔", "🤐", "🤨", "😐", "😑",
      "😶", "😏", "😒", "🙄", "😬", "🤥", "😌", "😔", "😪", "🤤",
      "😴", "😷", "🤒", "🤕", "🤢", "🤮", "🥵", "🥶", "🥴", "😵",
      "🤯", "🤠", "🥳", "😎", "🤓", "🧐", "😕", "😟", "🙁", "😮",
      "😲", "😳", "🥺", "😢", "😭", "😤", "😠", "😡", "🤬", "💀",
    ],
  },
  {
    name: "People",
    emoji: [
      "👋", "🤚", "🖐", "✋", "🖖", "👌", "🤌", "🤏", "✌️", "🤞",
      "🤟", "🤘", "🤙", "👈", "👉", "👆", "👇", "☝️", "👍", "👎",
      "✊", "👊", "🤛", "🤜", "👏", "🙌", "👐", "🤲", "🤝", "🙏",
    ],
  },
  {
    name: "Nature",
    emoji: [
      "🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯",
      "🦁", "🐮", "🐷", "🐸", "🐵", "🐔", "🐧", "🐦", "🐤", "🦄",
      "🌸", "🌹", "🌺", "🌻", "🌼", "🌷", "🌱", "🌲", "🌳", "🍀",
    ],
  },
  {
    name: "Food",
    emoji: [
      "🍎", "🍊", "🍋", "🍌", "🍉", "🍇", "🍓", "🍒", "🍑", "🍍",
      "🥝", "🍔", "🍟", "🍕", "🌭", "🍿", "🧀", "🥚", "🍳", "🥓",
      "☕", "🍵", "🍺", "🍻", "🥂", "🍷", "🍸", "🍹", "🍾", "🧁",
    ],
  },
  {
    name: "Objects",
    emoji: [
      "⚽", "🏀", "🏈", "⚾", "🎾", "🎮", "🎲", "🎯", "🎵", "🎶",
      "💡", "🔥", "⭐", "🌟", "💫", "✨", "💥", "❤️", "🧡", "💛",
      "💚", "💙", "💜", "🖤", "🤍", "💯", "💢", "💬", "👁‍🗨", "🗨",
    ],
  },
  {
    name: "Symbols",
    emoji: [
      "✅", "❌", "❓", "❗", "‼️", "⁉️", "💤", "💮", "♻️", "🔰",
      "⚠️", "🚫", "🔴", "🟠", "🟡", "🟢", "🔵", "🟣", "⚫", "⚪",
    ],
  },
];

const MAX_RECENT = 20;
const RECENT_KEY = "owncord:recent-emoji";

// ---------------------------------------------------------------------------
// Recent emoji persistence
// ---------------------------------------------------------------------------

function getRecentEmoji(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is string => typeof e === "string").slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

function addRecentEmoji(emoji: string): void {
  const recent = getRecentEmoji().filter((e) => e !== emoji);
  recent.unshift(emoji);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, MAX_RECENT)));
  } catch {
    // localStorage full or unavailable — ignore
  }
}

// ---------------------------------------------------------------------------
// EmojiPicker
// ---------------------------------------------------------------------------

export function createEmojiPicker(options: EmojiPickerOptions): {
  readonly element: HTMLDivElement;
  destroy(): void;
} {
  const abortController = new AbortController();
  const signal = abortController.signal;

  let searchQuery = "";

  // Build DOM
  const root = createElement("div", { class: "emoji-picker" });

  // Search bar
  const searchInput = createElement("input", {
    class: "emoji-picker__search",
    type: "text",
    placeholder: "Search emoji...",
  });

  // Category tabs
  const tabBar = createElement("div", { class: "emoji-picker__tabs" });

  // Grid area
  const gridArea = createElement("div", { class: "emoji-picker__grid-area" });

  appendChildren(root, searchInput, tabBar, gridArea);

  // Build categories with recent + custom
  function getAllCategories(): readonly EmojiCategory[] {
    const recent = getRecentEmoji();
    const cats: EmojiCategory[] = [
      { name: "Recent", emoji: recent },
    ];

    // Custom server emoji
    if (options.customEmoji && options.customEmoji.length > 0) {
      cats.push({
        name: "Custom",
        emoji: options.customEmoji.map((e) => `:${e.shortcode}:`),
      });
    }

    // Add built-in categories (skip the empty "Recent" placeholder)
    for (const cat of CATEGORIES) {
      if (cat.name === "Recent") continue;
      cats.push(cat);
    }

    return cats;
  }

  function renderTabs(categories: readonly EmojiCategory[], activeIndex: number): void {
    clearChildren(tabBar);
    categories.forEach((cat, i) => {
      if (cat.name === "Recent" && cat.emoji.length === 0) return;
      const tab = createElement("button", {
        class: i === activeIndex ? "emoji-tab emoji-tab--active" : "emoji-tab",
        type: "button",
      });
      // Use first emoji of category as tab icon, or name
      const label = cat.emoji[0] ?? cat.name.charAt(0);
      setText(tab, label);
      tab.title = cat.name;
      tab.addEventListener("click", () => renderGrid(categories, i), { signal });
      tabBar.appendChild(tab);
    });
  }

  function renderGrid(categories: readonly EmojiCategory[], activeIndex: number): void {
    clearChildren(gridArea);
    renderTabs(categories, activeIndex);

    const cat = categories[activeIndex];
    if (!cat) return;

    const filtered = searchQuery
      ? cat.emoji.filter((e) => e.toLowerCase().includes(searchQuery.toLowerCase()))
      : cat.emoji;

    if (filtered.length === 0) {
      const empty = createElement("div", { class: "emoji-picker__empty" }, "No emoji found");
      gridArea.appendChild(empty);
      return;
    }

    const grid = createElement("div", { class: "emoji-grid" });
    for (const emoji of filtered) {
      const btn = createElement("button", {
        class: "emoji-cell",
        type: "button",
        "aria-label": emoji,
      });
      setText(btn, emoji);
      btn.addEventListener("click", () => {
        addRecentEmoji(emoji);
        options.onSelect(emoji);
      }, { signal });
      grid.appendChild(btn);
    }
    gridArea.appendChild(grid);
  }

  function renderSearchResults(categories: readonly EmojiCategory[]): void {
    clearChildren(gridArea);
    // Flatten all emoji matching search
    const allEmoji: string[] = [];
    for (const cat of categories) {
      for (const e of cat.emoji) {
        if (e.toLowerCase().includes(searchQuery.toLowerCase())) {
          allEmoji.push(e);
        }
      }
    }
    // Deduplicate
    const unique = [...new Set(allEmoji)];

    if (unique.length === 0) {
      const empty = createElement("div", { class: "emoji-picker__empty" }, "No emoji found");
      gridArea.appendChild(empty);
      return;
    }

    const grid = createElement("div", { class: "emoji-grid" });
    for (const emoji of unique) {
      const btn = createElement("button", {
        class: "emoji-cell",
        type: "button",
        "aria-label": emoji,
      });
      setText(btn, emoji);
      btn.addEventListener("click", () => {
        addRecentEmoji(emoji);
        options.onSelect(emoji);
      }, { signal });
      grid.appendChild(btn);
    }
    gridArea.appendChild(grid);
  }

  // Initial render
  const categories = getAllCategories();
  const startIndex = categories[0]?.emoji.length ? 0 : 1; // skip empty Recent
  renderGrid(categories, startIndex);

  // Search handler
  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value.trim();
    const cats = getAllCategories();
    if (searchQuery) {
      renderSearchResults(cats);
    } else {
      renderGrid(cats, startIndex);
    }
  }, { signal });

  // Close on Escape
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      options.onClose();
    }
  }, { signal });

  // Close on click outside (handled by parent, but support Escape here)
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      options.onClose();
    }
  }, { signal });

  // Focus search on mount
  requestAnimationFrame(() => searchInput.focus());

  function destroy(): void {
    abortController.abort();
  }

  return { element: root, destroy };
}
