import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const catalogState = vi.hoisted(() => ({ hidden: false }));

vi.mock("./emojiCatalog", async (importOriginal) => {
  const real = await importOriginal<typeof import("./emojiCatalog")>();
  return { ...real, emojiCatalog: () => (catalogState.hidden ? null : real.emojiCatalog()) };
});

import { loadEmojiCatalog, setSkinTone, SKIN_TONES } from "./emojiCatalog";
import { replaceEmojiShortcodes } from "./shortcodes";
import { clearCustomEmoji, emojiStore, setCustomEmoji } from "../../stores/emoji.store";

const JOY = "\u{1F602}";
const WAVE = "\u{1F44B}";
const UP = "\u{1F44D}";
const DOWN = "\u{1F44E}";

function swapped(cases: ReadonlyArray<readonly [string, string]>): void {
  for (const [input, expected] of cases) expect(replaceEmojiShortcodes(input)).toBe(expected);
}

beforeAll(async () => {
  await loadEmojiCatalog();
});

beforeEach(() => {
  catalogState.hidden = false;
  localStorage.clear();
  clearCustomEmoji();
  setCustomEmoji([]);
  emojiStore.flush();
});

describe("shortcode names", () => {
  it.each([
    [":+1:", UP],
    [":-1:", DOWN],
    [":thumbs_up:", UP],
    [":o2:", "\u{1F17E}️"],
    [":ok:", "\u{1F197}"],
    [":raised_hand_with_fingers_splayed:", "\u{1F590}️"],
  ])("swaps %s", (input, expected) => {
    expect(replaceEmojiShortcodes(input)).toBe(expected);
  });

  it.each([
    ":v:",
    ":japanese_open_for_business_button:",
    ":Joy:",
    ":joy :",
    ": joy:",
    "::",
    ":j.oy:",
  ])("keeps %s as typed", (input) => {
    expect(replaceEmojiShortcodes(input)).toBe(input);
  });
});

describe("shortcode boundaries", () => {
  it.each(["a", "Z", "7", "_", "é", "中", "٣"])(
    "keeps a shortcode touching %j on either side",
    (c) => {
      for (const text of [`${c}:joy:`, `:joy:${c}`, `${c}:joy:${c}`]) {
        expect(replaceEmojiShortcodes(text)).toBe(text);
      }
    },
  );

  it.each(["-", ".", "!", "(", ")", "/", " ", "\n", "\u{1F600}"])(
    "swaps a shortcode touching %j",
    (c) => {
      expect(replaceEmojiShortcodes(`${c}:joy:${c}`)).toBe(`${c}${JOY}${c}`);
    },
  );

  it("swaps a run of shortcodes and keeps a double colon from joining them", () => {
    swapped([
      [":joy::joy::joy:", `${JOY}${JOY}${JOY}`],
      [":joy::ab::cd:", `${JOY}\u{1F18E}\u{1F4BF}`],
      ["host::ab: x", "host::ab: x"],
      ["::ab:", "::ab:"],
      ["`c`::ab:", "`c`::ab:"],
      ["fe80::ab:cd and :joy:", `fe80::ab:cd and ${JOY}`],
      ["a: b :joy:", `a: b ${JOY}`],
      [":notanemoji::ab:", ":notanemoji:\u{1F18E}"],
    ]);
  });

  it("restarts the run check in each stretch of prose", () => {
    swapped([[":joy: `c`::joy:", `${JOY} \`c\`::joy:`]]);
  });
});

describe("escaped shortcodes", () => {
  it("counts backslashes in front of the colon by odd and even", () => {
    swapped([
      ["\\:joy:", "\\:joy:"],
      ["\\\\:joy:", `\\\\${JOY}`],
      ["\\\\\\:joy:", "\\\\\\:joy:"],
      ["\\\\\\\\:joy:", `\\\\\\\\${JOY}`],
      ["x \\:joy:", "x \\:joy:"],
      ["a \\\\:joy:", `a \\\\${JOY}`],
      ["`c`\\:joy:", "`c`\\:joy:"],
      ["`c` \\:joy: :joy:", `\`c\` \\:joy: ${JOY}`],
    ]);
  });

  it("lets an escaped backtick or backslash open nothing", () => {
    swapped([
      ["\\`:joy:`", `\\\`${JOY}\``],
      ["\\\\`:joy:`", "\\\\`:joy:`"],
      ["\\[a :joy:](https://ex.com)", `\\[a ${JOY}](https://ex.com)`],
      ["\\\\[a :joy:](https://ex.com)", "\\\\[a :joy:](https://ex.com)"],
      ["\\x`:joy:`", "\\x`:joy:`"],
      ["tail \\", "tail \\"],
    ]);
  });
});

describe("protected parts", () => {
  it("leaves code fences whole and swaps text between them", () => {
    swapped([
      ["```:joy:```", "```:joy:```"],
      [
        "```\n:joy:\n``` :joy: ```\n:joy:\n```",
        `\`\`\`\n:joy:\n\`\`\` ${JOY} \`\`\`\n:joy:\n\`\`\``,
      ],
      ["a ``` :joy:", `a \`\`\` ${JOY}`],
      ["```js\nx\n```:joy:", `\`\`\`js\nx\n\`\`\`${JOY}`],
    ]);
  });

  it("leaves inline code spans whole and swaps the rest", () => {
    swapped([
      ["a `:joy:` b :joy:", `a \`:joy:\` b ${JOY}`],
      ["`a` :joy: `b`", `\`a\` ${JOY} \`b\``],
      ["``a ` :joy:`` :joy:", `\`\`a \` :joy:\`\` ${JOY}`],
      ["`a :joy:", `\`a ${JOY}`],
    ]);
  });

  it("leaves links whole up to their end and swaps text around them", () => {
    swapped([
      ["https://ex.com/:joy: :joy:", `https://ex.com/:joy: ${JOY}`],
      ["http://ex.com/:joy: :joy:", `http://ex.com/:joy: ${JOY}`],
      ["<http://ex.com/:joy:> :joy:", `<http://ex.com/:joy:> ${JOY}`],
      ["<https://ex.com/:joy:>:joy:", `<https://ex.com/:joy:>${JOY}`],
      ["ftp://ex.com/:joy:", `ftp://ex.com/${JOY}`],
      ["<https://>:joy:", `<https://>${JOY}`],
      ["<https://ex.com/a :joy:>", `<https://ex.com/a ${JOY}>`],
      [":joy: https://ex.com/:joy: :joy:", `${JOY} https://ex.com/:joy: ${JOY}`],
      ['https://ex.com/a":joy:', `https://ex.com/a"${JOY}`],
      ["https://ex.com/a':joy:", `https://ex.com/a'${JOY}`],
      ["https://ex.com/a<:joy:", `https://ex.com/a<${JOY}`],
      ["https://ex.com/a>:joy:", `https://ex.com/a>${JOY}`],
      ["https://ex.com/a\n:joy:", `https://ex.com/a\n${JOY}`],
      ["https://:joy:", "https://:joy:"],
    ]);
  });

  it("treats a masked link as one part when its text or target nests brackets", () => {
    swapped([
      ["[a :joy:](https://ex.com)", "[a :joy:](https://ex.com)"],
      ["[a [b] :joy:](https://ex.com) :joy:", `[a [b] :joy:](https://ex.com) ${JOY}`],
      ["[a\\]:joy:](https://ex.com)", "[a\\]:joy:](https://ex.com)"],
      ["[a](u(v)(w):joy:) :joy:", `[a](u(v)(w):joy:) ${JOY}`],
      ["[a :joy:]( https://ex.com ) :joy:", `[a :joy:]( https://ex.com ) ${JOY}`],
      ["[a :joy:](x) [b :joy:](y)", "[a :joy:](x) [b :joy:](y)"],
      ["[a :joy:](x) :joy: [b :joy:](y)", `[a :joy:](x) ${JOY} [b :joy:](y)`],
    ]);
  });

  it("swaps inside brackets that do not make a masked link", () => {
    swapped([
      ["[a :joy:]()", `[a ${JOY}]()`],
      ["[a :joy:]( )", `[a ${JOY}]( )`],
      ["[a :joy:] (x)", `[a ${JOY}] (x)`],
      ["[a :joy:](", `[a ${JOY}](`],
      ["[a :joy:](x", `[a ${JOY}](x`],
      ["[a\n:joy:](x)", `[a\n${JOY}](x)`],
      ["[a](x\n:joy:)", `[a](x\n${JOY})`],
      ["[a :joy:](x y)", `[a ${JOY}](x y)`],
      ["[a :joy:", `[a ${JOY}`],
      ["(a) [b :joy:", `(a) [b ${JOY}`],
      ["(a) :joy:](x)", `(a) ${JOY}](x)`],
    ]);
  });
});

describe("skin tone and custom emoji", () => {
  it.each([1, 2, 3, 4, 5])("applies skin tone %i to every swapped shortcode", (tone) => {
    setSkinTone(tone);
    const toned = `${WAVE}${SKIN_TONES[tone]}`;
    expect(replaceEmojiShortcodes(":wave: `c` :wave:")).toBe(`${toned} \`c\` ${toned}`);
  });

  it("leaves an emoji with no skin variants and the default tone plain", () => {
    setSkinTone(3);
    expect(replaceEmojiShortcodes(":joy:")).toBe(JOY);
    setSkinTone(0);
    expect(replaceEmojiShortcodes(":wave:")).toBe(WAVE);
  });

  it("keeps only the server's own names as typed", () => {
    setCustomEmoji([{ id: 1, shortcode: "wave", url: "/api/v1/emoji/1/image" }]);
    emojiStore.flush();
    expect(replaceEmojiShortcodes(":wave: :joy: :wave::joy:")).toBe(`:wave: ${JOY} :wave:${JOY}`);
  });

  it("sends text as typed before the emoji catalog has loaded", () => {
    catalogState.hidden = true;
    expect(replaceEmojiShortcodes(":joy: and :wave:")).toBe(":joy: and :wave:");
  });
});
