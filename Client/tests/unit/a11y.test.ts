import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  applyDialogSemantics,
  trapFocus,
  focusDialog,
  enableRovingNavigation,
  setRovingTabindex,
} from "@lib/ui/a11y";

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

  it("skips a disabled trailing control when wrapping — Tab from the last enabled control wraps instead of escaping", () => {
    // Mirrors CreateChannelModal: the submit button is disabled while a
    // request is in flight (and, being disabled, gets blurred by the
    // browser first). The trap must treat the last *enabled* control as the
    // wrap edge, not the disabled one that can never hold focus.
    const ac = new AbortController();
    const dialog = document.createElement("div");
    applyDialogSemantics(dialog);
    const first = document.createElement("button");
    first.textContent = "first";
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "cancel";
    const submitBtn = document.createElement("button");
    submitBtn.textContent = "submit";
    submitBtn.disabled = true;
    dialog.append(first, cancelBtn, submitBtn);
    container.appendChild(dialog);
    trapFocus(dialog, ac.signal);

    cancelBtn.focus();
    const forward = tab(cancelBtn);

    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
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

  it("focuses the fallback when the opener is in an inert subtree by close time", () => {
    const region = document.createElement("div");
    const opener = document.createElement("button");
    const fallback = document.createElement("button");
    region.appendChild(opener);
    container.append(region, fallback);
    opener.focus();

    const dialog = document.createElement("div");
    applyDialogSemantics(dialog);
    container.appendChild(dialog);
    const restore = focusDialog(dialog, () => fallback);

    // e.g. the narrow-width sidebar drawer closed while the dialog was open
    region.setAttribute("inert", "");
    restore();

    expect(document.activeElement).toBe(fallback);
  });

  it("focuses the fallback when the opener is gone by close time", () => {
    const opener = document.createElement("button");
    const fallback = document.createElement("button");
    container.append(opener, fallback);
    opener.focus();

    const dialog = document.createElement("div");
    applyDialogSemantics(dialog);
    container.appendChild(dialog);
    const restore = focusDialog(dialog, () => fallback);

    opener.remove(); // e.g. the dialog deleted the row that opened it
    dialog.remove();
    restore();
    expect(document.activeElement).toBe(fallback);
  });

  it("prefers a still-connected opener over the fallback, and ignores a detached fallback", () => {
    const opener = document.createElement("button");
    const fallback = document.createElement("button");
    container.append(opener, fallback);
    opener.focus();

    const dialog = document.createElement("div");
    applyDialogSemantics(dialog);
    container.appendChild(dialog);
    focusDialog(dialog, () => fallback)();
    expect(document.activeElement).toBe(opener);

    const detached = document.createElement("button");
    fallback.focus();
    const restore = focusDialog(dialog, () => detached);
    fallback.remove();
    restore();
    expect(document.activeElement).not.toBe(detached);
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

  it("skips a disabled control that is earlier in DOM order than the first enabled one", () => {
    const dialog = document.createElement("div");
    applyDialogSemantics(dialog);
    const disabledBtn = document.createElement("button");
    disabledBtn.disabled = true;
    const enabledBtn = document.createElement("button");
    dialog.append(disabledBtn, enabledBtn);
    container.appendChild(dialog);

    focusDialog(dialog);

    expect(document.activeElement).toBe(enabledBtn);
  });
});

describe("enableRovingNavigation", () => {
  it("moves by row width on ArrowUp/ArrowDown in grid orientation", () => {
    const cells = Array.from({ length: 16 }, () => {
      const cell = document.createElement("div");
      cell.className = "cell";
      container.appendChild(cell);
      return cell;
    });
    const ac = new AbortController();
    enableRovingNavigation(container, ".cell", ac.signal, "grid", 4);
    cells[0]!.focus();

    const down = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    cells[0]!.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(cells[4]);

    const up = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true });
    cells[4]!.dispatchEvent(up);
    expect(document.activeElement).toBe(cells[0]);

    // Left/Right still step by one.
    const right = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    cells[0]!.dispatchEvent(right);
    expect(document.activeElement).toBe(cells[1]);
    ac.abort();
  });

  it("does not step past the edge of a grid row with ArrowDown", () => {
    const cells = Array.from({ length: 3 }, () => {
      const cell = document.createElement("div");
      cell.className = "cell";
      container.appendChild(cell);
      return cell;
    });
    const ac = new AbortController();
    enableRovingNavigation(container, ".cell", ac.signal, "grid", 8);
    cells[0]!.focus();

    const down = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    cells[0]!.dispatchEvent(down);
    // No cell a row below: stay put rather than jump to the end.
    expect(document.activeElement).toBe(cells[0]);
    ac.abort();
  });

  it("keeps grid ArrowUp/ArrowDown inside the focused cell's own grid", () => {
    // Two category grids of 6 and 4 cells, 4 columns each: a flat-list step
    // of 4 from A[2] would land on B[0], the wrong column.
    const grids = [6, 4].map((n) => {
      const grid = document.createElement("div");
      container.appendChild(grid);
      return Array.from({ length: n }, () => {
        const cell = document.createElement("div");
        cell.className = "cell";
        grid.appendChild(cell);
        return cell;
      });
    });
    const a = grids[0]!;
    const b = grids[1]!;
    const ac = new AbortController();
    enableRovingNavigation(container, ".cell", ac.signal, "grid", 4);

    a[2]!.focus();
    a[2]!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(a[2]);

    b[0]!.focus();
    b[0]!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(b[0]);

    a[1]!.focus();
    a[1]!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(a[5]);
    ac.abort();
  });

  it("leaves a modified arrow (Alt+↓ steps channels) to the app", () => {
    const cells = [0, 1].map(() => {
      const cell = document.createElement("div");
      cell.className = "cell";
      container.appendChild(cell);
      return cell;
    });
    const ac = new AbortController();
    enableRovingNavigation(container, ".cell", ac.signal, "vertical");
    cells[0]!.focus();

    for (const mod of ["altKey", "ctrlKey", "metaKey"] as const) {
      const e = new KeyboardEvent("keydown", {
        key: "ArrowDown",
        [mod]: true,
        bubbles: true,
        cancelable: true,
      });
      cells[0]!.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
      expect(cells[1]!.getAttribute("tabindex")).not.toBe("0");
    }

    const plain = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    cells[0]!.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(true);
    expect(cells[1]!.getAttribute("tabindex")).toBe("0");
    ac.abort();
  });

  it("leaves Enter on a control nested inside a cell to that control", () => {
    const cell = document.createElement("div");
    cell.className = "cell";
    const nested = document.createElement("button");
    cell.appendChild(nested);
    container.appendChild(cell);
    const onCell = vi.fn();
    cell.addEventListener("click", onCell);
    const ac = new AbortController();
    enableRovingNavigation(container, ".cell", ac.signal, "vertical");

    const onNested = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    nested.dispatchEvent(onNested);
    expect(onNested.defaultPrevented).toBe(false);
    expect(onCell).not.toHaveBeenCalled();

    const onItself = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    cell.dispatchEvent(onItself);
    expect(onItself.defaultPrevented).toBe(true);
    expect(onCell).toHaveBeenCalledTimes(1);
    ac.abort();
  });

  it("keeps one Tab stop when an arrow starts from a cell focused by mouse", () => {
    const [first, , third, fourth] = Array.from({ length: 4 }, () => {
      const cell = document.createElement("div");
      cell.className = "cell";
      container.appendChild(cell);
      return cell;
    });
    setRovingTabindex(container, ".cell");
    const ac = new AbortController();
    enableRovingNavigation(container, ".cell", ac.signal);

    // A click focuses a tabindex=-1 cell without moving the stop off `first`.
    third!.focus();
    third!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
    );

    expect(Array.from(container.querySelectorAll(".cell[tabindex='0']"))).toEqual([fourth]);
    expect(first!.getAttribute("tabindex")).toBe("-1");
    ac.abort();
  });
});

describe("setRovingTabindex", () => {
  function cells(n: number): HTMLElement[] {
    return Array.from({ length: n }, () => {
      const cell = document.createElement("div");
      cell.className = "cell";
      container.appendChild(cell);
      return cell;
    });
  }
  const stops = (): Element[] => Array.from(container.querySelectorAll(".cell[tabindex='0']"));

  it("puts the first Tab stop on the current cell, else the first", () => {
    const [first, , third] = cells(3);
    setRovingTabindex(container, ".cell");
    expect(stops()).toEqual([first]);

    first!.removeAttribute("tabindex");
    third!.classList.add("active");
    setRovingTabindex(container, ".cell");
    expect(stops()).toEqual([third]);
  });

  it("keeps the Tab stop where it was across a re-render", () => {
    const [first, second] = cells(3);
    setRovingTabindex(container, ".cell");
    first!.setAttribute("tabindex", "-1");
    second!.setAttribute("tabindex", "0");

    setRovingTabindex(container, ".cell");
    expect(stops()).toEqual([second]);
  });
});

function press(el: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
}

function makeCells(n: number, parent: HTMLElement = container): HTMLElement[] {
  return Array.from({ length: n }, (_, i) => {
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.textContent = String(i);
    cell.setAttribute("tabindex", "-1");
    parent.appendChild(cell);
    return cell;
  });
}

function dialogWith(...inner: HTMLElement[]): HTMLDivElement {
  const dialog = document.createElement("div");
  dialog.append(...inner);
  container.appendChild(dialog);
  return dialog;
}
function mkEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function pair() {
  const dialog = document.createElement("div");
  const a = document.createElement("button");
  const b = document.createElement("button");
  const c = document.createElement("button");
  dialog.append(a, b, c);
  container.appendChild(dialog);
  const ac = new AbortController();
  trapFocus(dialog, ac.signal);
  return { dialog, a, b, c, ac };
}

function setupLinear(orientation?: "horizontal" | "vertical") {
  const cells = makeCells(4);
  const ac = new AbortController();
  enableRovingNavigation(container, ".cell", ac.signal, orientation);
  return { cells, ac };
}

const tabindexes = (cells: HTMLElement[]): Array<string | null> =>
  cells.map((c) => c.getAttribute("tabindex"));

function setupGrid(columns?: number) {
  const grid = document.createElement("div");
  container.appendChild(grid);
  const cells = makeCells(10, grid);
  const ac = new AbortController();
  if (columns === undefined) enableRovingNavigation(container, ".cell", ac.signal, "grid");
  else enableRovingNavigation(container, ".cell", ac.signal, "grid", columns);
  return { cells, grid, ac };
}

const tabStops = (): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>(".cell")).filter(
    (c) => c.getAttribute("tabindex") === "0",
  );

describe("applyDialogSemantics labels", () => {
  it("adds no name attribute when none is given", () => {
    const el = document.createElement("div");
    applyDialogSemantics(el);
    expect(el.hasAttribute("aria-label")).toBe(false);
    expect(el.hasAttribute("aria-labelledby")).toBe(false);
    expect(el.getAttribute("role")).toBe("dialog");
  });

  it("uses labelledBy alone when there is no label", () => {
    const el = document.createElement("div");
    applyDialogSemantics(el, { labelledBy: "t" });
    expect(el.getAttribute("aria-labelledby")).toBe("t");
    expect(el.hasAttribute("aria-label")).toBe(false);
  });

  it("keeps an empty label rather than dropping it", () => {
    const el = document.createElement("div");
    applyDialogSemantics(el, { label: "" });
    expect(el.getAttribute("aria-label")).toBe("");
  });
});

describe("trapFocus: what counts as focusable", () => {
  it.each([
    ["a link with href", () => mkEl("a", { href: "#x" })],
    ["a text input", () => mkEl("input")],
    ["a select", () => mkEl("select")],
    ["a textarea", () => mkEl("textarea")],
    ["an element with tabindex 0", () => mkEl("div", { tabindex: "0" })],
    ["an element with a positive tabindex", () => mkEl("span", { tabindex: "3" })],
  ])("treats %s as an edge of the cycle", (_name, make) => {
    const ac = new AbortController();
    const first = mkEl("button");
    const edge = make();
    const dialog = dialogWith(first, edge);
    trapFocus(dialog, ac.signal);
    edge.focus();
    expect(document.activeElement).toBe(edge);
    const e = tab(edge);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    ac.abort();
  });

  it.each([
    ["a disabled button", () => mkEl("button", { disabled: "" })],
    ["a disabled input", () => mkEl("input", { disabled: "" })],
    ["a disabled select", () => mkEl("select", { disabled: "" })],
    ["a disabled textarea", () => mkEl("textarea", { disabled: "" })],
    ["an element with tabindex -1", () => mkEl("div", { tabindex: "-1" })],
    ["an anchor without href", () => mkEl("a")],
    ["a plain div", () => mkEl("div")],
  ])("does not treat %s as a stop", (_name, make) => {
    const ac = new AbortController();
    const first = mkEl("button");
    const last = mkEl("button");
    const dialog = dialogWith(first, last, make());
    trapFocus(dialog, ac.signal);
    last.focus();
    const e = tab(last);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    ac.abort();
  });

  it("skips a control hidden with visibility:hidden", () => {
    const ac = new AbortController();
    const first = mkEl("button");
    const last = mkEl("button");
    const hidden = mkEl("button");
    hidden.style.visibility = "hidden";
    const dialog = dialogWith(first, last, hidden);
    trapFocus(dialog, ac.signal);
    last.focus();
    tab(last);
    expect(document.activeElement).toBe(first);
    first.focus();
    tab(first, true);
    expect(document.activeElement).toBe(last);
    ac.abort();
  });

  it("keeps a control shown with an explicit display value", () => {
    const ac = new AbortController();
    const first = mkEl("button");
    const last = mkEl("button");
    last.style.display = "block";
    const dialog = dialogWith(first, last);
    trapFocus(dialog, ac.signal);
    last.focus();
    tab(last);
    expect(document.activeElement).toBe(first);
    ac.abort();
  });
});

describe("trapFocus: when it steps aside", () => {
  it("ignores keys other than Tab", () => {
    const { c, ac } = pair();
    c.focus();
    const e = press(c, "Enter");
    expect(e.defaultPrevented).toBe(false);
    expect(press(c, "ArrowDown").defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(c);
    ac.abort();
  });

  it("does not wrap Tab from the first or Shift+Tab from the last", () => {
    const { a, c, ac } = pair();
    a.focus();
    expect(tab(a).defaultPrevented).toBe(false);
    c.focus();
    expect(tab(c, true).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(c);
    ac.abort();
  });

  it("does not wrap Tab from the first or Shift+Tab from the middle", () => {
    const { a, b, ac } = pair();
    b.focus();
    expect(tab(b, true).defaultPrevented).toBe(false);
    a.focus();
    expect(tab(a).defaultPrevented).toBe(false);
    ac.abort();
  });

  it("wraps Shift+Tab from the dialog itself to the last control", () => {
    const { dialog, c, ac } = pair();
    dialog.setAttribute("tabindex", "-1");
    dialog.focus();
    const e = tab(dialog, true);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(c);
    ac.abort();
  });

  it("leaves focus that sits outside the dialog alone", () => {
    const { b, ac } = pair();
    const outside = document.createElement("button");
    container.appendChild(outside);
    outside.focus();
    expect(tab(b).defaultPrevented).toBe(false);
    expect(tab(b, true).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(outside);
    ac.abort();
  });

  it("keeps a single control as both edges", () => {
    const dialog = document.createElement("div");
    const only = document.createElement("button");
    dialog.appendChild(only);
    container.appendChild(dialog);
    const ac = new AbortController();
    trapFocus(dialog, ac.signal);
    only.focus();
    expect(tab(only).defaultPrevented).toBe(true);
    expect(tab(only, true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(only);
    ac.abort();
  });

  it("sees controls added after the trap was set up", () => {
    const { dialog, a, c, ac } = pair();
    const added = document.createElement("button");
    dialog.appendChild(added);
    added.focus();
    tab(added);
    expect(document.activeElement).toBe(a);
    c.focus();
    expect(tab(c).defaultPrevented).toBe(false);
    ac.abort();
  });
});

describe("focusDialog details", () => {
  it("puts focus on the first visible control and gives it back on close", () => {
    const opener = document.createElement("button");
    container.appendChild(opener);
    opener.focus();
    const dialog = document.createElement("div");
    const hidden = document.createElement("input");
    hidden.style.visibility = "hidden";
    const link = document.createElement("a");
    link.setAttribute("href", "#x");
    dialog.append(hidden, link);
    container.appendChild(dialog);
    const fallback = vi.fn(() => null);
    const restore = focusDialog(dialog, fallback);
    expect(document.activeElement).toBe(link);
    restore();
    expect(document.activeElement).toBe(opener);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("falls back for an opener that is not an HTML element", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("tabindex", "0");
    container.appendChild(svg);
    svg.focus();
    expect(document.activeElement).toBe(svg);
    const dialog = document.createElement("div");
    dialog.setAttribute("tabindex", "-1");
    container.appendChild(dialog);
    const target = document.createElement("button");
    container.appendChild(target);
    const restore = focusDialog(dialog, () => target);
    restore();
    expect(document.activeElement).toBe(target);
  });

  it("does nothing on close when there is no usable opener or fallback", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("tabindex", "-1");
    container.appendChild(dialog);
    const restoreNone = focusDialog(dialog);
    expect(document.activeElement).toBe(dialog);
    expect(() => restoreNone()).not.toThrow();

    const detached = document.createElement("button");
    const restoreNull = focusDialog(dialog, () => null);
    expect(() => restoreNull()).not.toThrow();
    const restoreDetached = focusDialog(dialog, () => detached);
    restoreDetached();
    expect(document.activeElement).not.toBe(detached);
  });

  it("calls the fallback only when it is needed", () => {
    const opener = document.createElement("button");
    container.appendChild(opener);
    opener.focus();
    const dialog = document.createElement("div");
    dialog.setAttribute("tabindex", "-1");
    container.appendChild(dialog);
    const fallback = vi.fn(() => null);
    const restore = focusDialog(dialog, fallback);
    opener.remove();
    restore();
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});

describe("enableRovingNavigation: horizontal and vertical", () => {
  it("steps with the left and right arrows by default and moves the single Tab stop", () => {
    const { cells, ac } = setupLinear();
    cells[1]!.focus();
    const e = press(cells[1]!, "ArrowRight");
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(cells[2]);
    expect(tabindexes(cells)).toEqual(["-1", "-1", "0", "-1"]);
    press(cells[2]!, "ArrowLeft");
    expect(document.activeElement).toBe(cells[1]);
    expect(tabindexes(cells)).toEqual(["-1", "0", "-1", "-1"]);
    ac.abort();
  });

  it("clamps at both ends and still consumes the key", () => {
    const { cells, ac } = setupLinear("horizontal");
    cells[0]!.focus();
    expect(press(cells[0]!, "ArrowLeft").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(cells[0]);
    cells[3]!.focus();
    expect(press(cells[3]!, "ArrowRight").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(cells[3]);
    expect(tabindexes(cells)).toEqual(["-1", "-1", "-1", "0"]);
    ac.abort();
  });

  it("jumps to the edges with Home and End", () => {
    const { cells, ac } = setupLinear();
    cells[1]!.focus();
    press(cells[1]!, "End");
    expect(document.activeElement).toBe(cells[3]);
    press(cells[3]!, "Home");
    expect(document.activeElement).toBe(cells[0]);
    ac.abort();
  });

  it("ignores the other axis and unrelated keys", () => {
    const { cells, ac } = setupLinear("horizontal");
    cells[1]!.focus();
    for (const k of ["ArrowUp", "ArrowDown", "a", "PageDown", "Tab"]) {
      expect(press(cells[1]!, k).defaultPrevented, k).toBe(false);
    }
    expect(document.activeElement).toBe(cells[1]);
    ac.abort();
  });

  it("uses the up and down arrows when vertical", () => {
    const { cells, ac } = setupLinear("vertical");
    cells[1]!.focus();
    press(cells[1]!, "ArrowDown");
    expect(document.activeElement).toBe(cells[2]);
    press(cells[2]!, "ArrowUp");
    expect(document.activeElement).toBe(cells[1]);
    expect(press(cells[1]!, "ArrowRight").defaultPrevented).toBe(false);
    expect(press(cells[1]!, "ArrowLeft").defaultPrevented).toBe(false);
    press(cells[1]!, "End");
    expect(document.activeElement).toBe(cells[3]);
    press(cells[3]!, "Home");
    expect(document.activeElement).toBe(cells[0]);
    ac.abort();
  });

  it("clamps a vertical list at its ends", () => {
    const { cells, ac } = setupLinear("vertical");
    cells[0]!.focus();
    press(cells[0]!, "ArrowUp");
    expect(document.activeElement).toBe(cells[0]);
    cells[3]!.focus();
    press(cells[3]!, "ArrowDown");
    expect(document.activeElement).toBe(cells[3]);
    ac.abort();
  });

  it("activates the cell through its click handler on Enter and Space", () => {
    const { cells, ac } = setupLinear();
    const clicks = vi.fn();
    cells[2]!.addEventListener("click", clicks);
    expect(press(cells[2]!, "Enter").defaultPrevented).toBe(true);
    expect(press(cells[2]!, " ").defaultPrevented).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(2);
    press(cells[2]!, "Enter", { ctrlKey: true });
    expect(clicks).toHaveBeenCalledTimes(3);
    ac.abort();
  });

  it("leaves a modified arrow, Home and End to the app", () => {
    const { cells, ac } = setupLinear();
    cells[1]!.focus();
    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      for (const k of ["ArrowRight", "ArrowLeft", "Home", "End"]) {
        expect(press(cells[1]!, k, mod).defaultPrevented, `${k} ${Object.keys(mod)[0]}`).toBe(
          false,
        );
      }
    }
    expect(document.activeElement).toBe(cells[1]);
    ac.abort();
  });

  it("ignores keys that do not start on a cell", () => {
    const { cells, ac } = setupLinear();
    const input = document.createElement("input");
    container.appendChild(input);
    input.focus();
    expect(press(input, "ArrowRight").defaultPrevented).toBe(false);
    expect(press(container, "ArrowRight").defaultPrevented).toBe(false);
    const inner = document.createElement("span");
    cells[0]!.appendChild(inner);
    expect(press(inner, "ArrowRight").defaultPrevented).toBe(false);
    expect(press(inner, "Enter").defaultPrevented).toBe(false);
    ac.abort();
  });

  it("finds cells added after it was enabled and stops with its signal", () => {
    const { cells, ac } = setupLinear();
    const [extra] = makeCells(1);
    cells[3]!.focus();
    press(cells[3]!, "ArrowRight");
    expect(document.activeElement).toBe(extra);
    ac.abort();
    extra!.focus();
    expect(press(extra!, "Home").defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(extra);
  });
});

describe("enableRovingNavigation: grid", () => {
  it("steps a row of eight by default", () => {
    const { cells, ac } = setupGrid();
    cells[1]!.focus();
    press(cells[1]!, "ArrowDown");
    expect(document.activeElement).toBe(cells[9]);
    press(cells[9]!, "ArrowUp");
    expect(document.activeElement).toBe(cells[1]);
    ac.abort();
  });

  it("stays put at the top and bottom edge and still consumes the key", () => {
    const { cells, ac } = setupGrid(4);
    cells[1]!.focus();
    expect(press(cells[1]!, "ArrowUp").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(cells[1]);
    cells[9]!.focus();
    expect(press(cells[9]!, "ArrowDown").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(cells[9]);
    cells[8]!.focus();
    press(cells[8]!, "ArrowDown");
    expect(document.activeElement).toBe(cells[8]);
    ac.abort();
  });

  it("clamps left and right across the whole list", () => {
    const { cells, ac } = setupGrid(4);
    cells[0]!.focus();
    press(cells[0]!, "ArrowLeft");
    expect(document.activeElement).toBe(cells[0]);
    cells[9]!.focus();
    press(cells[9]!, "ArrowRight");
    expect(document.activeElement).toBe(cells[9]);
    press(cells[9]!, "ArrowLeft");
    expect(document.activeElement).toBe(cells[8]);
    ac.abort();
  });

  it("jumps to the first and last cell with Home and End, and ignores other keys", () => {
    const { cells, ac } = setupGrid(4);
    cells[5]!.focus();
    press(cells[5]!, "End");
    expect(document.activeElement).toBe(cells[9]);
    press(cells[9]!, "Home");
    expect(document.activeElement).toBe(cells[0]);
    expect(press(cells[0]!, "q").defaultPrevented).toBe(false);
    ac.abort();
  });

  it("leaves a modified arrow to the app", () => {
    const { cells, ac } = setupGrid(4);
    cells[5]!.focus();
    for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
      expect(press(cells[5]!, "ArrowDown", mod).defaultPrevented).toBe(false);
    }
    expect(document.activeElement).toBe(cells[5]);
    ac.abort();
  });
});

describe("setRovingTabindex precedence", () => {
  it("prefers the focused cell over the old Tab stop and the current cell", () => {
    const cs = makeCells(4);
    cs[0]!.setAttribute("tabindex", "0");
    cs[1]!.classList.add("active");
    cs[3]!.focus();
    setRovingTabindex(container, ".cell");
    expect(tabStops()).toEqual([cs[3]]);
    expect(cs.map((c) => c.getAttribute("tabindex"))).toEqual(["-1", "-1", "-1", "0"]);
  });

  it("prefers the old Tab stop over the current cell", () => {
    const cs = makeCells(3);
    cs[2]!.setAttribute("tabindex", "0");
    cs[1]!.classList.add("active");
    setRovingTabindex(container, ".cell");
    expect(tabStops()).toEqual([cs[2]]);
  });

  it("uses an aria-current page cell when nothing else holds the stop", () => {
    const cs = makeCells(3);
    cs[1]!.setAttribute("aria-current", "page");
    setRovingTabindex(container, ".cell");
    expect(tabStops()).toEqual([cs[1]]);
  });

  it("ignores an aria-current value other than page", () => {
    const cs = makeCells(3);
    cs[1]!.setAttribute("aria-current", "true");
    setRovingTabindex(container, ".cell");
    expect(tabStops()).toEqual([cs[0]]);
  });

  it("ignores focus outside the cells and copes with no cells", () => {
    const cs = makeCells(2);
    const outside = document.createElement("button");
    container.appendChild(outside);
    outside.focus();
    setRovingTabindex(container, ".cell");
    expect(tabStops()).toEqual([cs[0]]);
    expect(() => setRovingTabindex(container, ".nothing")).not.toThrow();
    expect(outside.hasAttribute("tabindex")).toBe(false);
  });
});

describe("enableRovingNavigation: container that matches the cell selector", () => {
  it("ignores a key that starts on the container even when it matches the selector", () => {
    container.classList.add("cell");
    const inner = makeCells(2);
    const ac = new AbortController();
    enableRovingNavigation(container, ".cell", ac.signal);
    inner[0]!.focus();
    expect(press(container, "ArrowRight").defaultPrevented).toBe(false);
    expect(press(container, "Enter").defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(inner[0]);
    ac.abort();
    container.classList.remove("cell");
  });
});
