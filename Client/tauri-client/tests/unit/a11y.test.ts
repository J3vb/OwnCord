import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { applyDialogSemantics, trapFocus, focusDialog } from "@lib/a11y";

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  container.remove();
});

function tab(el: Element, shiftKey = false): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
}

describe("applyDialogSemantics", () => {
  it("stamps role, aria-modal, and tabindex", () => {
    const el = document.createElement("div");
    applyDialogSemantics(el, { label: "Settings" });

    expect(el.getAttribute("role")).toBe("dialog");
    expect(el.getAttribute("aria-modal")).toBe("true");
    expect(el.getAttribute("tabindex")).toBe("-1");
    expect(el.getAttribute("aria-label")).toBe("Settings");
  });

  it("prefers labelledBy over label", () => {
    const el = document.createElement("div");
    applyDialogSemantics(el, { label: "x", labelledBy: "title-id" });

    expect(el.getAttribute("aria-labelledby")).toBe("title-id");
    expect(el.getAttribute("aria-label")).toBeNull();
  });
});

describe("trapFocus", () => {
  function buildDialog(): {
    dialog: HTMLDivElement;
    first: HTMLButtonElement;
    last: HTMLButtonElement;
  } {
    const dialog = document.createElement("div");
    applyDialogSemantics(dialog);
    const first = document.createElement("button");
    first.textContent = "first";
    const last = document.createElement("button");
    last.textContent = "last";
    dialog.appendChild(first);
    dialog.appendChild(last);
    container.appendChild(dialog);
    return { dialog, first, last };
  }

  it("wraps Tab from the last focusable to the first", () => {
    const ac = new AbortController();
    const { dialog, first, last } = buildDialog();
    trapFocus(dialog, ac.signal);

    last.focus();
    const e = tab(last);

    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    ac.abort();
  });

  it("wraps Shift+Tab from the first focusable to the last", () => {
    const ac = new AbortController();
    const { dialog, first, last } = buildDialog();
    trapFocus(dialog, ac.signal);

    first.focus();
    const e = tab(first, true);

    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    ac.abort();
  });

  it("lets Tab move freely between interior focusables", () => {
    const ac = new AbortController();
    const { dialog, first } = buildDialog();
    const middle = document.createElement("input");
    dialog.insertBefore(middle, dialog.lastChild);
    trapFocus(dialog, ac.signal);

    first.focus();
    const e = tab(first);

    // Not at an edge — the browser's normal tab order applies.
    expect(e.defaultPrevented).toBe(false);
    ac.abort();
  });

  it("wraps from the container itself (dialog focused, nothing inside focused yet)", () => {
    const ac = new AbortController();
    const { dialog, first } = buildDialog();
    trapFocus(dialog, ac.signal);

    dialog.focus();
    tab(dialog);

    expect(document.activeElement).toBe(first);
    ac.abort();
  });

  it("holds focus on a dialog with no focusable content", () => {
    const ac = new AbortController();
    const dialog = document.createElement("div");
    applyDialogSemantics(dialog);
    container.appendChild(dialog);
    trapFocus(dialog, ac.signal);

    dialog.focus();
    const e = tab(dialog);

    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dialog);
    ac.abort();
  });

  it("stops trapping once the signal aborts", () => {
    const ac = new AbortController();
    const { dialog, last } = buildDialog();
    trapFocus(dialog, ac.signal);
    ac.abort();

    last.focus();
    const e = tab(last);

    expect(e.defaultPrevented).toBe(false);
  });
});

describe("focusDialog", () => {
  it("focuses the first focusable control and restores on close", () => {
    const outside = document.createElement("button");
    container.appendChild(outside);
    outside.focus();

    const dialog = document.createElement("div");
    applyDialogSemantics(dialog);
    const btn = document.createElement("button");
    dialog.appendChild(btn);
    container.appendChild(dialog);

    const restore = focusDialog(dialog);
    expect(document.activeElement).toBe(btn);

    restore();
    expect(document.activeElement).toBe(outside);
  });

  it("focuses the container when nothing inside is focusable", () => {
    const dialog = document.createElement("div");
    applyDialogSemantics(dialog);
    container.appendChild(dialog);

    focusDialog(dialog);

    expect(document.activeElement).toBe(dialog);
  });

  it("does not restore to an element no longer in the document", () => {
    const outside = document.createElement("button");
    container.appendChild(outside);
    outside.focus();

    const dialog = document.createElement("div");
    applyDialogSemantics(dialog);
    container.appendChild(dialog);
    const restore = focusDialog(dialog);

    outside.remove();
    expect(() => restore()).not.toThrow();
    expect(document.activeElement).not.toBe(outside);
  });
});
