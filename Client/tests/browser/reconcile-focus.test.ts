import { describe, expect, it } from "vitest";
import { reconcileChildren } from "../../src/lib/net/reconcile";

// Moving a focused node with insertBefore blurs it in Chromium/WebView2 while
// the node stays connected; jsdom keeps focus, so this has to run here.
const opts = {
  key: (name: string) => name,
  signature: (name: string) => name,
  create: (name: string) => {
    const row = document.createElement("div");
    row.tabIndex = -1;
    row.textContent = name;
    return row;
  },
};

describe("reconcileChildren focus in a real browser", () => {
  it("keeps focus on a kept row that moves up the list", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    reconcileChildren(container, ["alice", "bob"], opts);
    const bob = container.children[1] as HTMLElement;
    bob.focus();

    reconcileChildren(container, ["bob", "alice"], opts);

    expect(container.children[0]).toBe(bob);
    expect(document.activeElement).toBe(bob);
    container.remove();
  });

  it("a focused row stays focused when a row above it moves to the end", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    reconcileChildren(container, ["a", "b", "c", "d"], opts);
    const c = container.children[2] as HTMLElement;
    c.focus();

    reconcileChildren(container, ["b", "c", "d", "a"], opts);

    expect(container.children[1]).toBe(c);
    expect(document.activeElement).toBe(c);
    container.remove();
  });

  it("a focused row that itself moves down keeps focus", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    reconcileChildren(container, ["a", "b", "c", "d"], opts);
    const a = container.children[0] as HTMLElement;
    a.focus();

    reconcileChildren(container, ["b", "c", "d", "a"], opts);

    expect(container.children[3]).toBe(a);
    expect(document.activeElement).toBe(a);
    container.remove();
  });
});
