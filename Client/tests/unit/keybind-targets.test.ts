import { afterEach, describe, expect, it } from "vitest";
import { isIdleTarget } from "../../src/features/settings/keybindTargets";

describe("isIdleTarget", () => {
  afterEach(() => document.body.replaceChildren());

  const within = (html: string): Element => {
    document.body.innerHTML = html;
    return document.body.querySelector("#t")!;
  };

  it("counts the page and a plain element as idle", () => {
    expect(isIdleTarget(document.body)).toBe(true);
    expect(isIdleTarget(within('<div id="t" tabindex="0"></div>'))).toBe(true);
  });

  it("keeps typed keys on a tree item, so its type-ahead is not taken by the message box", () => {
    expect(isIdleTarget(within('<div role="treeitem" id="t" tabindex="0"></div>'))).toBe(false);
    expect(isIdleTarget(within('<div role="treeitem"><span id="t">x</span></div>'))).toBe(false);
  });

  it("keeps typed keys on controls that take their own", () => {
    for (const html of [
      '<button id="t"></button>',
      '<input id="t">',
      '<div role="menuitem" id="t"></div>',
    ]) {
      expect(isIdleTarget(within(html))).toBe(false);
    }
  });
});
