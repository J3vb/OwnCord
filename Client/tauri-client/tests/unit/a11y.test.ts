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

  it("skips display:none controls when wrapping — a hidden control earlier in DOM order is not treated as the edge", () => {
    // Mirrors the member-picker modal: fields hidden via inline style.display
    // sit ahead of the only visible control in DOM order. Tabbing from that
    // visible control must wrap to itself, not escape to whatever the
    // browser's native tab order finds outside the dialog.
    const ac = new AbortController();
    const dialog = document.createElement("div");
    applyDialogSemantics(dialog);
    const hiddenA = document.createElement("input");
    hiddenA.style.display = "none";
    const hiddenB = document.createElement("input");
    hiddenB.style.display = "none";
    const visible = document.createElement("button");
    visible.textContent = "only visible control";
    dialog.append(hiddenA, hiddenB, visible);
    container.appendChild(dialog);
    trapFocus(dialog, ac.signal);

    visible.focus();
    const forward = tab(visible);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(visible);

    const backward = tab(visible, true);
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(visible);
    ac.abort();
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

  it("skips a display:none control that is earlier in DOM order than the first visible one", () => {
    // A hidden field (e.g. a group-name input revealed only after a
    // selection) sits first in DOM order. Browsers refuse to focus a
    // display:none element, so calling .focus() on it silently fails and
    // focus never lands in the dialog at all. The first *visible* focusable
    // must be chosen instead.
    const dialog = document.createElement("div");
    applyDialogSemantics(dialog);
    const hidden = document.createElement("input");
    hidden.style.display = "none";
    const visible = document.createElement("button");
    dialog.append(hidden, visible);
    container.appendChild(dialog);

    focusDialog(dialog);

    expect(document.activeElement).toBe(visible);
  });
});
