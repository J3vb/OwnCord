/**
 * Boundary behaviour of the inline tokenizer, block splitter, fence splitter
 * and plain-text flattener: exact node shapes at the edges of each rule, so a
 * shifted comparison, a dropped guard or a swapped branch changes the result.
 */

import { describe, it, expect } from "vitest";
import {
  type InlineNode,
  markdownToPlainText,
  parseBlocks,
  parseInline,
  splitCodeFences,
} from "../../src/lib/text/markdown";

const t = (value: string) => ({ type: "text", value });

describe("parseInline escapes", () => {
  it.each([
    ["\\*", "*"],
    ["\\\\", "\\"],
    ["\\`", "`"],
    ["\\#", "#"],
    ["\\-", "-"],
    ["\\+", "+"],
    ["\\.", "."],
    ["\\!", "!"],
    ["\\(", "("],
    ["\\>", ">"],
    ["\\|", "|"],
  ])("a backslash before %j yields the bare character", (src, out) => {
    expect(parseInline(src)).toEqual([t(out)]);
  });

  it.each([["\\a"], ["\\ "], ["a\\"]])("keeps the backslash in %j", (src) => {
    expect(parseInline(src)).toEqual([t(src)]);
  });

  it("an escaped opener never opens a style", () => {
    expect(parseInline("\\*a*")).toEqual([t("*a*")]);
  });
});

describe("parseInline code spans", () => {
  it.each([
    ["`a`", "a"],
    ["``a`b``", "a`b"],
    ["```a```", "`a"],
    ["` a `", " a "],
  ])("%j is a code span with value %j", (src, value) => {
    const nodes = parseInline(src);
    expect(nodes[0]).toEqual({ type: "code", value });
  });

  it("an unclosed backtick stays text", () => {
    expect(parseInline("`a")).toEqual([t("`a")]);
  });

  it("markdown inside a code span is dead", () => {
    expect(parseInline("`**a**`")).toEqual([{ type: "code", value: "**a**" }]);
  });
});

describe("parseInline angle tokens", () => {
  it.each([
    ["<t:0>", 0, "f"],
    ["<t:1700000000:R>", 1700000000, "R"],
    ["<t:-5:t>", -5, "t"],
    ["<t:8640000000000>", 8.64e12, "f"],
    ["<t:-8640000000000:D>", -8.64e12, "D"],
    ["<t:1:T>", 1, "T"],
    ["<t:1:d>", 1, "d"],
    ["<t:1:F>", 1, "F"],
  ])("%s is a timestamp", (src, unix, style) => {
    expect(parseInline(src)).toEqual([{ type: "timestamp", unix, style }]);
  });

  it.each([["<t:8640000000001>"], ["<t:-8640000000001>"], ["<t:1:x>"], ["<t:>"], ["<t:1"]])(
    "%s stays text",
    (src) => {
      expect(parseInline(src).every((n) => n.type !== "timestamp")).toBe(true);
    },
  );

  it("a timestamp only matches at the angle bracket", () => {
    expect(parseInline("a<t:1>b")).toEqual([
      t("a"),
      { type: "timestamp", unix: 1, style: "f" },
      t("b"),
    ]);
  });

  it.each([
    ["<https://a.io/x>", "https://a.io/x"],
    ["<HTTP://A.io>", "HTTP://A.io"],
  ])("%s is a url node", (src, url) => {
    expect(parseInline(src)).toEqual([{ type: "url", url, raw: src }]);
  });

  it.each([["<ftp://a.io>"], ["<https://a b>"], ["<https://>"]])("%s is not a url node", (src) => {
    expect(parseInline(src).some((n) => n.type === "url")).toBe(false);
  });
});

describe("parseInline bare URLs and styles", () => {
  it("keeps underscores inside a bare URL literal", () => {
    expect(parseInline("https://a.io/a_b_c")).toEqual([t("https://a.io/a_b_c")]);
  });

  it("gives a trailing closer back to the style around a URL", () => {
    expect(parseInline("**https://a.io/x**")).toEqual([
      { type: "strong", children: [t("https://a.io/x")] },
    ]);
  });

  it.each([
    ["**a**", ["strong"]],
    ["__a__", ["underline"]],
    ["~~a~~", ["strike"]],
    ["||a||", ["spoiler"]],
    ["*a*", ["em"]],
    ["_a_", ["em"]],
    ["***a***", ["strong", "em"]],
    ["___a___", ["underline", "em"]],
  ])("%s nests styles %j outermost first", (src, styles) => {
    let node: unknown = t("a");
    for (const type of styles.toReversed()) node = { type, children: [node] };
    expect(parseInline(src)).toEqual([node]);
  });

  it.each([["snake_case_name"], ["a_b"], ["**a"], ["* a"], ["**"], ["~~"], ["a**"]])(
    "%j has no style node",
    (src) => {
      expect(parseInline(src).every((n) => n.type === "text")).toBe(true);
    },
  );

  it("an underscore opens emphasis after a non-word character", () => {
    expect(parseInline("(_a_)")).toEqual([t("("), { type: "em", children: [t("a")] }, t(")")]);
  });

  it("an underscore closer followed by a word character does not close", () => {
    expect(parseInline("_a_b")).toEqual([t("_a_b")]);
  });

  it("a longer run than the marker does not close a double marker", () => {
    expect(parseInline("**a***")).toEqual([{ type: "strong", children: [t("a")] }, t("*")]);
  });

  it("a closer hidden in a code span, escape or angle url is skipped", () => {
    expect(parseInline("*a`*`b*")[0]).toEqual({
      type: "em",
      children: [t("a"), { type: "code", value: "*" }, t("b")],
    });
    expect(parseInline("*a\\*b*")[0]).toEqual({ type: "em", children: [t("a*b")] });
    expect(parseInline("*a<https://x.io/*>b*")[0]).toMatchObject({ type: "em" });
  });

  it("emits text before and after a style as separate nodes", () => {
    expect(parseInline("x*a*y")).toEqual([t("x"), { type: "em", children: [t("a")] }, t("y")]);
  });

  it("nests six style levels and leaves the seventh construct as text", () => {
    const nodes = parseInline("||a ~~b __c **d *e _f [g](u) f_ e* d** c__ b~~ a||");
    const types: string[] = [];
    let level: readonly InlineNode[] = nodes;
    for (;;) {
      const next = level.find((n) => n.type !== "text" && "children" in n);
      if (next === undefined || !("children" in next)) break;
      types.push(next.type);
      level = next.children;
    }
    expect(types).toEqual(["spoiler", "strike", "underline", "strong", "em", "em"]);
    expect(level).toEqual([t("f [g](u) f")]);
  });
});

describe("parseInline links", () => {
  it("builds a link with parsed children and its raw source", () => {
    expect(parseInline("[**a**](https://x.io)")).toEqual([
      {
        type: "link",
        url: "https://x.io",
        raw: "[**a**](https://x.io)",
        children: [{ type: "strong", children: [t("a")] }],
      },
    ]);
  });

  it("trims whitespace around the url", () => {
    expect(parseInline("[a]( u )")[0]).toMatchObject({ url: "u", raw: "[a]( u )" });
  });

  it.each([
    ["[a]()"],
    ["[a]( )"],
    ["[]()"],
    ["[](u)"],
    ["[a](b c)"],
    ["[a] (u)"],
    ["[a](u"],
    ["[a"],
  ])("%j is not a link", (src) => {
    expect(parseInline(src).some((n) => n.type === "link")).toBe(false);
  });

  it("a link keeps surrounding text and consumes exactly its source", () => {
    expect(parseInline("x[a](u)y")).toEqual([
      t("x"),
      { type: "link", url: "u", raw: "[a](u)", children: [t("a")] },
      t("y"),
    ]);
  });

  it("balances nested brackets and parentheses", () => {
    expect(parseInline("[a[b]](u(v))")[0]).toMatchObject({ url: "u(v)", raw: "[a[b]](u(v))" });
  });

  it("a newline strands an open bracket", () => {
    expect(parseInline("[a\n](u)").some((n) => n.type === "link")).toBe(false);
  });

  it("an escaped bracket does not open or close a link", () => {
    expect(parseInline("\\[a](u)").some((n) => n.type === "link")).toBe(false);
    expect(parseInline("[a\\](u)").some((n) => n.type === "link")).toBe(false);
  });

  it("links do not nest past the depth cap", () => {
    let src = "x";
    for (let k = 0; k < 8; k++) src = `[${src}](u)`;
    let nodes: readonly InlineNode[] = parseInline(src);
    let links = 0;
    while (nodes[0]?.type === "link") {
      links++;
      nodes = nodes[0].children;
    }
    expect(links).toBe(6);
  });
});

describe("splitCodeFences", () => {
  it.each([
    ["", []],
    ["plain", [{ kind: "prose", text: "plain", lang: null }]],
    ["```a", [{ kind: "prose", text: "```a", lang: null }]],
    ["``` ```", [{ kind: "code", text: "", lang: null }]],
    ["```\nx\n```", [{ kind: "code", text: "x", lang: null }]],
    ["```ts\nx  \n\n```", [{ kind: "code", text: "x", lang: "ts" }]],
    ["```c++\nx```", [{ kind: "code", text: "x", lang: "c++" }]],
    ["```c#\nx```", [{ kind: "code", text: "x", lang: "c#" }]],
    ["``` ts \nx```", [{ kind: "code", text: "x", lang: "ts" }]],
    ["```1a\nx```", [{ kind: "code", text: "1a\nx", lang: null }]],
    ["```a b\nx```", [{ kind: "code", text: "a b\nx", lang: null }]],
    ["```\n\nx```", [{ kind: "code", text: "x", lang: null }]],
    ["```x```", [{ kind: "code", text: "x", lang: null }]],
    [
      "a```b```c",
      [
        { kind: "prose", text: "a", lang: null },
        { kind: "code", text: "b", lang: null },
        { kind: "prose", text: "c", lang: null },
      ],
    ],
    [
      "```a``````b```",
      [
        { kind: "code", text: "a", lang: null },
        { kind: "code", text: "b", lang: null },
      ],
    ],
  ])("splits %j", (src, expected) => {
    expect(splitCodeFences(src)).toEqual(expected);
  });

  it("accepts a 20 character tag and rejects a 21 character one", () => {
    const ok = "a" + "b".repeat(19);
    expect(splitCodeFences(`\`\`\`${ok}\nx\`\`\``)[0]!.lang).toBe(ok);
    expect(splitCodeFences(`\`\`\`${ok}b\nx\`\`\``)[0]!.lang).toBeNull();
  });

  it("allows word characters, plus and hash after the first letter", () => {
    expect(splitCodeFences("```a_1+#-\nx```")[0]!.lang).toBe("a_1+#-");
  });
});

describe("parseBlocks", () => {
  it.each([
    ["", [{ type: "paragraph", text: "" }]],
    ["a\nb", [{ type: "paragraph", text: "a\nb" }]],
    ["# a", [{ type: "heading", level: 1, text: "a" }]],
    ["## a", [{ type: "heading", level: 2, text: "a" }]],
    ["### a", [{ type: "heading", level: 3, text: "a" }]],
    ["#### a", [{ type: "paragraph", text: "#### a" }]],
    ["#a", [{ type: "paragraph", text: "#a" }]],
    [" # a", [{ type: "paragraph", text: " # a" }]],
    ["#   a b", [{ type: "heading", level: 1, text: "a b" }]],
    [
      "a\n# b\nc",
      [
        { type: "paragraph", text: "a" },
        { type: "heading", level: 1, text: "b" },
        { type: "paragraph", text: "c" },
      ],
    ],
    ["-# a", [{ type: "subtext", text: "a" }]],
    ["-#a", [{ type: "paragraph", text: "-#a" }]],
    ["-#   a", [{ type: "subtext", text: "a" }]],
    [
      "a\n-# s",
      [
        { type: "paragraph", text: "a" },
        { type: "subtext", text: "s" },
      ],
    ],
    ["x>>> a", [{ type: "paragraph", text: "x>>> a" }]],
    ["x -# a", [{ type: "paragraph", text: "x -# a" }]],
    ["> a", [{ type: "quote", text: "a" }]],
    [">a", [{ type: "quote", text: "a" }]],
    [
      "> a\n> b\nc",
      [
        { type: "quote", text: "a\nb" },
        { type: "paragraph", text: "c" },
      ],
    ],
    ["x> a", [{ type: "paragraph", text: "x> a" }]],
    [
      "a\n> b",
      [
        { type: "paragraph", text: "a" },
        { type: "quote", text: "b" },
      ],
    ],
    [">>> a\nb\n> c", [{ type: "quote", text: "a\nb\n> c" }]],
    [
      "a\n>>> b\nc",
      [
        { type: "paragraph", text: "a" },
        { type: "quote", text: "b\nc" },
      ],
    ],
    [">>>a", [{ type: "quote", text: "a" }]],
  ])("splits %j", (src, expected) => {
    expect(parseBlocks(src)).toEqual(expected);
  });

  it.each([
    ["- a", false, 1, [["a", 0, false]]],
    ["* a", false, 1, [["a", 0, false]]],
    ["-a", null, 0, []],
    ["-   a", false, 1, [["a", 0, false]]],
    ["1.   a", true, 1, [["a", 0, true]]],
    [
      "* a\n*   b",
      false,
      1,
      [
        ["a", 0, false],
        ["b", 0, false],
      ],
    ],
    ["  - a", false, 1, [["a", 1, false]]],
    [" - a", false, 1, [["a", 0, false]]],
    ["1. a", true, 1, [["a", 0, true]]],
    ["7) a", true, 7, [["a", 0, true]]],
    ["  3. a", true, 3, [["a", 1, true]]],
    ["1.a", null, 0, []],
    ["1234567890. a", null, 0, []],
    ["123456789. a", true, 123456789, [["a", 0, true]]],
    [
      "- a\n- b\n  - c",
      false,
      1,
      [
        ["a", 0, false],
        ["b", 0, false],
        ["c", 1, false],
      ],
    ],
    [
      "2. a\n  - b\n3. c",
      true,
      2,
      [
        ["a", 0, true],
        ["b", 1, false],
        ["c", 0, true],
      ],
    ],
  ])("reads list %j", (src, ordered, start, items) => {
    const blocks = parseBlocks(src);
    if (ordered === null) {
      expect(blocks.every((b) => b.type !== "list")).toBe(true);
      return;
    }
    expect(blocks).toEqual([
      {
        type: "list",
        ordered,
        start,
        items: items.map(([text, level, o]) => ({ text, level, ordered: o })),
      },
    ]);
  });

  it("ends a list when the top-level marker style changes", () => {
    expect(parseBlocks("- a\n1. b")).toEqual([
      { type: "list", ordered: false, start: 1, items: [{ text: "a", level: 0, ordered: false }] },
      { type: "list", ordered: true, start: 1, items: [{ text: "b", level: 0, ordered: true }] },
    ]);
    expect(parseBlocks("1. a\n- b")).toHaveLength(2);
  });

  it("a paragraph before a list is flushed first", () => {
    expect(parseBlocks("a\n- b")).toEqual([
      { type: "paragraph", text: "a" },
      { type: "list", ordered: false, start: 1, items: [{ text: "b", level: 0, ordered: false }] },
    ]);
  });

  it("a plain line ends a list and starts a paragraph", () => {
    expect(parseBlocks("- a\nb")).toEqual([
      { type: "list", ordered: false, start: 1, items: [{ text: "a", level: 0, ordered: false }] },
      { type: "paragraph", text: "b" },
    ]);
  });
});

describe("markdownToPlainText", () => {
  const S = "[spoiler]";
  it.each([
    ["", ""],
    ["**a** *b* __c__ ~~d~~", "a b c d"],
    ["||secret|| x", `${S} x`],
    ["**||secret||**", S],
    ["# h\n## i\n-# s", "h i s"],
    ["> q\n> r", "q r"],
    ["> **a**\n>>> ||b||", `a ${S}`],
    ["- a\n- b\n1. c", "a b c"],
    ["[**a**](https://x.io)", "a"],
    ["<https://x.io/p>", "https://x.io/p"],
    ["`code`", "code"],
    ["a\n\n  b", "a b"],
    ["x\n```ts\nsecret code\n```\ny", "x secret code y"],
    ["  padded  ", "padded"],
    ["```\n**raw** ||x||\n```", "**raw** ||x||"],
  ])("flattens %j to %j", (src, out) => {
    expect(markdownToPlainText(src, S)).toBe(out);
  });

  it("renders a timestamp with the formatted text", () => {
    const out = markdownToPlainText("at <t:1700000000:t>", S);
    expect(out.startsWith("at ")).toBe(true);
    expect(out).not.toContain("<t:");
  });

  it("cuts oversize input before parsing", () => {
    const out = markdownToPlainText("a".repeat(40_000), S);
    expect(out.length).toBe(32_001);
    expect(out.endsWith("…")).toBe(true);
  });
});
