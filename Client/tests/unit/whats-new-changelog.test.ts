import { describe, it, expect, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  findVersion,
  parseChangelog,
  releaseUrl,
  renderChangelogBody,
} from "../../src/features/whats-new/changelog";
import { isNewVersion, markVersionSeen } from "../../src/features/whats-new/seenVersion";

const SAMPLE = [
  "# Changelog",
  "",
  "Preamble that is not a release.",
  "",
  "## Unreleased",
  "",
  "- Not shipped yet",
  "",
  "## v2.1.0",
  "",
  "**OwnCord 2.1** adds things.",
  "",
  "### Fixed",
  "",
  "**Voice**",
  "",
  "- Mute works with `Ctrl+M` again,",
  "  across restarts.",
  "- See [the docs](https://example.com/docs) or [a path](docs/x.md).",
  "",
  "## v2.0.0 — First release",
  "",
  "- First release",
].join("\n");

/** Walk up from this file to the nearest CHANGELOG.md: works in the repo and in Stryker's sandbox. */
function findChangelog(): string {
  let dir = import.meta.dirname;
  for (;;) {
    const candidate = resolve(dir, "CHANGELOG.md");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`CHANGELOG.md not found above ${import.meta.dirname}`);
    dir = parent;
  }
}

describe("parseChangelog", () => {
  it("keeps released sections only, newest first, without the leading v", () => {
    const versions = parseChangelog(SAMPLE);
    expect(versions.map((v) => v.version)).toEqual(["2.1.0", "2.0.0"]);
    expect(versions[0]!.body).toContain("### Fixed");
    expect(versions[0]!.body).not.toContain("Not shipped yet");
    expect(versions[1]!.body).toBe("- First release");
  });

  it("finds a version with or without a leading v", () => {
    const versions = parseChangelog(SAMPLE);
    expect(findVersion(versions, "2.0.0")?.version).toBe("2.0.0");
    expect(findVersion(versions, "v2.1.0")?.version).toBe("2.1.0");
    expect(findVersion(versions, "9.9.9")).toBeNull();
  });

  it("parses the repository's own CHANGELOG.md, with notes for this build's version", () => {
    const md = readFileSync(findChangelog(), "utf8");
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8"),
    ) as { version: string };
    const versions = parseChangelog(md);
    expect(versions.length).toBeGreaterThan(3);
    // A version bump without its CHANGELOG section would never show What's new.
    expect(findVersion(versions, pkg.version)?.version).toBe(pkg.version);
    for (const v of versions) {
      expect(v.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(v.body).not.toMatch(/^## /m);
    }
  });

  it("links a release to its GitHub page", () => {
    expect(releaseUrl("v2.2.0-beta.3")).toBe(
      "https://github.com/J3vb/OwnCord/releases/tag/v2.2.0-beta.3",
    );
  });
});

describe("renderChangelogBody", () => {
  const body = parseChangelog(SAMPLE)[0]!.body;

  it("renders headings, sub-headings, paragraphs and lists", () => {
    const el = renderChangelogBody(body);
    expect(el.querySelector("p strong")?.textContent).toBe("OwnCord 2.1");
    expect(el.querySelector("h4")?.textContent).toBe("Fixed");
    expect(el.querySelector("h5")?.textContent).toBe("Voice");
    const items = [...el.querySelectorAll("li")].map((li) => li.textContent);
    expect(items[0]).toBe("Mute works with Ctrl+M again, across restarts.");
    expect(el.querySelector("li code")?.textContent).toBe("Ctrl+M");
  });

  it("links only absolute https URLs and opens them outside the app", () => {
    const el = renderChangelogBody(body);
    const links = [...el.querySelectorAll("a")];
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute("href")).toBe("https://example.com/docs");
    expect(links[0]!.getAttribute("target")).toBe("_blank");
    expect(el.textContent).toContain("a path");
  });

  it("never turns changelog text into markup", () => {
    const el = renderChangelogBody("- <img src=x onerror=alert(1)> **<b>bold</b>**");
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("b")).toBeNull();
    expect(el.querySelector("li")?.textContent).toBe("<img src=x onerror=alert(1)> <b>bold</b>");
  });
});

describe("seen version", () => {
  beforeEach(() => localStorage.clear());

  it("records a fresh install silently", () => {
    expect(isNewVersion("2.1.0")).toBe(false);
    expect(isNewVersion("2.1.0")).toBe(false);
  });

  it("reports a version change until it is marked seen", () => {
    markVersionSeen("2.0.0");
    expect(isNewVersion("2.1.0")).toBe(true);
    expect(isNewVersion("2.1.0")).toBe(true);
    markVersionSeen("2.1.0");
    expect(isNewVersion("2.1.0")).toBe(false);
  });
});

describe("parseChangelog section boundaries", () => {
  it("returns nothing for text without a release heading", () => {
    expect(parseChangelog("")).toEqual([]);
    expect(parseChangelog("# Changelog\n\nJust a preamble.")).toEqual([]);
  });

  it("reads Windows line endings", () => {
    const versions = parseChangelog(
      "## v1.0.0\r\n\r\n- one\r\n- two\r\n\r\n## v0.9.0\r\n- old\r\n",
    );
    expect(versions).toEqual([
      { version: "1.0.0", body: "- one\n- two" },
      { version: "0.9.0", body: "- old" },
    ]);
  });

  it("trims the body of the last section as well as the others", () => {
    const versions = parseChangelog("## v1.0.0\n\n\n  - kept\n\n\n");
    expect(versions[0]!.body).toBe("- kept");
  });

  it("ends a release at a following section that is not a release", () => {
    const versions = parseChangelog("## v1.0.0\n- shipped\n\n## Unreleased\n- later\n");
    expect(versions).toHaveLength(1);
    expect(versions[0]!.body).toBe("- shipped");
  });

  it("drops a section whose heading is not a version number", () => {
    const versions = parseChangelog("## vNext\n- no\n\n## 1.0.0\n- no\n\n## v1.2.3\n- yes");
    expect(versions.map((v) => v.version)).toEqual(["1.2.3"]);
  });

  it("takes the version up to the first space of the heading", () => {
    const versions = parseChangelog("## v2.2.0-beta.3 (2026-10-01)\n- a\n");
    expect(versions[0]!.version).toBe("2.2.0-beta.3");
  });

  it("keeps deeper headings inside the section body", () => {
    const versions = parseChangelog("## v1.0.0\n### Fixed\n- x\n#### Detail\n");
    expect(versions[0]!.body).toBe("### Fixed\n- x\n#### Detail");
  });

  it("does not treat a heading marker without its space as a section", () => {
    const versions = parseChangelog("## v1.0.0\n##nospace\n- x");
    expect(versions[0]!.body).toBe("##nospace\n- x");
  });
});

describe("findVersion and releaseUrl edge forms", () => {
  const versions = [
    { version: "1.0.0", body: "a" },
    { version: "v1", body: "b" },
  ];

  it("strips only one leading v", () => {
    expect(findVersion(versions, "vv1")?.body).toBe("b");
    expect(findVersion(versions, "v1.0.0")?.body).toBe("a");
  });

  it("does not strip a v that is not leading", () => {
    expect(findVersion([{ version: "1v", body: "c" }], "1v")?.body).toBe("c");
  });

  it("returns null for an empty list", () => {
    expect(findVersion([], "1.0.0")).toBeNull();
  });

  it("encodes the tag and strips a leading v from it", () => {
    expect(releaseUrl("1.0.0+build 5")).toBe(
      "https://github.com/J3vb/OwnCord/releases/tag/v1.0.0%2Bbuild%205",
    );
    expect(releaseUrl("v1.0.0")).toBe("https://github.com/J3vb/OwnCord/releases/tag/v1.0.0");
    expect(releaseUrl("1.0.0v")).toBe("https://github.com/J3vb/OwnCord/releases/tag/v1.0.0v");
  });
});

describe("renderChangelogBody structure", () => {
  it("renders an empty body as an empty container", () => {
    const el = renderChangelogBody("");
    expect(el.tagName).toBe("DIV");
    expect(el.className).toBe("changelog-body");
    expect(el.childNodes).toHaveLength(0);
    expect(renderChangelogBody("  \n\n   \n").childNodes).toHaveLength(0);
  });

  it("gives headings and sub-headings their classes and strips the markers", () => {
    const el = renderChangelogBody("### Added\n\n#### Detail\n\n**Voice and video**");
    const [h3, h4, h5] = [...el.children];
    expect(h3!.tagName).toBe("H4");
    expect(h3!.className).toBe("changelog-heading");
    expect(h3!.textContent).toBe("Added");
    expect(h4!.tagName).toBe("H4");
    expect(h4!.textContent).toBe("Detail");
    expect(h5!.tagName).toBe("H5");
    expect(h5!.className).toBe("changelog-subheading");
    expect(h5!.textContent).toBe("Voice and video");
  });

  it("strips every space after the heading marker", () => {
    const el = renderChangelogBody("###   Fixed\n\n####  Two");
    expect([...el.querySelectorAll("h4")].map((h) => h.textContent)).toEqual(["Fixed", "Two"]);
  });

  it("closes a paragraph and a list when a heading follows without a blank line", () => {
    const el = renderChangelogBody("intro\n### Head\n- a\n### Next\n- b");
    expect([...el.children].map((c) => c.tagName)).toEqual(["P", "H4", "UL", "H4", "UL"]);
    expect(el.children[0]!.textContent).toBe("intro");
  });

  it("joins the lines of a paragraph with single spaces", () => {
    const el = renderChangelogBody("first line\n   second line  \nthird");
    expect(el.children).toHaveLength(1);
    expect(el.children[0]!.tagName).toBe("P");
    expect(el.children[0]!.textContent).toBe("first line second line third");
  });

  it("splits paragraphs at a blank line, including a whitespace-only one", () => {
    const el = renderChangelogBody("one\n   \ntwo\n\nthree");
    expect([...el.children].map((c) => c.textContent)).toEqual(["one", "two", "three"]);
  });

  it("ends a paragraph where a list starts", () => {
    const el = renderChangelogBody("lead in\n- item");
    expect([...el.children].map((c) => c.tagName)).toEqual(["P", "UL"]);
    expect(el.children[0]!.textContent).toBe("lead in");
    expect(el.children[1]!.textContent).toBe("item");
  });

  it("accepts dash and star bullets, indented or not, in one list", () => {
    const el = renderChangelogBody("- a\n* b\n  - c\n   * d");
    expect(el.querySelectorAll("ul")).toHaveLength(1);
    expect([...el.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("starts a new list after a blank line", () => {
    const el = renderChangelogBody("- a\n\n- b");
    expect(el.querySelectorAll("ul")).toHaveLength(2);
    expect(el.querySelectorAll("ul > li")).toHaveLength(2);
  });

  it("does not read a dash or star without a space as a bullet", () => {
    const el = renderChangelogBody("-nope\n\n*star*");
    expect(el.querySelector("ul")).toBeNull();
    expect([...el.children].map((c) => c.tagName)).toEqual(["P", "P"]);
  });

  it("folds continuation lines into the item with one space and no trailing blanks", () => {
    const el = renderChangelogBody("- start   \n     middle  \n  end   ");
    expect(el.querySelector("li")!.textContent).toBe("start middle end");
  });

  it("keeps text that follows a list item without a blank line inside that item", () => {
    const el = renderChangelogBody("- item\nmore");
    expect(el.querySelectorAll("p")).toHaveLength(0);
    expect(el.querySelector("li")!.textContent).toBe("item more");
  });

  it("treats a bold line with other text around it as a paragraph, not a sub-heading", () => {
    const el = renderChangelogBody("**Bold** and more\n\n**one** and **two**");
    expect(el.querySelector("h5")).toBeNull();
    expect(el.querySelectorAll("p")).toHaveLength(2);
  });

  it("takes a sub-heading from a bold run that wraps across lines", () => {
    const el = renderChangelogBody("**Voice\nand video**");
    expect(el.querySelector("p")).toBeNull();
    expect(el.querySelector("h5")!.textContent).toBe("Voice and video");
  });

  it("keeps a bold run with nested stars as a paragraph", () => {
    const el = renderChangelogBody("**a *b* c**");
    expect(el.querySelector("h5")).toBeNull();
    expect(el.querySelector("p")).not.toBeNull();
  });
});

describe("renderChangelogBody inline text", () => {
  it("keeps the text around bold, code and links in order, with no empty nodes", () => {
    const el = renderChangelogBody("pre **b** mid `c` post [t](https://x.test/p) end");
    const p = el.querySelector("p")!;
    const kinds = [...p.childNodes].map((n) =>
      n.nodeType === Node.TEXT_NODE ? `text:${n.textContent}` : (n as Element).tagName,
    );
    expect(kinds).toEqual([
      "text:pre ",
      "STRONG",
      "text: mid ",
      "CODE",
      "text: post ",
      "A",
      "text: end",
    ]);
  });

  it("emits no stray text node when a token starts or ends the text", () => {
    expect(renderChangelogBody("**b**").querySelector("p, h5")!.childNodes).toHaveLength(1);
    const p = renderChangelogBody("`a` `b`").querySelector("p")!;
    expect([...p.childNodes].map((n) => n.textContent)).toEqual(["a", " ", "b"]);
    expect(renderChangelogBody("`a`x").querySelector("p")!.childNodes).toHaveLength(2);
  });

  it("nests code and links inside bold text", () => {
    const strong = renderChangelogBody(
      "- **run `go test` or [docs](https://a.test)**",
    ).querySelector("li > strong")!;
    expect(strong.textContent).toBe("run go test or docs");
    expect(strong.querySelector("code")!.textContent).toBe("go test");
    expect(strong.querySelector("a")!.getAttribute("href")).toBe("https://a.test");
  });

  it("builds links that open outside the app without leaking the opener", () => {
    const a = renderChangelogBody("[site](https://example.com/a?b=1)").querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://example.com/a?b=1");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a.textContent).toBe("site");
  });

  it("leaves a plain http link, a relative link and a javascript link as text", () => {
    const el = renderChangelogBody(
      "[one](http://example.com) [two](/docs/x.md) [three](javascript:alert(1)) [four](HTTPS://X.test)",
    );
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toBe("one two three) four");
  });

  it("does not link when the target has a space", () => {
    const el = renderChangelogBody("[t](https://a.test/x y)");
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toBe("[t](https://a.test/x y)");
  });

  it("leaves unmatched markers as literal text", () => {
    const el = renderChangelogBody("a ** b ` c [d]");
    expect(el.querySelector("strong, code, a")).toBeNull();
    expect(el.textContent).toBe("a ** b ` c [d]");
  });

  it("matches the shortest bold run and does not span code across a backtick pair", () => {
    const p = renderChangelogBody("**a** x **b**").querySelector("p")!;
    expect([...p.querySelectorAll("strong")].map((s) => s.textContent)).toEqual(["a", "b"]);
    expect(p.textContent).toBe("a x b");
    const q = renderChangelogBody("`a` and `b`").querySelector("p")!;
    expect([...q.querySelectorAll("code")].map((s) => s.textContent)).toEqual(["a", "b"]);
  });
});
