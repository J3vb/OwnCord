// EmojiPicker — grid-based emoji selector with search and scrollable categories.
// Uses @lib/dom helpers exclusively. Never sets innerHTML with user content.

import { Disposable } from "@lib/disposable";
import { createElement, setText, clearChildren } from "@lib/dom";
import { enableRovingNavigation, setRovingTabindex } from "@lib/a11y";
import { buildCustomEmojiNode } from "@components/message-list/custom-emoji";
import { EMOJI_NAMES } from "@components/emoji-keywords";
import { messagingText } from "../i18n/messaging";
import { resolveEmoji } from "@stores/emoji.store";

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
  readonly onSelect: (emoji: string) => void;
  readonly onClose: () => void;
}

/** The catalog key the server's own emoji appear under. */
export const SERVER_CATEGORY = "emoji.category.server" as const;

/** A category heading; the key is resolved through the messaging catalog. */
type EmojiCategoryKey =
  | typeof SERVER_CATEGORY
  | "emoji.category.recent"
  | "emoji.category.smileys"
  | "emoji.category.people"
  | "emoji.category.nature"
  | "emoji.category.food"
  | "emoji.category.objects"
  | "emoji.category.symbols";

// ---------------------------------------------------------------------------
// Built-in emoji data (common subset by category)
// ---------------------------------------------------------------------------

interface EmojiCategory {
  readonly name: EmojiCategoryKey;
  readonly emoji: readonly string[];
}

const CATEGORIES: readonly EmojiCategory[] = [
  {
    name: "emoji.category.recent",
    emoji: [], // populated at runtime from localStorage
  },
  {
    name: "emoji.category.smileys",
    emoji: [
      "😀",
      "😃",
      "😄",
      "😁",
      "😆",
      "😅",
      "🤣",
      "😂",
      "🙂",
      "😊",
      "😇",
      "🥰",
      "😍",
      "🤩",
      "😘",
      "😗",
      "😋",
      "😛",
      "😜",
      "🤪",
      "😝",
      "🤑",
      "🤗",
      "🤭",
      "🤫",
      "🤔",
      "🤐",
      "🤨",
      "😐",
      "😑",
      "😶",
      "😏",
      "😒",
      "🙄",
      "😬",
      "🤥",
      "😌",
      "😔",
      "😪",
      "🤤",
      "😴",
      "😷",
      "🤒",
      "🤕",
      "🤢",
      "🤮",
      "🥵",
      "🥶",
      "🥴",
      "😵",
      "🤯",
      "🤠",
      "🥳",
      "😎",
      "🤓",
      "🧐",
      "😕",
      "😟",
      "🙁",
      "😮",
      "😲",
      "😳",
      "🥺",
      "😢",
      "😭",
      "😤",
      "😠",
      "😡",
      "🤬",
      "💀",
    ],
  },
  {
    name: "emoji.category.people",
    emoji: [
      "👋",
      "🤚",
      "🖐",
      "✋",
      "🖖",
      "👌",
      "🤌",
      "🤏",
      "✌️",
      "🤞",
      "🤟",
      "🤘",
      "🤙",
      "👈",
      "👉",
      "👆",
      "👇",
      "☝️",
      "👍",
      "👎",
      "✊",
      "👊",
      "🤛",
      "🤜",
      "👏",
      "🙌",
      "👐",
      "🤲",
      "🤝",
      "🙏",
    ],
  },
  {
    name: "emoji.category.nature",
    emoji: [
      "🐶",
      "🐱",
      "🐭",
      "🐹",
      "🐰",
      "🦊",
      "🐻",
      "🐼",
      "🐨",
      "🐯",
      "🦁",
      "🐮",
      "🐷",
      "🐸",
      "🐵",
      "🐔",
      "🐧",
      "🐦",
      "🐤",
      "🦄",
      "🌸",
      "🌹",
      "🌺",
      "🌻",
      "🌼",
      "🌷",
      "🌱",
      "🌲",
      "🌳",
      "🍀",
    ],
  },
  {
    name: "emoji.category.food",
    emoji: [
      "🍎",
      "🍊",
      "🍋",
      "🍌",
      "🍉",
      "🍇",
      "🍓",
      "🍒",
      "🍑",
      "🍍",
      "🥝",
      "🍔",
      "🍟",
      "🍕",
      "🌭",
      "🍿",
      "🧀",
      "🥚",
      "🍳",
      "🥓",
      "☕",
      "🍵",
      "🍺",
      "🍻",
      "🥂",
      "🍷",
      "🍸",
      "🍹",
      "🍾",
      "🧁",
    ],
  },
  {
    name: "emoji.category.objects",
    emoji: [
      "⚽",
      "🏀",
      "🏈",
      "⚾",
      "🎾",
      "🎮",
      "🎲",
      "🎯",
      "🎵",
      "🎶",
      "💡",
      "🔥",
      "⭐",
      "🌟",
      "💫",
      "✨",
      "💥",
      "❤️",
      "🧡",
      "💛",
      "💚",
      "💙",
      "💜",
      "🖤",
      "🤍",
      "💯",
      "💢",
      "💬",
      "👁‍🗨",
      "🗨",
    ],
  },
  {
    name: "emoji.category.symbols",
    emoji: [
      "✅",
      "❌",
      "❓",
      "❗",
      "‼️",
      "⁉️",
      "💤",
      "💮",
      "♻️",
      "🔰",
      "⚠️",
      "🚫",
      "🔴",
      "🟠",
      "🟡",
      "🟢",
      "🔵",
      "🟣",
      "⚫",
      "⚪",
    ],
  },
];

const MAX_RECENT = 20;
const RECENT_KEY = "owncord:recent-emoji";

// ---------------------------------------------------------------------------
// Recent emoji persistence
// ---------------------------------------------------------------------------

/**
 * What is actually on disk: parsed, type-checked, capped. No display
 * filtering — this is the list the write path must preserve.
 */
function readStoredRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is string => typeof e === "string");
  } catch {
    return [];
  }
}

/**
 * What the picker should show, which is a strict subset of what is stored.
 *
 * Display only — never feed this back into `localStorage` (OC-0363). The
 * recent list is a single key shared by every server this client connects to,
 * so a `:shortcode:` that does not resolve *here* is routinely alive on
 * another server, or alive on this one a moment later once `GET /emoji`
 * lands, or after a failed fetch is retried. Persisting the filtered list
 * turns "do not show this" into "delete this", for every server at once.
 */
function getRecentEmoji(): string[] {
  try {
    // A `:shortcode:`-shaped entry is only meaningful when it still resolves
    // on *this* server: a custom emoji clicked on one server would otherwise
    // leak as dead literal text into every other server's picker, and a
    // deleted emoji would do the same on its own server forever after. Plain
    // unicode entries (no colons) are never shortcode-shaped and pass through
    // untouched (OC-0308).
    return readStoredRecent()
      .filter((e) => !(e.startsWith(":") && e.endsWith(":")) || resolveEmoji(e) !== null)
      .slice(0, MAX_RECENT);
  } catch {
    // resolveEmoji reads the emoji store. A throw here used to be swallowed by
    // the reader's own try/catch and degrade to an empty Recent row; without
    // this it would propagate out of createEmojiPicker and take the composer's
    // emoji button and the reaction picker down with it.
    return [];
  }
}

function addRecentEmoji(emoji: string): void {
  const recent = readStoredRecent().filter((e) => e !== emoji);
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
  root.appendChild(header);

  // Scrollable content area (holds category labels + grids). Announced as a
  // single flat listbox — the category grids are visual grouping only, and
  // roving tabindex (DC-13) treats every .ep-emoji cell as one list.
  const scrollArea = createElement("div", {
    style: "overflow-y: auto; max-height: 320px;",
    role: "listbox",
    "aria-label": messagingText("emoji.listLabel"),
  });
  root.appendChild(scrollArea);
  enableRovingNavigation(scrollArea, ".ep-emoji", signal);

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
      handleEmojiClick(emoji);
    },
    { signal },
  );

  // Build categories with recent + custom
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

    // Add built-in categories (skip the empty "Recent" placeholder)
    for (const cat of CATEGORIES) {
      if (cat.name === "emoji.category.recent") continue;
      cats.push(cat);
    }

    return cats;
  }

  function handleEmojiClick(emoji: string): void {
    addRecentEmoji(emoji);
    options.onSelect(emoji);
  }

  function renderAllCategories(categories: readonly EmojiCategory[]): void {
    clearChildren(scrollArea);

    for (const cat of categories) {
      if (cat.emoji.length === 0) continue;

      const filtered = searchQuery
        ? cat.emoji.filter((e) => {
            const q = searchQuery.toLowerCase();
            // Match against emoji name/keywords, or the character itself
            const name = EMOJI_NAMES[e];
            if (name !== undefined && name.includes(q)) return true;
            // Also match custom emoji shortcodes like :wave:
            return e.toLowerCase().includes(q);
          })
        : cat.emoji;

      if (filtered.length === 0) continue;

      const label = createElement("div", { class: "ep-category-label" });
      setText(label, messagingText(cat.name));
      scrollArea.appendChild(label);

      const grid = createElement("div", { class: "ep-grid" });
      for (const emoji of filtered) {
        grid.appendChild(buildEmojiSpan(emoji));
      }
      scrollArea.appendChild(grid);
    }

    // If nothing rendered at all, show empty state
    if (scrollArea.children.length === 0) {
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
  }

  // Initial render
  renderAllCategories(getAllCategories());

  // Search handler
  searchInput.addEventListener(
    "input",
    () => {
      searchQuery = searchInput.value.trim();
      renderAllCategories(getAllCategories());
    },
    { signal },
  );

  // Close on Escape
  root.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape") {
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
