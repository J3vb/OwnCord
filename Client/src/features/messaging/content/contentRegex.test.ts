import { describe, expect, it } from "vitest";
import { stripMaskedLinks, stripSpoilers } from "./contentRegex";
import { extractUrls } from "./media";

// The patterns the two scanners replaced, kept here as the reference they
// must agree with.
const MASKED_LINK_PATTERN = /\[[^\]\n]+\]\((?:[^()\s]|\([^()\s]*\))+\)/g;
const SPOILER_PATTERN = /\|\|(?!\|)(?:\\[\s\S]|(?!\|\|)[^\\])+\|\|/g;

const MASKED_CASES = [
  "",
  "plain text with no links",
  "see [the docs](https://example.com/docs) for more",
  "[a](https://a.example) and [b](https://b.example/x?y=1)",
  "[Rust](https://en.wikipedia.org/wiki/Rust_(programming_language)) is nice",
  "[empty]() is not a link",
  "[](https://example.com) has no text",
  "[spaced](https://example.com/a b) breaks at the space",
  "[multi\nline](https://example.com) is not one link",
  "[outer [inner](https://in.example) tail](https://out.example)",
  "[[nested]](https://example.com)",
  "[a[b](https://x.example)",
  "a ] stray [bracket (https://example.com)",
  "[unclosed text (https://example.com)",
  "[text](https://example.com",
  "[text](https://example.com/((double)))",
  "[text](https://e.example/(a)(b)/c)",
  "[text](https://e.example/(a b))",
  "[x](y)[z](w)",
  "[x]\n(y)",
  "[a](b\u00a0c)",
  "emoji [😀](https://e.example/😀) ok",
  "\\[escaped](https://example.com)",
];

const SPOILER_CASES = [
  "",
  "no pipes here",
  "a | lone pipe",
  "||hidden||",
  "before ||https://hidden.example|| after",
  "||one|| and ||two||",
  "||||",
  "|||x||",
  "||x|||",
  "||unclosed spoiler",
  "||a\\||b||",
  "||a\\\\||b||",
  "||ends with backslash\\",
  "||multi\nline\n\nspoiler||",
  "a||b||c||d",
  "||a\\||a\\||a\\||a",
  "\\||not a spoiler||",
  "||😀||",
  "x ||| y || z ||",
];

describe("stripMaskedLinks", () => {
  it.each(MASKED_CASES)("removes the same spans as the pattern: %j", (input) => {
    expect(stripMaskedLinks(input)).toBe(input.replace(MASKED_LINK_PATTERN, ""));
  });
});

describe("stripSpoilers", () => {
  it.each(SPOILER_CASES)("removes the same spans as the pattern: %j", (input) => {
    expect(stripSpoilers(input)).toBe(input.replace(SPOILER_PATTERN, ""));
  });
});

/** A small seeded generator, so a failure names a reproducible input. */
function seededStrings(alphabet: string, count: number, seed: number): string[] {
  let state = seed;
  const next = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state;
  };
  const out: string[] = [];
  for (let n = 0; n < count; n++) {
    const len = next() % 24;
    let s = "";
    for (let k = 0; k < len; k++) s += alphabet[next() % alphabet.length];
    out.push(s);
  }
  return out;
}

describe("the scanners over generated text", () => {
  it("agree with the masked-link pattern on every string", () => {
    for (const input of seededStrings("[]()a \n", 4000, 7)) {
      expect(stripMaskedLinks(input), JSON.stringify(input)).toBe(
        input.replace(MASKED_LINK_PATTERN, ""),
      );
    }
  });

  it("agree with the spoiler pattern on every string", () => {
    for (const input of seededStrings("||\\a\n", 4000, 11)) {
      expect(stripSpoilers(input), JSON.stringify(input)).toBe(input.replace(SPOILER_PATTERN, ""));
    }
  });
});

describe("the scanners on long text", () => {
  it("finish on long runs of unclosed openers", () => {
    const n = 400_000;
    expect(stripMaskedLinks("[".repeat(n))).toHaveLength(n);
    expect(stripMaskedLinks("[a](".repeat(n / 4))).toHaveLength(n);
    expect(stripSpoilers("||a\\".repeat(n / 4))).toHaveLength(n);
    const closing = "||a\\||a".repeat(50_000);
    expect(stripSpoilers(closing)).toBe(closing.replace(SPOILER_PATTERN, ""));
    expect(extractUrls("[".repeat(n))).toEqual([]);
  }, 10_000);
});
