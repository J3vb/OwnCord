import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  emojiCatalog,
  emojiMatches,
  loadEmojiCatalog,
  setSkinTone,
  skinTone,
  withSkinTone,
  type EmojiCatalog,
  type UnicodeEmoji,
} from "./emojiCatalog";

/** Server `maxReactionRunes` (Server/service/message_reactions.go). */
const MAX_REACTION_RUNES = 34;

let catalog: EmojiCatalog;

beforeAll(async () => {
  catalog = await loadEmojiCatalog();
});

beforeEach(() => {
  localStorage.clear();
});

function entry(char: string): UnicodeEmoji {
  const e = catalog.byChar.get(char);
  if (e === undefined) throw new Error(`no catalog entry for ${char}`);
  return e;
}

describe("loadEmojiCatalog", () => {
  it("loads the full Unicode set, grouped in Unicode order", () => {
    expect(emojiCatalog()).toBe(catalog);
    expect(catalog.groups.map((g) => g.key)).toEqual([
      "smileys",
      "people",
      "nature",
      "food",
      "travel",
      "activities",
      "objects",
      "symbols",
      "flags",
    ]);
    const total = catalog.groups.reduce((n, g) => n + g.emoji.length, 0);
    expect(total).toBeGreaterThan(1800);
    expect(catalog.byChar.has("🇩🇪")).toBe(true);
    expect(catalog.byChar.has("🧑‍🚀")).toBe(true);
  });

  it("returns the same promise on every call", () => {
    expect(loadEmojiCatalog()).toBe(loadEmojiCatalog());
  });

  it("keeps the curated keywords, so the existing names still match", () => {
    expect(entry("🔥").names[0]).toBe("fire");
    expect(emojiMatches(entry("🔥"), "flame")).toBe(true);
  });

  it("names an emoji by its Discord name ahead of its Unicode shortcode", () => {
    expect(entry("❤️").names).toEqual(["heart", "love", "red_heart"]);
    expect(entry("⭐").names).toEqual(["star"]);
    expect(emojiMatches(entry("❤️"), "red heart")).toBe(true);
  });

  it("matches a shortcode written without underscores", () => {
    expect(emojiMatches(entry("👍"), "thumbsup")).toBe(true);
    expect(emojiMatches(entry("😂"), "tears_of_joy")).toBe(true);
    expect(emojiMatches(entry("😂"), "zzzz")).toBe(false);
  });

  it("indexes every skin-tone variant under its base emoji", () => {
    expect(catalog.byChar.get("👍🏽")).toBe(entry("👍"));
    expect(catalog.byChar.get("🧑🏿‍🤝‍🧑🏿")).toBe(entry("🧑‍🤝‍🧑"));
  });

  it("finds an emoji stored without its presentation selector by older pickers", () => {
    expect(catalog.byChar.get("\u{1F590}")).toBe(entry("🖐️"));
    expect(catalog.byChar.get("\u{1F441}‍\u{1F5E8}")).toBe(entry("👁️‍🗨️"));
    expect(catalog.byChar.get("\u{1F5E8}")).toBe(entry("🗨️"));
  });

  it("fits every emoji and skin-tone variant under the server's reaction cap", () => {
    for (const char of catalog.byChar.keys()) {
      expect([...char].length).toBeLessThanOrEqual(MAX_REACTION_RUNES);
    }
  });
});

describe("withSkinTone", () => {
  it("leaves an emoji unchanged at the default tone", () => {
    expect(withSkinTone(entry("👍"), 0)).toBe("👍");
  });

  it("appends the modifier to a single-person emoji", () => {
    expect(withSkinTone(entry("👍"), 3)).toBe("👍🏽");
  });

  it("replaces the presentation selector the modifier stands in for", () => {
    expect(withSkinTone(entry("☝️"), 1)).toBe("☝🏻");
    expect(withSkinTone(entry("🕵️‍♀️"), 5)).toBe("🕵🏿‍♀️");
  });

  it("tones only the person in a ZWJ sequence, and every person in a group", () => {
    expect(withSkinTone(entry("🏃‍♂️"), 2)).toBe("🏃🏼‍♂️");
    expect(withSkinTone(entry("🧑‍🤝‍🧑"), 4)).toBe("🧑🏾‍🤝‍🧑🏾");
    expect(withSkinTone(entry("👩‍❤️‍💋‍👨"), 3)).toBe("👩🏽‍❤️‍💋‍👨🏽");
  });

  it("never tones an emoji that has no skin-tone variants", () => {
    expect(withSkinTone(entry("😀"), 3)).toBe("😀");
    expect(withSkinTone(entry("🇩🇪"), 3)).toBe("🇩🇪");
  });
});

describe("skin-tone preference", () => {
  it("defaults to no tone and remembers the chosen one", () => {
    expect(skinTone()).toBe(0);
    setSkinTone(3);
    expect(skinTone()).toBe(3);
  });

  it("falls back to no tone for a corrupt stored value", () => {
    localStorage.setItem("owncord:settings:emojiSkinTone", "9");
    expect(skinTone()).toBe(0);
    localStorage.setItem("owncord:settings:emojiSkinTone", "1.5");
    expect(skinTone()).toBe(0);
  });
});
