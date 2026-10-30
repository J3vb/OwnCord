import { describe, expect, it } from "vitest";

// The changelog module builds its constants and its two regular expressions
// when it loads. It is loaded inside this one test body, so every check on
// what those constants do runs in the test that loaded it.
describe("changelog module constants", () => {
  it("points release links at the repository and reads headings and inline spans", async () => {
    const { REPO_URL, releaseUrl, parseChangelog, renderChangelogBody } =
      await import("../../src/features/whats-new/changelog");

    // The repository the release links point at.
    expect(REPO_URL).toBe("https://github.com/J3vb/OwnCord");
    expect(releaseUrl("1.2.3")).toBe("https://github.com/J3vb/OwnCord/releases/tag/v1.2.3");

    // A release heading is recognised by its version; the rest of the line is ignored.
    const md = [
      "## v2",
      "- single digit",
      "## v2.2.0-beta.3",
      "- prerelease",
      "## v3.0.0 — A title with words",
      "- titled",
      "## v4.0.0 x",
      "- short title",
      "## v5.0.0\ttabbed",
      "- tab",
      "## Notes about ## v9.9.9",
      "- embedded",
      "## vNext",
      "- not a number",
      "## v",
      "- bare v",
    ].join("\n");
    expect(parseChangelog(md)).toEqual([
      { version: "2", body: "- single digit" },
      { version: "2.2.0-beta.3", body: "- prerelease" },
      { version: "3.0.0", body: "- titled" },
      { version: "4.0.0", body: "- short title" },
      { version: "5.0.0", body: "- tab" },
    ]);

    // Bold, code and link spans of any length.
    const long = renderChangelogBody(
      "- **a long bold run** then `a long code run` and [a long link](https://example.com/path?q=1) end",
    );
    expect(long.querySelector("strong")!.textContent).toBe("a long bold run");
    expect(long.querySelector("code")!.textContent).toBe("a long code run");
    const link = long.querySelector("a")!;
    expect(link.textContent).toBe("a long link");
    expect(link.getAttribute("href")).toBe("https://example.com/path?q=1");
    expect(long.querySelector("li")!.textContent).toBe(
      "a long bold run then a long code run and a long link end",
    );

    // One-character spans too.
    const short = renderChangelogBody("- **b** `c` [d](https://e.test)");
    expect(short.querySelector("strong")!.textContent).toBe("b");
    expect(short.querySelector("code")!.textContent).toBe("c");
    expect(short.querySelector("a")!.textContent).toBe("d");
    expect(short.querySelector("a")!.getAttribute("href")).toBe("https://e.test");

    // A closing bracket inside one span does not leak into another.
    const brackets = renderChangelogBody("[x]y](https://e.test) `a]b` **c]d**");
    expect(brackets.querySelector("code")!.textContent).toBe("a]b");
    expect(brackets.querySelector("strong")!.textContent).toBe("c]d");

    // A link target stops at whitespace and needs at least one character.
    const spaced = renderChangelogBody("[t](https://a.test/x y) [u]()");
    expect(spaced.querySelector("a")).toBeNull();
    expect(spaced.textContent).toBe("[t](https://a.test/x y) [u]()");

    // Spans may not be empty.
    const empty = renderChangelogBody("**** `` []( https://a.test)");
    expect(empty.querySelector("strong, code, a")).toBeNull();
  });
});
