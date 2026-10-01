/**
 * P4-02: the message-content parse cache. A rendered row re-materialised by
 * virtual scrolling must not re-tokenise content it already parsed; the parse
 * is keyed by the message id plus its editedAt, so an edit invalidates it.
 *
 * The proof is a spy on the markdown parser: a cache hit renders the same DOM
 * without parsing again, an edit parses the new content, clearContentParseCache
 * (the teardown hook) drops the entry, and omitting the key always parses.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as markdown from "../../src/lib/markdown";
import {
  renderMessageContent,
  clearContentParseCache,
} from "../../src/components/message-list/content-parser";

/** Count parseBlocks calls while `fn` runs. */
function parseCalls(fn: () => void): number {
  const spy = vi.spyOn(markdown, "parseBlocks");
  fn();
  const calls = spy.mock.calls.length;
  spy.mockRestore();
  return calls;
}

function render(content: string, key?: string): void {
  document.createDocumentFragment().appendChild(renderMessageContent(content, undefined, key));
}

describe("content parse cache", () => {
  beforeEach(() => {
    clearContentParseCache();
  });

  it("reuses the parse for an unchanged (id, editedAt) key", () => {
    expect(parseCalls(() => render("hello **world**", "1\u00000"))).toBeGreaterThan(0);
    // Second render of the same message: served from the cache, no re-parse.
    expect(parseCalls(() => render("hello **world**", "1\u00000"))).toBe(0);
  });

  it("re-parses when editedAt changes", () => {
    expect(parseCalls(() => render("hello **world**", "1\u00000"))).toBeGreaterThan(0);
    expect(parseCalls(() => render("hello *edited*", "1\u00001"))).toBeGreaterThan(0);

    const host = document.createElement("div");
    host.appendChild(renderMessageContent("hello *edited*", undefined, "1\u00001"));
    expect(host.querySelector("em")?.textContent).toBe("edited");
  });

  it("drops every entry on clearContentParseCache", () => {
    expect(parseCalls(() => render("hello **world**", "1\u00000"))).toBeGreaterThan(0);
    clearContentParseCache();
    expect(parseCalls(() => render("hello **world**", "1\u00000"))).toBeGreaterThan(0);
  });

  it("always parses when no cache key is given", () => {
    expect(parseCalls(() => render("hello **world**"))).toBeGreaterThan(0);
    expect(parseCalls(() => render("hello **world**"))).toBeGreaterThan(0);
  });

  it("never serves a stale parse when content changes under the same key", () => {
    const host = document.createElement("div");
    host.appendChild(renderMessageContent("hello **world**", undefined, "1\u00000"));
    host.replaceChildren();
    host.appendChild(renderMessageContent("hello **changed**", undefined, "1\u00000"));
    expect(host.querySelector("strong")?.textContent).toBe("changed");
  });
});
