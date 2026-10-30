// lib/ui/clipboard.ts is the only door to the clipboard for text. Its copy never
// rejects, works out a missing clipboard (a page that is not a secure context)
// as a failure, and every copy tells the user how it went. This test pins that
// no other module writes text to the clipboard itself, and pins the helpers.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const showToast = vi.hoisted(() => vi.fn());
vi.mock("../lib/ui/toast", () => ({ showToast }));

import { copyText, copyThenRelabel, copyThenToast } from "../lib/ui/clipboard";

const srcDir = path.resolve(__dirname, "..");

function withoutComments(text: string): string {
  // `//` after a `:` is a URL in a string, not a comment.
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const writing = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
  .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
  .map((entry) => entry.split(path.sep).join("/"))
  .filter((entry) =>
    /\.writeText\s*\(/.test(withoutComments(readFileSync(path.join(srcDir, entry), "utf8"))),
  );

const writeText = vi.fn<(text: string) => Promise<void>>();
const labels = { idle: "Copy", done: "Copied", failed: "Copy failed" };

function setClipboard(value: unknown): void {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true });
}

describe("the clipboard door", () => {
  beforeEach(() => {
    writeText.mockReset().mockResolvedValue(undefined);
    setClipboard({ writeText });
    showToast.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("only lib/ui/clipboard.ts writes text to the clipboard", () => {
    expect(writing).toEqual(["lib/ui/clipboard.ts"]);
  });

  it("copyText resolves false, not a rejection, when the write is refused", async () => {
    writeText.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    await expect(copyText("x")).resolves.toBe(false);
  });

  it("copyText resolves false when there is no clipboard (not a secure context)", async () => {
    setClipboard(undefined);
    await expect(copyText("x")).resolves.toBe(false);
  });

  it("copyThenToast shows the done or the failed toast", async () => {
    copyThenToast("a", "done", "failed");
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith("done", "success"));
    writeText.mockRejectedValue(new Error("no"));
    copyThenToast("b", "done", "failed");
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith("failed", "error"));
    expect(writeText.mock.calls).toEqual([["a"], ["b"]]);
  });

  it("copyThenRelabel shows the result, then the idle label after the wait", async () => {
    vi.useFakeTimers();
    const button = document.createElement("button");
    button.textContent = labels.idle;
    copyThenRelabel("a", button, labels, { ms: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(button.textContent).toBe(labels.done);
    await vi.advanceTimersByTimeAsync(1000);
    expect(button.textContent).toBe(labels.idle);
  });

  it("a second press restarts the wait", async () => {
    vi.useFakeTimers();
    const button = document.createElement("button");
    copyThenRelabel("a", button, labels, { ms: 1000 });
    await vi.advanceTimersByTimeAsync(800);
    writeText.mockRejectedValue(new Error("no"));
    copyThenRelabel("b", button, labels, { ms: 1000 });
    await vi.advanceTimersByTimeAsync(300);
    expect(button.textContent).toBe(labels.failed);
    await vi.advanceTimersByTimeAsync(700);
    expect(button.textContent).toBe(labels.idle);
  });

  it("an aborted owner drops the pending reset and a late result", async () => {
    vi.useFakeTimers();
    const button = document.createElement("button");
    const owner = new AbortController();
    copyThenRelabel("a", button, labels, { signal: owner.signal, ms: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    owner.abort();
    await vi.advanceTimersByTimeAsync(1000);
    expect(button.textContent).toBe(labels.done);

    let finish: (() => void) | undefined;
    writeText.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const late = new AbortController();
    const other = document.createElement("button");
    other.textContent = labels.idle;
    copyThenRelabel("b", other, labels, { signal: late.signal });
    late.abort();
    finish?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(other.textContent).toBe(labels.idle);
  });
});
