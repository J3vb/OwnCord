import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
    const md = readFileSync(resolve(import.meta.dirname, "../../../CHANGELOG.md"), "utf8");
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
