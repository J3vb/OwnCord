/**
 * The release notes the client ships with: CHANGELOG.md's released sections,
 * parsed into versions and rendered as DOM. The renderer covers the subset the
 * changelog is written in (### headings, bold sub-headings, paragraphs, "- "
 * lists with continuation lines, **bold**, `code` and [text](https://…) links)
 * and builds every node with createElement/textContent, never innerHTML.
 */

import { createElement } from "../../lib/dom";

export const REPO_URL = "https://github.com/J3vb/OwnCord";

export interface ChangelogVersion {
  /** The version without its leading "v", as the app reports it: "2.2.0-beta.3". */
  readonly version: string;
  /** The section's Markdown, heading line excluded. */
  readonly body: string;
}

const VERSION_HEADING = /^## v(\d\S*)(?:\s.*)?$/;

/** Every released section, newest first as the file lists them. The preamble
 *  and "Unreleased" are not releases, so they are left out. */
export function parseChangelog(markdown: string): ChangelogVersion[] {
  const versions: ChangelogVersion[] = [];
  let current: { version: string; lines: string[] } | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      if (current !== null) {
        versions.push({ version: current.version, body: current.lines.join("\n").trim() });
      }
      const match = VERSION_HEADING.exec(line);
      current = match?.[1] !== undefined ? { version: match[1], lines: [] } : null;
      continue;
    }
    current?.lines.push(line);
  }
  if (current !== null) {
    versions.push({ version: current.version, body: current.lines.join("\n").trim() });
  }
  return versions;
}

/** The section for a version the app reports, with or without a leading "v". */
export function findVersion(
  versions: readonly ChangelogVersion[],
  version: string,
): ChangelogVersion | null {
  const wanted = version.replace(/^v/, "");
  return versions.find((v) => v.version === wanted) ?? null;
}

/** The page on GitHub that carries a release's notes. */
export function releaseUrl(version: string): string {
  return `${REPO_URL}/releases/tag/v${encodeURIComponent(version.replace(/^v/, ""))}`;
}

const INLINE = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;

function appendInline(parent: HTMLElement, text: string): void {
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index;
    if (index > last) parent.append(text.slice(last, index));
    const [, bold, code, linkText, href] = match;
    if (bold !== undefined) {
      const strong = createElement("strong");
      appendInline(strong, bold);
      parent.append(strong);
    } else if (code !== undefined) {
      parent.append(createElement("code", {}, code));
    } else if (linkText !== undefined && href !== undefined) {
      // Only absolute web links become links; a repo-relative path would
      // resolve against the app's own origin, so it stays text.
      if (href.startsWith("https://")) {
        parent.append(
          createElement("a", { href, target: "_blank", rel: "noopener noreferrer" }, linkText),
        );
      } else {
        parent.append(linkText);
      }
    }
    last = index + match[0].length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

/** One version's notes as DOM, ready to append. */
export function renderChangelogBody(body: string): HTMLDivElement {
  const root = createElement("div", { class: "changelog-body" });
  let paragraph: string[] = [];
  let list: HTMLUListElement | null = null;
  let item: { el: HTMLLIElement; text: string } | null = null;

  const flushItem = (): void => {
    if (item !== null) appendInline(item.el, item.text);
    item = null;
  };
  const flushList = (): void => {
    flushItem();
    list = null;
  };
  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const text = paragraph.join(" ");
    paragraph = [];
    // A line that is only bold text is a sub-heading ("**Voice and video**").
    const subheading = /^\*\*([^*]+)\*\*$/.exec(text);
    if (subheading?.[1] !== undefined) {
      root.append(createElement("h5", { class: "changelog-subheading" }, subheading[1]));
      return;
    }
    const p = createElement("p");
    appendInline(p, text);
    root.append(p);
  };

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith("### ") || line.startsWith("#### ")) {
      flushParagraph();
      flushList();
      root.append(createElement("h4", { class: "changelog-heading" }, line.replace(/^#+\s*/, "")));
    } else if (/^\s*[-*] /.test(line)) {
      flushParagraph();
      flushItem();
      if (list === null) {
        list = createElement("ul");
        root.append(list);
      }
      const li = createElement("li");
      list.append(li);
      item = { el: li, text: line.replace(/^\s*[-*] /, "") };
    } else if (line.trim() === "") {
      flushParagraph();
      flushList();
    } else if (item !== null) {
      item.text += " " + line.trim();
    } else {
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return root;
}
