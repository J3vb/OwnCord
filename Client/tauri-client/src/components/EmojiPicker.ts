// EmojiPicker — grid-based emoji selector with search and scrollable categories.
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

  // Build DOM — matches mockup structure:
  // .emoji-picker.open > .ep-header > input.ep-search
  //   then repeating: .ep-category-label + .ep-grid > span.ep-emoji
  const root = createElement("div", { class: "emoji-picker open" });

  const header = createElement("div", { class: "ep-header" });
  const searchInput = createElement("input", {
    class: "ep-search",
    type: "text",
    placeholder: "Search emoji...",
  });
  header.appendChild(searchInput);
  root.appendChild(header);

  // Scrollable content area (holds category labels + grids)
  const scrollArea = createElement("div", {
    style: "overflow-y: auto; max-height: 320px;",
  });
  root.appendChild(scrollArea);

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

  function handleEmojiClick(emoji: string): void {
    addRecentEmoji(emoji);
    options.onSelect(emoji);
  }

  function buildEmojiSpan(emoji: string): HTMLSpanElement {
    const span = createElement("span", {
      class: "ep-emoji",
      title: emoji,
    });
    setText(span, emoji);
    span.addEventListener("click", () => handleEmojiClick(emoji), { signal });
    return span;
  }

  function renderAllCategories(categories: readonly EmojiCategory[]): void {
    clearChildren(scrollArea);

    for (const cat of categories) {
      if (cat.emoji.length === 0) continue;

      const filtered = searchQuery
        ? cat.emoji.filter((e) => e.toLowerCase().includes(searchQuery.toLowerCase()))
        : cat.emoji;

      if (filtered.length === 0) continue;

      const label = createElement("div", { class: "ep-category-label" });
      setText(label, cat.name);
      scrollArea.appendChild(label);

      const grid = createElement("div", { class: "ep-grid" });
      for (const emoji of filtered) {
        grid.appendChild(buildEmojiSpan(emoji));
      }
      scrollArea.appendChild(grid);
    }

    // If nothing rendered at all, show empty state
    if (scrollArea.children.length === 0) {
      const empty = createElement("div", {
        style: "padding: 24px; text-align: center; color: var(--text-faint); font-size: 13px;",
      }, "No emoji found");
      scrollArea.appendChild(empty);
    }
  }

  // Initial render
  renderAllCategories(getAllCategories());

  // Search handler
  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value.trim();
    renderAllCategories(getAllCategories());
  }, { signal });

  // Close on Escape
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
