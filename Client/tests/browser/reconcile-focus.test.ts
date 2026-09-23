import { describe, expect, it } from "vitest";
import { reconcileChildren } from "../../src/lib/reconcile";

// Moving a focused node with insertBefore blurs it in Chromium/WebView2 while
// the node stays connected; jsdom keeps focus, so this has to run here.
describe("reconcileChildren focus in a real browser", () => {
  it("keeps focus on a kept row that moves up the list", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
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
    reconcileChildren(container, ["alice", "bob"], opts);
    const bob = container.children[1] as HTMLElement;
    bob.focus();

    reconcileChildren(container, ["bob", "alice"], opts);

    expect(container.children[0]).toBe(bob);
    expect(document.activeElement).toBe(bob);
    container.remove();
  });
});
