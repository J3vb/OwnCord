import { beforeEach, describe, expect, it, vi } from "vitest";

// A small hand-written set, so every parsing and lookup rule is pinned by rows
// the test can read. The real set is covered by emojiCatalog.test.ts.
vi.mock("./emojiData", () => ({
  EMOJI_GROUPS: [
    [
      "smileys",
      [
        "😀||grin grinning_face|happy smile",
        "🙂||plain",
        "☝️|0|point_up|finger",
        "\u261D\uFE0F\uFE0F||double_selector|",
        "❤️||heart",
        "👍|0|thumbs_up|like",
        "🖐|0|hand",
        "dup1||dup|",
        "dup2||dup|",
        "tu||thumbsup|",
        "fd||flag_de|",
        "pq1||p_q|",
        "pq2||pq_|",
        "only",
        "partial||names_only",
      ].join("\n"),
    ],
    ["people", "🧑‍🤝‍🧑|02|people_holding_hands|friends"],
  ],
}));

import {
  emojiCatalog,
  emojiForShortcode,
  emojiMatches,
  loadEmojiCatalog,
  setSkinTone,
  SKIN_TONES,
  skinTone,
  withSkinTone,
  type EmojiCatalog,
  type UnicodeEmoji,
} from "./emojiCatalog";

const TONES = ["", "\u{1F3FB}", "\u{1F3FC}", "\u{1F3FD}", "\u{1F3FE}", "\u{1F3FF}"];

// Everything the load builds is built once, during the first test that asks for it, so
// every rule of the parse and of the shortcode index is asserted in this one test.
describe("the loaded set", () => {
  it("parses every row and indexes names, tones and selector-less forms", async () => {
    expect(emojiCatalog()).toBeNull();
    expect(emojiForShortcode("grin")).toBeNull();

    const catalog = await loadEmojiCatalog();
    const entry = (char: string): UnicodeEmoji => {
      const e = catalog.byChar.get(char);
      if (e === undefined) throw new Error(`no entry for ${char}`);
      return e;
    };

    // The tone list, then the groups in the order given.
    expect(SKIN_TONES).toEqual(TONES);
    expect(emojiCatalog()).toBe(catalog);
    expect(await loadEmojiCatalog()).toBe(catalog);
    expect(catalog.groups.map((g) => g.key)).toEqual(["smileys", "people"]);
    expect(catalog.groups[0]?.emoji).toHaveLength(15);
    expect(catalog.groups[1]?.emoji).toHaveLength(1);

    // A row splits into character, tone segments, names and keywords.
    expect(entry("😀")).toEqual({
      char: "😀",
      tone: "",
      names: ["grin", "grinning_face"],
      keywords: "happy smile grin grinning_face",
    });
    expect(entry("🙂").keywords).toBe("plain");
    expect(entry("tu").keywords).toBe("thumbsup");
    expect(entry("🧑‍🤝‍🧑")).toMatchObject({ tone: "02", names: ["people_holding_hands"] });

    // A short row is filled with empty fields.
    expect(entry("only")).toEqual({ char: "only", tone: "", names: [""], keywords: "" });
    expect(entry("partial")).toEqual({
      char: "partial",
      tone: "",
      names: ["names_only"],
      keywords: "names_only",
    });

    // Every tone variant of a toned emoji, and the emoji itself, point at the emoji.
    const thumbs = entry("👍");
    for (const tone of TONES) expect(catalog.byChar.get(`👍${tone}`)).toBe(thumbs);
    expect(catalog.byChar.has("👍\u{1F3FB}\u{1F3FB}")).toBe(false);
    expect(catalog.byChar.get("\u261D\uFE0F")).toBe(entry("\u261D\uFE0F"));
    expect(catalog.byChar.get("\u261D\uFE0F")?.names).toEqual(["point_up"]);
    expect(catalog.byChar.get("🧑🏾‍🤝‍🧑🏾")).toBe(entry("🧑‍🤝‍🧑"));

    // The form without the presentation selector finds the emoji, and the first emoji
    // to strip down to a form keeps it.
    expect(catalog.byChar.get("❤")).toBe(entry("❤️"));
    expect(catalog.byChar.get("\u261D")?.names).toEqual(["point_up"]);
    expect(entry("\u261D\uFE0F\uFE0F").names).toEqual(["double_selector"]);

    // Shortcodes: any name, any case, the underscore-less spelling.
    expect(emojiForShortcode("grin")?.char).toBe("😀");
    expect(emojiForShortcode("grinning_face")?.char).toBe("😀");
    expect(emojiForShortcode("GRIN")?.char).toBe("😀");
    expect(emojiForShortcode("nope")).toBeNull();
    expect(emojiForShortcode("flagde")?.char).toBe("fd");
    expect(emojiForShortcode("pointup")?.char).toBe("\u261D\uFE0F");
    expect(emojiForShortcode("grinningface")?.char).toBe("😀");

    // An exact name beats an underscore-less match; the first claimant of a name wins.
    expect(emojiForShortcode("thumbsup")?.char).toBe("tu");
    expect(emojiForShortcode("thumbs_up")?.char).toBe("👍");
    expect(emojiForShortcode("dup")?.char).toBe("dup1");
    expect(emojiForShortcode("pq")?.char).toBe("pq1");
    expect(emojiForShortcode("p_q")?.char).toBe("pq1");
    expect(emojiForShortcode("pq_")?.char).toBe("pq2");
    expect(emojiForShortcode("grin")).toBe(emojiForShortcode("grin"));
  });
});

describe("withSkinTone on parsed rows", () => {
  let catalog: EmojiCatalog;

  beforeEach(async () => {
    catalog = await loadEmojiCatalog();
  });

  function entry(char: string): UnicodeEmoji {
    const e = catalog.byChar.get(char);
    if (e === undefined) throw new Error(`no entry for ${char}`);
    return e;
  }

  it("returns the emoji untouched at the default tone, selector included", () => {
    expect(withSkinTone(entry("☝️"), 0)).toBe("☝️");
  });

  it("returns the emoji untouched for a tone index outside the list", () => {
    expect(withSkinTone(entry("👍"), 6)).toBe("👍");
    expect(withSkinTone(entry("👍"), -1)).toBe("👍");
    expect(withSkinTone(entry("👍"), 99)).toBe("👍");
  });

  it("applies each of the five modifiers", () => {
    expect(TONES.slice(1).map((_, i) => withSkinTone(entry("👍"), i + 1))).toEqual(
      TONES.slice(1).map((t) => `👍${t}`),
    );
  });

  it("tones every listed segment of a joined sequence", () => {
    expect(withSkinTone(entry("🧑‍🤝‍🧑"), 2)).toBe("🧑🏼‍🤝‍🧑🏼");
  });
});

describe("emojiMatches", () => {
  const e: UnicodeEmoji = {
    char: "👍",
    tone: "",
    names: ["thumbs_up"],
    keywords: "like thumbs_up",
  };

  it("finds a keyword fragment", () => {
    expect(emojiMatches(e, "lik")).toBe(true);
    expect(emojiMatches(e, "zzz")).toBe(false);
  });

  it("finds a query written without the underscores", () => {
    expect(emojiMatches(e, "thumbsup")).toBe(true);
    expect(emojiMatches(e, "thumbs_up")).toBe(true);
  });

  it("does not match a query that only matches once something else is removed", () => {
    expect(emojiMatches(e, "likethumbsupx")).toBe(false);
    expect(emojiMatches(e, "Stryker")).toBe(false);
  });
});

describe("skin-tone preference storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("stores the tone under its own preference key", () => {
    setSkinTone(4);
    expect(localStorage.getItem("owncord:settings:emojiSkinTone")).toBe("4");
  });

  it("reads the tone from that key", () => {
    localStorage.setItem("owncord:settings:emojiSkinTone", "2");
    expect(skinTone()).toBe(2);
  });

  it("accepts the first and last tones and nothing outside them", () => {
    for (const [stored, expected] of [
      ["0", 0],
      ["5", 5],
      ["6", 0],
      ["-1", 0],
    ] as const) {
      localStorage.setItem("owncord:settings:emojiSkinTone", stored);
      expect(skinTone()).toBe(expected);
    }
  });
});
