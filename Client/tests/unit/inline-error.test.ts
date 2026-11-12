import { afterEach, describe, expect, it, vi } from "vitest";
import { createInlineError, type InlineError } from "@lib/ui/inlineError";

describe("createInlineError", () => {
  let ac: AbortController;
  const make = (onRetry = vi.fn(), testId?: string): InlineError => {
    ac = new AbortController();
    return createInlineError({
      retryLabel: "Retry",
      onRetry,
      signal: ac.signal,
      ...(testId !== undefined ? { testId } : {}),
    });
  };
  afterEach(() => ac.abort());

  it("starts empty: an alert region with no text and a hidden Retry", () => {
    const e = make(vi.fn(), "thing-error");
    expect(e.el.className).toBe("inline-error");
    expect(e.el.hidden).toBe(false);
    expect(e.message.getAttribute("role")).toBe("alert");
    expect(e.message.getAttribute("data-testid")).toBe("thing-error");
    expect(e.message.textContent).toBe("");
    expect(e.retry.getAttribute("type")).toBe("button");
    expect(e.retry.getAttribute("data-testid")).toBe("thing-error-retry");
    expect(e.retry.textContent).toBe("Retry");
    expect(e.retry.hidden).toBe(true);
    expect([...e.el.children]).toEqual([e.message, e.retry]);
  });

  it("leaves test ids off when none is given", () => {
    const e = make();
    expect(e.message.hasAttribute("data-testid")).toBe(false);
    expect(e.retry.hasAttribute("data-testid")).toBe(false);
  });

  it("shows a message with Retry, or without it when asked", () => {
    const e = make();
    e.show("Couldn't load.");
    expect(e.message.textContent).toBe("Couldn't load.");
    expect(e.retry.hidden).toBe(false);
    expect(e.el.classList.contains("shown")).toBe(true);
    e.show("Couldn't save.", false);
    expect(e.message.textContent).toBe("Couldn't save.");
    expect(e.retry.hidden).toBe(true);
  });

  it("an empty message shows nothing, not a lone Retry", () => {
    const e = make();
    e.show("");
    expect(e.retry.hidden).toBe(true);
    expect(e.el.classList.contains("shown")).toBe(false);
  });

  it("clear empties the line and hides Retry", () => {
    const e = make();
    e.show("Couldn't load.");
    e.clear();
    expect(e.message.textContent).toBe("");
    expect(e.retry.hidden).toBe(true);
    expect(e.el.classList.contains("shown")).toBe(false);
  });

  it("keeps a busy Retry on screen through clear, so its focus survives", () => {
    const e = make();
    e.show("Couldn't load.");
    e.setBusy(true);
    e.clear();
    expect(e.retry.hidden).toBe(false);
    expect(e.retry.getAttribute("aria-disabled")).toBe("true");
    e.setBusy(false);
    expect(e.retry.hasAttribute("aria-disabled")).toBe(false);
    e.clear();
    expect(e.retry.hidden).toBe(true);
  });

  it("calls onRetry on a click, not while busy, and not after the signal aborts", () => {
    const onRetry = vi.fn();
    const e = make(onRetry);
    e.show("Couldn't load.");
    e.retry.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
    e.setBusy(true);
    e.retry.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
    e.setBusy(false);
    ac.abort();
    e.retry.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
