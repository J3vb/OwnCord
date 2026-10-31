/**
 * Discord-flavoured markdown rendering: the tokenizer's grammar, the DOM the
 * renderer builds from it, and the safety rules that must survive both
 * (no innerHTML, no javascript: hrefs, no markdown inside code).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as voiceSession from "../helpers/voiceSessionMock";

vi.mock("@lib/voice/livekitSession", () => voiceSession.defaults());

import {
  renderInlineContent,
  renderMessageContent,
} from "../../src/components/message-list/contentParser";
import { parseInline, parseBlocks, splitCodeFences } from "../../src/lib/text/markdown";
import { highlightCode, resolveLanguage } from "../../src/components/message-list/syntaxHighlight";
import { extractUrls } from "../../src/components/message-list/media";
import { membersStore } from "../../src/stores/members.store";
import { setChannels } from "../../src/stores/channels.store";
import type { ReadyChannel } from "../../src/lib/types";
import { signInAs, resetChannelsState } from "../helpers/storeSeeds";

const CHANNELS: ReadyChannel[] = [
  { id: 1, name: "general", type: "text", category: null, position: 0 },
];

function seedStores(): void {
  membersStore.setState(() => ({
    members: new Map([
      [10, { id: 10, username: "alice", avatar: null, role: "member", status: "online" as const }],
    ]),
    typingUsers: new Map(),
  }));
  signInAs(
    { id: 12, username: "me", avatar: null, role: "member" },
    { token: "t", serverName: null },
  );
  resetChannelsState();
  setChannels(CHANNELS);
}

let container: HTMLDivElement;

beforeEach(() => {
  seedStores();
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  container.remove();
});

/** Render inline markdown into the shared container. */
function inline(text: string): HTMLDivElement {
  container.appendChild(renderInlineContent(text));
  return container;
}

/** Render a whole message into the shared container. */
function message(text: string): HTMLDivElement {
  container.appendChild(renderMessageContent(text));
  return container;
}

// ---------------------------------------------------------------------------
// Inline styles
// ---------------------------------------------------------------------------

describe("inline styles", () => {
  it("renders **bold**", () => {
    const el = inline("say **hello** now");
    expect(el.querySelector("strong")?.textContent).toBe("hello");
    expect(el.textContent).toBe("say hello now");
  });

  it("renders *italic* and _italic_", () => {
    expect(inline("*one*").querySelector("em")?.textContent).toBe("one");
    container.replaceChildren();
    expect(inline("_two_").querySelector("em")?.textContent).toBe("two");
  });

  it("renders __underline__ as a <u>, not italics", () => {
    const el = inline("__under__");
    expect(el.querySelector("u")?.textContent).toBe("under");
    expect(el.querySelector("em")).toBeNull();
  });

  it("renders ~~strikethrough~~", () => {
    expect(inline("~~gone~~").querySelector("s")?.textContent).toBe("gone");
  });

  it("leaves snake_case_words alone", () => {
    const el = inline("call some_long_name here");
    expect(el.querySelector("em")).toBeNull();
    expect(el.textContent).toBe("call some_long_name here");
  });

  it("leaves an unclosed delimiter as literal text", () => {
    const el = inline("2 ** 3 is not bold");
    expect(el.querySelector("strong")).toBeNull();
    expect(el.textContent).toBe("2 ** 3 is not bold");
  });

  it("leaves an empty delimiter pair as literal text", () => {
    const el = inline("**** nothing");
    expect(el.querySelector("strong")).toBeNull();
  });
});

describe("nesting", () => {
  it("nests italic inside bold", () => {
    const el = inline("**bold *and italic* end**");
    const strong = el.querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong!.querySelector("em")?.textContent).toBe("and italic");
    expect(el.textContent).toBe("bold and italic end");
  });

  it("treats ***text*** as bold + italic", () => {
    const el = inline("***both***");
    const strong = el.querySelector("strong");
    expect(strong!.querySelector("em")?.textContent).toBe("both");
  });

  it("nests bold inside strikethrough", () => {
    const el = inline("~~a **b** c~~");
    expect(el.querySelector("s > strong")?.textContent).toBe("b");
  });

  it("does not let a nested single delimiter close its outer pair", () => {
    const el = inline("*a **b** c*");
    const em = el.querySelector("em");
    expect(em?.textContent).toBe("a b c");
    expect(em!.querySelector("strong")?.textContent).toBe("b");
  });

  it("keeps code spans opaque to delimiter matching", () => {
    const el = inline("**bold `**` still bold**");
    expect(el.querySelector("strong")?.textContent).toBe("bold ** still bold");
  });
});

describe("escaping", () => {
  it("renders \\*literal\\* as plain asterisks", () => {
    const el = inline("\\*literal\\*");
    expect(el.querySelector("em")).toBeNull();
    expect(el.textContent).toBe("*literal*");
  });

  it("escapes a backslash itself", () => {
    expect(inline("a \\\\ b").textContent).toBe("a \\ b");
  });

  it("keeps a backslash before a non-markdown character", () => {
    expect(inline("C:\\path").textContent).toBe("C:\\path");
  });

  it("does not process escapes inside code spans", () => {
    expect(inline("`\\*x\\*`").querySelector("code")?.textContent).toBe("\\*x\\*");
  });
});

// ---------------------------------------------------------------------------
// Spoilers
// ---------------------------------------------------------------------------

describe("spoilers", () => {
  it("renders ||text|| obscured with aria-pressed=false", () => {
    const el = inline("the answer is ||42||");
    const spoiler = el.querySelector(".msg-spoiler");
    expect(spoiler).not.toBeNull();
    expect(spoiler!.textContent).toBe("42");
    expect(spoiler!.getAttribute("aria-pressed")).toBe("false");
    expect(spoiler!.getAttribute("role")).toBe("button");
    expect(spoiler!.getAttribute("tabindex")).toBe("0");
  });

  it("reveals on click and flips aria-pressed", () => {
    const el = inline("||boo||");
    const spoiler = el.querySelector(".msg-spoiler") as HTMLElement;
    expect(spoiler.classList.contains("revealed")).toBe(false);
    spoiler.click();
    expect(spoiler.classList.contains("revealed")).toBe(true);
    expect(spoiler.getAttribute("aria-pressed")).toBe("true");
  });

  it("reveals on Enter", () => {
    const el = inline("||boo||");
    const spoiler = el.querySelector(".msg-spoiler") as HTMLElement;
    spoiler.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(spoiler.getAttribute("aria-pressed")).toBe("true");
  });

  it("reveals each spoiler independently", () => {
    const el = inline("||one|| and ||two||");
    const spoilers = el.querySelectorAll<HTMLElement>(".msg-spoiler");
    expect(spoilers.length).toBe(2);
    spoilers[0]!.click();
    expect(spoilers[0]!.classList.contains("revealed")).toBe(true);
    expect(spoilers[1]!.classList.contains("revealed")).toBe(false);
  });

  it("swallows the click that reveals so a hidden link cannot open", () => {
    const el = inline("||[go](https://example.com)||");
    const spoiler = el.querySelector(".msg-spoiler") as HTMLElement;
    const link = spoiler.querySelector("a") as HTMLAnchorElement;
    const onClick = vi.fn();
    link.addEventListener("click", onClick);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(spoiler.classList.contains("revealed")).toBe(true);
  });

  it("keeps markdown working inside a spoiler", () => {
    const el = inline("||**secret**||");
    expect(el.querySelector(".msg-spoiler strong")?.textContent).toBe("secret");
  });
});

// ---------------------------------------------------------------------------
// Block constructs
// ---------------------------------------------------------------------------

describe("block quotes", () => {
  it("merges contiguous > lines into one quote", () => {
    const el = message("> first\n> second\nafter");
    const quotes = el.querySelectorAll("blockquote.md-quote");
    expect(quotes.length).toBe(1);
    expect(quotes[0]!.textContent).toBe("first\nsecond");
    expect(el.textContent).toContain("after");
  });

  it("does not quote a > that is not at line start", () => {
    const el = message("a > b");
    expect(el.querySelector("blockquote")).toBeNull();
  });

  it(">>> quotes the rest of the message", () => {
    const el = message(">>> everything\nfrom here\non");
    const quote = el.querySelector("blockquote.md-quote");
    expect(quote!.textContent).toBe("everything\nfrom here\non");
  });

  it("renders markdown blocks inside a quote", () => {
    const el = message("> # Title\n> - item");
    expect(el.querySelector("blockquote h1")?.textContent).toBe("Title");
    expect(el.querySelector("blockquote ul.md-list li")?.textContent).toBe("item");
  });

  it("stops nesting quotes past the depth limit", () => {
    const el = message("> > > deep");
    expect(el.querySelectorAll("blockquote").length).toBeLessThanOrEqual(2);
    expect(el.textContent).toContain("deep");
  });
});

describe("headings", () => {
  it("renders # / ## / ### as h1-h3", () => {
    const el = message("# one\n## two\n### three");
    expect(el.querySelector("h1.md-h1")?.textContent).toBe("one");
    expect(el.querySelector("h2.md-h2")?.textContent).toBe("two");
    expect(el.querySelector("h3.md-h3")?.textContent).toBe("three");
  });

  it("requires a space after the hashes", () => {
    const el = message("#nospace");
    expect(el.querySelector("h1")).toBeNull();
    expect(el.textContent).toBe("#nospace");
  });

  it("does not treat #### as a heading", () => {
    const el = message("#### four");
    expect(el.querySelector("h1, h2, h3")).toBeNull();
  });

  it("only matches at line start", () => {
    const el = message("see # this");
    expect(el.querySelector("h1")).toBeNull();
  });

  it("renders inline markdown inside a heading", () => {
    const el = message("## a **b**");
    expect(el.querySelector("h2 strong")?.textContent).toBe("b");
  });
});

describe("lists", () => {
  it("renders - and * bullets as one ul", () => {
    const el = message("- one\n* two");
    const lists = el.querySelectorAll("ul.md-list");
    expect(lists.length).toBe(1);
    expect(Array.from(lists[0]!.children).map((li) => li.textContent)).toEqual(["one", "two"]);
  });

  it("renders 1. items as an ol", () => {
    const el = message("1. one\n2. two");
    const ol = el.querySelector("ol.md-list");
    expect(ol).not.toBeNull();
    expect(ol!.querySelectorAll("li").length).toBe(2);
  });

  it("keeps the starting number of an ordered list", () => {
    const el = message("3. three\n4. four");
    expect(el.querySelector("ol.md-list")?.getAttribute("start")).toBe("3");
  });

  it("nests an indented item one level deep", () => {
    const el = message("- top\n  - nested");
    const root = el.querySelector("ul.md-list") as HTMLElement;
    expect(root.children.length).toBe(1);
    const nested = root.querySelector("ul.md-list-nested");
    expect(nested).not.toBeNull();
    expect(nested!.querySelector("li")?.textContent).toBe("nested");
  });

  it("starts a new list when the marker style changes", () => {
    const el = message("- bullet\n1. number");
    expect(el.querySelector("ul.md-list")).not.toBeNull();
    expect(el.querySelector("ol.md-list")).not.toBeNull();
  });

  it("requires a space after the marker", () => {
    const el = message("-nope");
    expect(el.querySelector("ul")).toBeNull();
  });

  it("renders inline markdown inside items", () => {
    const el = message("- **bold** item");
    expect(el.querySelector("li strong")?.textContent).toBe("bold");
  });
});

describe("paragraphs", () => {
  it("keeps line breaks inside a paragraph run", () => {
    const el = message("one\ntwo");
    const paras = el.querySelectorAll(".md-p");
    expect(paras.length).toBe(1);
    expect(paras[0]!.textContent).toBe("one\ntwo");
  });

  it("lets inline styles span a line break", () => {
    const el = message("**one\ntwo**");
    expect(el.querySelector("strong")?.textContent).toBe("one\ntwo");
  });
});

// ---------------------------------------------------------------------------
// Masked links
// ---------------------------------------------------------------------------

describe("masked links", () => {
  it("renders [text](url) as an anchor titled with the URL", () => {
    const el = inline("see [the docs](https://example.com/docs)");
    const link = el.querySelector("a.msg-link") as HTMLAnchorElement;
    expect(link.textContent).toBe("the docs");
    expect(link.getAttribute("href")).toBe("https://example.com/docs");
    expect(link.getAttribute("title")).toBe("https://example.com/docs");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("rejects javascript: URLs and keeps the source as text", () => {
    const el = inline("[click](javascript:alert(1))");
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toBe("[click](javascript:alert(1))");
  });

  it("rejects data: URLs", () => {
    const el = inline("[x](data:text/html,<script>alert(1)</script>)");
    expect(el.querySelector("a")).toBeNull();
    expect(el.querySelector("script")).toBeNull();
  });

  it("rejects relative URLs even though they resolve to http", () => {
    const el = inline("[x](/settings)");
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toBe("[x](/settings)");
  });

  it("renders markdown inside the link text", () => {
    const el = inline("[**bold** link](https://example.com)");
    expect(el.querySelector("a strong")?.textContent).toBe("bold");
  });

  it("balances parentheses inside the URL", () => {
    const el = inline("[wiki](https://en.example.org/wiki/Foo_(bar))");
    expect(el.querySelector("a")?.getAttribute("href")).toBe(
      "https://en.example.org/wiki/Foo_(bar)",
    );
  });

  it("produces no embed for a masked link", () => {
    expect(extractUrls("[docs](https://example.com/a.png)")).toEqual([]);
    expect(extractUrls("plain https://example.com/a.png")).toEqual(["https://example.com/a.png"]);
  });
});

// ---------------------------------------------------------------------------
// Code
// ---------------------------------------------------------------------------

describe("code fences", () => {
  it("renders a language label and keeps the code intact", () => {
    const el = message("```ts\nconst x = 1; // hi\n```");
    expect(el.querySelector(".msg-codeblock-lang")?.textContent).toBe("ts");
    expect(el.querySelector(".msg-codeblock")?.textContent).toBe("const x = 1; // hi");
    expect(el.querySelector(".msg-codeblock")?.getAttribute("data-lang")).toBe("typescript");
  });

  it("highlights keywords, numbers, strings and comments", () => {
    const el = message('```js\nconst s = "hi"; // note\n```');
    const block = el.querySelector(".msg-codeblock")!;
    expect(block.querySelector(".tok-keyword")?.textContent).toBe("const");
    expect(block.querySelector(".tok-string")?.textContent).toBe('"hi"');
    expect(block.querySelector(".tok-comment")?.textContent).toBe("// note");
    expect(el.querySelector(".msg-codeblock")?.textContent).toBe('const s = "hi"; // note');
  });

  it("falls back to plain text for an unknown language, keeping the label", () => {
    const el = message("```brainfuck\n+++.\n```");
    expect(el.querySelector(".msg-codeblock-lang")?.textContent).toBe("brainfuck");
    expect(el.querySelector(".msg-codeblock .tok-keyword")).toBeNull();
    expect(el.querySelector(".msg-codeblock")?.textContent).toBe("+++.");
  });

  it("keeps the copy button and copies the raw code", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const el = message("```go\nfmt.Println(1)\n```");
    const btn = el.querySelector(".msg-codeblock-copy") as HTMLElement;
    btn.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("fmt.Println(1)"));
  });

  it("does not parse markdown inside a fence", () => {
    const el = message("```\n**not bold** and *not italic* and ||no spoiler||\n```");
    expect(el.querySelector("strong")).toBeNull();
    expect(el.querySelector("em")).toBeNull();
    expect(el.querySelector(".msg-spoiler")).toBeNull();
    expect(el.querySelector(".msg-codeblock")?.textContent).toBe(
      "**not bold** and *not italic* and ||no spoiler||",
    );
  });

  it("does not autolink URLs inside a fence", () => {
    const el = message("```\nhttps://example.com\n```");
    expect(el.querySelector("a")).toBeNull();
  });

  it("treats a fence with no newline as untagged code", () => {
    const el = message("```ts is nice```");
    expect(el.querySelector(".msg-codeblock-lang")).toBeNull();
    expect(el.querySelector(".msg-codeblock")?.textContent).toBe("ts is nice");
  });

  it("leaves an unterminated fence as prose", () => {
    const el = message("```oops");
    expect(el.querySelector(".msg-codeblock")).toBeNull();
    expect(el.textContent).toBe("```oops");
  });
});

describe("inline code", () => {
  it("does not parse markdown inside a code span", () => {
    const el = inline("`**x**`");
    expect(el.querySelector("strong")).toBeNull();
    expect(el.querySelector("code")?.textContent).toBe("**x**");
  });

  it("does not autolink a URL inside a code span", () => {
    const el = inline("`https://example.com`");
    expect(el.querySelector("a")).toBeNull();
    expect(el.querySelector("code")?.textContent).toBe("https://example.com");
  });

  it("supports double-backtick spans containing a backtick", () => {
    const el = inline("``a ` b``");
    expect(el.querySelector("code")?.textContent).toBe("a ` b");
  });
});

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

describe("XSS safety", () => {
  it("never builds elements from HTML in the message", () => {
    const el = message("<script>alert(1)</script><img src=x onerror=alert(1)>");
    expect(el.querySelector("script")).toBeNull();
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("<script>alert(1)</script>");
  });

  it("keeps HTML inert inside styled spans", () => {
    const el = message("**<img src=x onerror=alert(1)>**");
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("strong")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("keeps HTML inert inside code fences", () => {
    const el = message("```html\n<script>alert(1)</script>\n```");
    expect(el.querySelector("script")).toBeNull();
    expect(el.querySelector(".msg-codeblock")?.textContent).toBe("<script>alert(1)</script>");
  });

  it("does not autolink a javascript: pseudo-URL", () => {
    const el = message("javascript:alert(1)");
    expect(el.querySelector("a")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Markdown + mentions
// ---------------------------------------------------------------------------

describe("markdown with mentions", () => {
  it("renders a mention chip inside bold", () => {
    const el = message("**hi @alice**");
    const mention = el.querySelector("strong .mention");
    expect(mention?.textContent).toBe("@alice");
  });

  it("renders a channel chip inside a spoiler", () => {
    const el = message("||go to #general||");
    expect(el.querySelector(".msg-spoiler .channel-mention")?.textContent).toBe("#general");
  });

  it("autolinks a bare URL inside a quote", () => {
    const el = message("> see https://example.com");
    expect(el.querySelector("blockquote a.msg-link")?.getAttribute("href")).toBe(
      "https://example.com",
    );
  });

  it("does not italicise underscores inside a bare URL", () => {
    const el = message("https://example.com/a_b_c");
    expect(el.querySelector("em")).toBeNull();
    expect(el.querySelector("a.msg-link")?.getAttribute("href")).toBe("https://example.com/a_b_c");
  });

  it("still bolds around a URL", () => {
    const el = message("**https://example.com/a_b**");
    const strong = el.querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong!.querySelector("a")?.getAttribute("href")).toBe("https://example.com/a_b");
  });

  it("still italicises around a URL with single underscore delimiters", () => {
    const el = message("_https://example.com/a_");
    const em = el.querySelector("em");
    expect(em).not.toBeNull();
    expect(em!.querySelector("a.msg-link")?.getAttribute("href")).toBe("https://example.com/a");
  });

  it("combines a heading, a list, a quote and a fence in one message", () => {
    const el = message("# Title\n- a\n- b\n> note\n```js\nlet x = 1\n```");
    expect(el.querySelector("h1")).not.toBeNull();
    expect(el.querySelectorAll("ul.md-list li").length).toBe(2);
    expect(el.querySelector("blockquote")).not.toBeNull();
    expect(el.querySelector(".msg-codeblock .tok-keyword")?.textContent).toBe("let");
  });
});

// ---------------------------------------------------------------------------
// Tokenizer units
// ---------------------------------------------------------------------------

describe("parseInline", () => {
  it("returns a single text node for plain prose", () => {
    expect(parseInline("just words")).toEqual([{ type: "text", value: "just words" }]);
  });

  it("keeps the raw source on a link node for the reject path", () => {
    const nodes = parseInline("[a](javascript:x)");
    expect(nodes[0]).toMatchObject({ type: "link", url: "javascript:x", raw: "[a](javascript:x)" });
  });

  it("stops nesting at the depth limit instead of recursing forever", () => {
    const deep = "*".repeat(20) + "x" + "*".repeat(20);
    expect(() => parseInline(deep)).not.toThrow();
  });

  it("parses a long run of unmatched brackets to literal text quickly", () => {
    // Pathological input for a naive per-opener rescan: every "[" would
    // otherwise trigger its own O(n) scan of the remaining string, making
    // this O(n^2). At the 4000-rune server cap that is ~16M ops; budget the
    // test generously so it still fails loudly on a real regression.
    const src = "[".repeat(4000);
    const start = performance.now();
    const nodes = parseInline(src);
    const elapsed = performance.now() - start;
    expect(nodes).toEqual([{ type: "text", value: src }]);
    expect(elapsed).toBeLessThan(500);
  });

  it("still renders a valid link after a long run of unmatched brackets", () => {
    const src = "[".repeat(2000) + "[real](https://example.com)";
    const nodes = parseInline(src);
    const last = nodes[nodes.length - 1];
    expect(last).toMatchObject({ type: "link", url: "https://example.com" });
  });
});

describe("parseBlocks", () => {
  it("splits blocks and keeps paragraph runs together", () => {
    expect(parseBlocks("a\nb\n# h\nc")).toEqual([
      { type: "paragraph", text: "a\nb" },
      { type: "heading", level: 1, text: "h" },
      { type: "paragraph", text: "c" },
    ]);
  });

  it("marks indented list items as level 1", () => {
    const blocks = parseBlocks("- a\n  - b");
    expect(blocks[0]).toMatchObject({
      type: "list",
      ordered: false,
      items: [
        { text: "a", level: 0 },
        { text: "b", level: 1 },
      ],
    });
  });
});

describe("splitCodeFences", () => {
  it("separates prose from fenced code", () => {
    expect(splitCodeFences("a```x```b")).toEqual([
      { kind: "prose", text: "a", lang: null },
      { kind: "code", text: "x", lang: null },
      { kind: "prose", text: "b", lang: null },
    ]);
  });

  it("extracts the language tag", () => {
    expect(splitCodeFences("```py\nprint(1)\n```")).toEqual([
      { kind: "code", text: "print(1)", lang: "py" },
    ]);
  });
});

describe("syntax highlighting", () => {
  it("resolves language aliases and rejects unknown tags", () => {
    expect(resolveLanguage("ts")).toBe("typescript");
    expect(resolveLanguage("golang")).toBe("go");
    expect(resolveLanguage("zsh")).toBe("bash");
    expect(resolveLanguage("nope")).toBeNull();
    expect(resolveLanguage(null)).toBeNull();
  });

  it("rejects Object.prototype property names as fence tags", () => {
    expect(resolveLanguage("constructor")).toBeNull();
    expect(resolveLanguage("toString")).toBeNull();
    expect(resolveLanguage("valueOf")).toBeNull();
    expect(resolveLanguage("hasOwnProperty")).toBeNull();
    expect(resolveLanguage("isPrototypeOf")).toBeNull();
    expect(resolveLanguage("propertyIsEnumerable")).toBeNull();
    expect(resolveLanguage("toLocaleString")).toBeNull();
    expect(resolveLanguage("__proto__")).toBeNull();
  });

  it("returns one plain token for an unknown language", () => {
    expect(highlightCode("anything", null)).toEqual([{ text: "anything", cls: null }]);
  });

  it("never drops or reorders characters", () => {
    const samples: [string, string][] = [
      ["typescript", "export const a: number = 0x1f; // c\n/* b */ `t${a}`"],
      ["go", 'package main\nfunc f() { s := "x" } // c'],
      ["python", "def f(x):\n  # c\n  return 'a' if x else None"],
      ["rust", 'fn main() { let v: Vec<u8> = vec![1]; println!("{}", 2); }'],
      ["json", '{"a": [1, true, null], "b": "c"}'],
      ["bash", 'if [ -n "$HOME" ]; then echo 1; fi # c'],
      ["css", ".a { color: #fff; margin: 4px; } /* c */"],
      ["html", '<!-- c --><a href="/x">y</a>'],
    ];
    for (const [lang, code] of samples) {
      expect(
        highlightCode(code, lang)
          .map((t) => t.text)
          .join(""),
      ).toBe(code);
    }
  });

  it("classifies python comments and strings", () => {
    const tokens = highlightCode("# note\nx = 'hi'", "python");
    expect(tokens.some((t) => t.cls === "comment" && t.text === "# note")).toBe(true);
    expect(tokens.some((t) => t.cls === "string" && t.text === "'hi'")).toBe(true);
  });

  it("classifies go keywords", () => {
    const tokens = highlightCode("func main() {}", "go");
    expect(tokens[0]).toEqual({ text: "func", cls: "keyword" });
  });

  it("highlights each added language's keyword, string and comment", () => {
    const cases: [string, string, string, string, string][] = [
      [
        "c",
        '#include <stdio.h>\nint main() { return 0; } // c\nchar *s = "x";',
        "int",
        '"x"',
        "// c",
      ],
      ["cpp", 'namespace a { auto s = "x"; } /* c */', "namespace", '"x"', "/* c */"],
      ["java", 'public class A { String s = "x"; } // c', "class", '"x"', "// c"],
      ["csharp", 'using System; var s = "x"; // c', "using", '"x"', "// c"],
      ["sql", "SELECT 'x' FROM t; -- c", "SELECT", "'x'", "-- c"],
      ["yaml", 'name: "x" # c\nok: true', "true", '"x"', "# c"],
    ];
    for (const [lang, code, keyword, str, comment] of cases) {
      const tokens = highlightCode(code, lang);
      expect(tokens).toContainEqual({ text: keyword, cls: "keyword" });
      expect(tokens).toContainEqual({ text: str, cls: "string" });
      expect(tokens).toContainEqual({ text: comment, cls: "comment" });
      expect(tokens.map((t) => t.text).join("")).toBe(code);
    }
  });

  it("highlights yaml keys", () => {
    expect(highlightCode("name: x", "yaml")[0]).toEqual({ text: "name", cls: "keyword" });
  });

  it("resolves aliases for the added languages", () => {
    expect(resolveLanguage("c")).toBe("c");
    expect(resolveLanguage("h")).toBe("c");
    expect(resolveLanguage("cpp")).toBe("cpp");
    expect(resolveLanguage("c++")).toBe("cpp");
    expect(resolveLanguage("hpp")).toBe("cpp");
    expect(resolveLanguage("cs")).toBe("csharp");
    expect(resolveLanguage("c#")).toBe("csharp");
    expect(resolveLanguage("yml")).toBe("yaml");
    expect(resolveLanguage("postgres")).toBe("sql");
    expect(resolveLanguage("mysql")).toBe("sql");
  });

  it("keeps c++ and c# fence tags intact through the fence parser", () => {
    expect(splitCodeFences("```c++\nint x;\n```")[0]).toMatchObject({ lang: "c++" });
    expect(splitCodeFences("```c#\nint x;\n```")[0]).toMatchObject({ lang: "c#" });
  });

  it("matches SQL keywords case-insensitively", () => {
    expect(highlightCode("SELECT", "sql")[0]).toEqual({ text: "SELECT", cls: "keyword" });
    expect(highlightCode("select", "sql")[0]).toEqual({ text: "select", cls: "keyword" });
  });

  it("does not start a SQL string inside a -- comment", () => {
    const tokens = highlightCode("-- don't stop\nselect 1", "sql");
    expect(tokens[0]).toEqual({ text: "-- don't stop", cls: "comment" });
    expect(tokens.filter((t) => t.cls === "string")).toEqual([]);
  });

  it("keeps yaml #, apostrophes and quoted values in their place", () => {
    const url = highlightCode("url: http://x.com/#frag", "yaml");
    expect(url.filter((t) => t.cls === "comment")).toEqual([]);
    const plain = highlightCode("title: don't stop # note", "yaml");
    expect(plain.filter((t) => t.cls === "string")).toEqual([]);
    expect(plain).toContainEqual({ text: "# note", cls: "comment" });
    expect(highlightCode("a: 'it''s'", "yaml")).toContainEqual({ text: "'it''s'", cls: "string" });
    expect(highlightCode("- 'x'", "yaml")).toContainEqual({ text: "'x'", cls: "string" });
  });

  it("closes SQL, C# verbatim and Java text-block strings correctly", () => {
    expect(highlightCode("'C:\\' -- c", "sql")).toContainEqual({ text: "-- c", cls: "comment" });
    const cs = highlightCode('@"C:\\dir\\" + x; // c', "csharp");
    expect(cs[0]).toEqual({ text: '@"C:\\dir\\"', cls: "string" });
    expect(cs).toContainEqual({ text: "// c", cls: "comment" });
    const java = highlightCode('"""\nreturn if\n""" + x', "java");
    expect(java[0]).toEqual({ text: '"""\nreturn if\n"""', cls: "string" });
  });

  it("highlights a hostile 40,000-character yaml run in linear time", () => {
    // A key that rescans a run of key characters from every position is
    // O(n^2): ~50 ms at the 4000-rune cap and seconds at 40k.
    const src = "-".repeat(40_000);
    const start = performance.now();
    const tokens = highlightCode(src, "yaml");
    const elapsed = performance.now() - start;
    expect(tokens.map((t) => t.text).join("")).toBe(src);
    expect(elapsed).toBeLessThan(500);
  });

  it("colours diff insertions, deletions, hunk and file headers", () => {
    const code = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n keep\n-old\n+new";
    const tokens = highlightCode(code, "diff");
    expect(tokens.map((t) => t.text).join("")).toBe(code);
    expect(tokens).toContainEqual({ text: "diff --git a/x b/x", cls: "keyword" });
    expect(tokens).toContainEqual({ text: "--- a/x", cls: "keyword" });
    expect(tokens).toContainEqual({ text: "+++ b/x", cls: "keyword" });
    expect(tokens).toContainEqual({ text: "@@ -1,2 +1,2 @@", cls: "keyword" });
    expect(tokens).toContainEqual({ text: "-old", cls: "deleted" });
    expect(tokens).toContainEqual({ text: "+new", cls: "inserted" });
    expect(tokens.filter((t) => t.cls === "inserted" || t.cls === "deleted")).toHaveLength(2);
  });

  it("does not colour a diff + or - that is not at the start of a line", () => {
    const tokens = highlightCode(" a - b + c\nx-y", "diff");
    expect(tokens.every((t) => t.cls === null)).toBe(true);
  });

  it("resolves patch and diff to the diff highlighter", () => {
    expect(resolveLanguage("patch")).toBe("diff");
    expect(resolveLanguage("diff")).toBe("diff");
    expect(highlightCode("+x", resolveLanguage("patch"))[0]).toEqual({
      text: "+x",
      cls: "inserted",
    });
  });

  it("renders a diff block with inserted and deleted spans", () => {
    const el = message("```diff\n-a\n+b\n```");
    expect(el.querySelector(".msg-codeblock .tok-inserted")?.textContent).toBe("+b");
    expect(el.querySelector(".msg-codeblock .tok-deleted")?.textContent).toBe("-a");
    expect(el.querySelector(".msg-codeblock")?.textContent).toBe("-a\n+b");
  });

  it("highlights diff in linear time on a hostile run", () => {
    const src = "-".repeat(40_000) + "\n" + "+\n".repeat(10_000);
    const start = performance.now();
    const tokens = highlightCode(src, "diff");
    const elapsed = performance.now() - start;
    expect(tokens.map((t) => t.text).join("")).toBe(src);
    expect(elapsed).toBeLessThan(500);
  });

  it("styles ansi colour, bold, underline, background and reset", () => {
    const tokens = highlightCode("\u001b[1;31mred\u001b[0m plain \u001b[42;4mx\u001b[0m", "ansi");
    expect(tokens).toEqual([
      { text: "red", cls: null, ansi: "ansi-31 ansi-b" },
      { text: " plain ", cls: null },
      { text: "x", cls: null, ansi: "ansi-42 ansi-u" },
    ]);
  });

  it("skips extended colour arguments and honours the per-attribute resets", () => {
    expect(highlightCode("\u001b[38;5;32my\u001b[48;2;1;31;4mz", "ansi")).toEqual([
      { text: "yz", cls: null },
    ]);
    expect(highlightCode("\u001b[1;4;31;42ma\u001b[39;49;22;24mb", "ansi")).toEqual([
      { text: "a", cls: null, ansi: "ansi-31 ansi-42 ansi-b ansi-u" },
      { text: "b", cls: null },
    ]);
  });

  it("treats a ---/+++ line after a hunk as a header, like highlight.js", () => {
    const tokens = highlightCode("@@ -1 +1 @@\n--- removed sql comment", "diff");
    expect(tokens).toContainEqual({ text: "--- removed sql comment", cls: "keyword" });
  });

  it("ignores unknown ansi codes and drops every escape from the text", () => {
    const input = "\u001b[99mA\u001b[2JB\u001b[34;99mC\u001b[0m";
    const tokens = highlightCode(input, "ansi");
    expect(tokens.map((t) => t.text).join("")).toBe("ABC");
    expect(tokens).toEqual([
      { text: "AB", cls: null },
      { text: "C", cls: null, ansi: "ansi-34" },
    ]);
  });

  it("keeps an ESC that does not start a complete sequence as text", () => {
    const tokens = highlightCode("a\u001b[3 b\u001bc", "ansi");
    expect(tokens.map((t) => t.text).join("")).toBe("a\u001b[3 b\u001bc");
  });

  it("treats an empty SGR parameter as reset", () => {
    const tokens = highlightCode("\u001b[31ma\u001b[mb", "ansi");
    expect(tokens).toEqual([
      { text: "a", cls: null, ansi: "ansi-31" },
      { text: "b", cls: null },
    ]);
  });

  it("renders ansi spans by class with no escape in the text", () => {
    const el = message("```ansi\n\u001b[31mred\u001b[0m ok\n```");
    const block = el.querySelector(".msg-codeblock")!;
    expect(block.querySelector("span.ansi-31")?.textContent).toBe("red");
    expect(block.textContent).toBe("red ok");
    expect(block.getAttribute("data-lang")).toBe("ansi");
  });

  it("tokenizes hostile ansi input in linear time", () => {
    const inputs = [
      "\u001b".repeat(40_000),
      "\u001b[".repeat(20_000),
      "\u001b[1".repeat(13_000),
      "\u001b[" + "1;".repeat(20_000),
      "\u001b[31m".repeat(8_000),
    ];
    for (const src of inputs) {
      const start = performance.now();
      const tokens = highlightCode(src, "ansi");
      const elapsed = performance.now() - start;
      expect(tokens.length).toBeGreaterThanOrEqual(0);
      expect(elapsed).toBeLessThan(500);
    }
  });

  it("does not treat a keyword-prefixed identifier as a keyword", () => {
    const tokens = highlightCode("constant = 1", "javascript");
    expect(tokens[0]!.cls).toBeNull();
    expect(tokens[0]!.text).toBe("constant = ");
    expect(tokens.some((t) => t.cls === "keyword")).toBe(false);
  });
});
