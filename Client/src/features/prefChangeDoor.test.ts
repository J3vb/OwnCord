// `savePref` announces each write on one window event, and `onPrefChange` in
// lib/preferences.ts is the only way to listen for it. A hand-written listener
// repeats the event name and digs the key out of the event itself; a typo in
// either is silent, because the listener just never fires. This test pins that
// no other module names the event.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onPrefChange, PREF_CHANGE_EVENT, savePref } from "../lib/preferences";

const srcDir = path.resolve(__dirname, "..");

function withoutComments(text: string): string {
  // `//` after a `:` is a URL in a string, not a comment.
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const naming = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
  .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
  .map((entry) => entry.split(path.sep).join("/"))
  .filter((entry) =>
    withoutComments(readFileSync(path.join(srcDir, entry), "utf8")).includes(PREF_CHANGE_EVENT),
  );

describe("the pref-change door", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("only lib/preferences.ts names the event", () => {
    expect(naming).toEqual(["lib/preferences.ts"]);
  });

  it("runs the handler for a listed key only", () => {
    const handler = vi.fn();
    const off = onPrefChange(["a"], handler);
    savePref("b", 1);
    savePref("a", 1);
    off();
    savePref("a", 2);
    expect(handler.mock.calls).toEqual([["a"]]);
  });

  it("an event without a key reaches only an any-key listener", () => {
    const listed = vi.fn();
    const any = vi.fn();
    const offListed = onPrefChange([""], listed);
    const offAny = onPrefChange("any", any);
    window.dispatchEvent(new Event(PREF_CHANGE_EVENT));
    offListed();
    offAny();
    expect(any.mock.calls).toEqual([[""]]);
    expect(listed).not.toHaveBeenCalled();
  });

  it("a listener whose signal aborted never runs", () => {
    const handler = vi.fn();
    const controller = new AbortController();
    onPrefChange("any", handler, controller.signal);
    controller.abort();
    savePref("a", 1);
    expect(handler).not.toHaveBeenCalled();
  });
});
