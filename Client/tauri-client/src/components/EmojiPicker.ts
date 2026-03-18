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

/** Emoji name lookup for search. Maps emoji character → searchable keywords. */
const EMOJI_NAMES: Readonly<Record<string, string>> = {
  "😀": "grinning face happy smile", "😃": "smiley face happy smile", "😄": "smile happy grin",
  "😁": "beaming grin teeth smile", "😆": "laughing happy squint smile", "😅": "sweat smile nervous",
  "🤣": "rofl laughing rolling floor", "😂": "joy tears laughing cry happy", "🙂": "slightly smiling",
  "😊": "blush happy smile shy", "😇": "innocent angel halo", "🥰": "love hearts face smiling",
  "😍": "heart eyes love", "🤩": "star struck excited", "😘": "kiss blowing wink",
  "😗": "kissing face", "😋": "yummy delicious tongue food", "😛": "tongue out",
  "😜": "wink tongue playful", "🤪": "zany crazy wild", "😝": "squinting tongue",
  "🤑": "money face rich dollar", "🤗": "hugging hug hands", "🤭": "hand over mouth oops giggle",
  "🤫": "shushing quiet secret shh", "🤔": "thinking hmm wonder", "🤐": "zipper mouth shut secret",
  "🤨": "raised eyebrow skeptical", "😐": "neutral face blank", "😑": "expressionless blank",
  "😶": "no mouth silent mute", "😏": "smirk smug", "😒": "unamused bored annoyed",
  "🙄": "eye roll whatever", "😬": "grimace awkward teeth", "🤥": "lying pinocchio nose",
  "😌": "relieved calm peaceful", "😔": "pensive sad thoughtful", "😪": "sleepy tired",
  "🤤": "drooling hungry", "😴": "sleeping zzz tired", "😷": "mask sick medical face",
  "🤒": "thermometer sick fever", "🤕": "bandage hurt injured", "🤢": "nauseous sick green",
  "🤮": "vomiting throw up sick", "🥵": "hot face overheated", "🥶": "cold face freezing",
  "🥴": "woozy drunk dizzy", "😵": "dizzy spiral knocked out", "🤯": "mind blown exploding head",
  "🤠": "cowboy hat yeehaw", "🥳": "party celebration birthday", "😎": "sunglasses cool",
  "🤓": "nerd glasses geek", "🧐": "monocle detective inspect", "😕": "confused puzzled",
  "😟": "worried concerned", "🙁": "frowning sad", "😮": "open mouth surprised",
  "😲": "astonished shocked wow", "😳": "flushed embarrassed", "🥺": "pleading puppy eyes please",
  "😢": "crying sad tear", "😭": "sobbing crying loud", "😤": "steam nose angry huffing",
  "😠": "angry mad", "😡": "rage furious red", "🤬": "cursing swearing symbols angry",
  "💀": "skull dead death skeleton",
  "👋": "wave hello hi bye hand", "🤚": "raised back hand", "🖐": "hand fingers splayed five",
  "✋": "raised hand stop high five", "🖖": "vulcan spock", "👌": "ok okay perfect",
  "🤌": "pinched fingers italian", "🤏": "pinching small little", "✌️": "peace victory two",
  "🤞": "crossed fingers luck hope", "🤟": "love you gesture rock",
  "🤘": "rock on horns metal", "🤙": "call me hang loose shaka", "👈": "pointing left",
  "👉": "pointing right", "👆": "pointing up", "👇": "pointing down", "☝️": "index pointing up",
  "👍": "thumbs up like good yes", "👎": "thumbs down dislike bad no",
  "✊": "raised fist power", "👊": "fist bump punch", "🤛": "left fist bump",
  "🤜": "right fist bump", "👏": "clap applause bravo", "🙌": "raising hands hooray celebrate",
  "👐": "open hands jazz", "🤲": "palms up together prayer", "🤝": "handshake deal agreement",
  "🙏": "pray thanks please folded hands",
  "🐶": "dog puppy pet", "🐱": "cat kitten pet", "🐭": "mouse rat", "🐹": "hamster",
  "🐰": "rabbit bunny", "🦊": "fox", "🐻": "bear", "🐼": "panda bear",
  "🐨": "koala", "🐯": "tiger", "🦁": "lion king", "🐮": "cow moo",
  "🐷": "pig oink", "🐸": "frog toad", "🐵": "monkey face", "🐔": "chicken hen",
  "🐧": "penguin", "🐦": "bird", "🐤": "chick baby bird", "🦄": "unicorn magic",
  "🌸": "cherry blossom flower pink", "🌹": "rose flower red", "🌺": "hibiscus flower",
  "🌻": "sunflower", "🌼": "blossom flower", "🌷": "tulip flower",
  "🌱": "seedling sprout plant", "🌲": "evergreen tree pine", "🌳": "tree deciduous", "🍀": "four leaf clover luck",
  "🍎": "red apple fruit", "🍊": "orange tangerine fruit", "🍋": "lemon fruit", "🍌": "banana fruit",
  "🍉": "watermelon fruit", "🍇": "grapes fruit", "🍓": "strawberry fruit", "🍒": "cherries fruit",
  "🍑": "peach fruit butt", "🍍": "pineapple fruit", "🥝": "kiwi fruit",
  "🍔": "hamburger burger food", "🍟": "fries french food", "🍕": "pizza food slice",
  "🌭": "hot dog food", "🍿": "popcorn snack movie", "🧀": "cheese wedge",
  "🥚": "egg", "🍳": "cooking fried egg", "🥓": "bacon",
  "☕": "coffee hot drink", "🍵": "tea hot drink", "🍺": "beer mug drink",
  "🍻": "clinking beers cheers drink", "🥂": "champagne toast celebrate drink",
  "🍷": "wine glass drink red", "🍸": "cocktail martini drink", "🍹": "tropical drink",
  "🍾": "bottle popping champagne celebrate", "🧁": "cupcake dessert sweet",
  "⚽": "soccer football ball sport", "🏀": "basketball ball sport", "🏈": "football american sport",
  "⚾": "baseball ball sport", "🎾": "tennis ball sport", "🎮": "video game controller gaming",
  "🎲": "dice game random", "🎯": "bullseye target dart", "🎵": "music note",
  "🎶": "music notes", "💡": "light bulb idea", "🔥": "fire hot flame lit",
  "⭐": "star yellow", "🌟": "glowing star sparkle", "💫": "dizzy star shooting",
  "✨": "sparkles magic shine", "💥": "boom collision crash", "❤️": "red heart love",
  "🧡": "orange heart love", "💛": "yellow heart love", "💚": "green heart love",
  "💙": "blue heart love", "💜": "purple heart love", "🖤": "black heart dark love",
  "🤍": "white heart love", "💯": "hundred percent perfect score", "💢": "anger symbol mad",
  "💬": "speech bubble chat talk", "👁‍🗨": "eye speech bubble witness", "🗨": "speech balloon left",
  "✅": "check mark yes done complete", "❌": "cross mark no wrong cancel",
  "❓": "question mark red", "❗": "exclamation mark red alert", "‼️": "double exclamation",
  "⁉️": "exclamation question", "💤": "sleeping zzz tired", "💮": "white flower",
  "♻️": "recycle green environment", "🔰": "beginner new japanese", "⚠️": "warning caution alert",
  "🚫": "prohibited forbidden no", "🔴": "red circle", "🟠": "orange circle",
  "🟡": "yellow circle", "🟢": "green circle", "🔵": "blue circle",
  "🟣": "purple circle", "⚫": "black circle", "⚪": "white circle",
};

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
