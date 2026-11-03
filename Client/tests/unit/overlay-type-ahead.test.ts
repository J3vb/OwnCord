/**
 * Keys typed while the quick switcher or the search overlay is still loading
 * reach the overlay's input, never the message box, and a cancelled open drops
 * them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => {
  // One gate per screen: its module resolves when the test opens the gate.
  const deferred = (): { promise: Promise<void>; resolve: () => void } => {
    let resolve = (): void => undefined;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  };
  const quick = deferred();
  const search = deferred();
  const fakeOverlay = (testId: string) => () => {
    let input: HTMLInputElement | null = null;
    return {
      mount(root: HTMLElement): void {
        input = Object.assign(document.createElement("input"), { type: "text" });
        input.dataset.testid = testId;
        root.appendChild(input);
        requestAnimationFrame(() => input?.focus());
      },
      destroy: (): void => input?.remove(),
    };
  };
  return { quick, search, fakeOverlay };
});

vi.mock("@components/QuickSwitcher", () =>
  h.quick.promise.then(() => ({ createQuickSwitcher: h.fakeOverlay("qs-input") })),
);
vi.mock("@components/SearchOverlay", () =>
  h.search.promise.then(() => ({ createSearchOverlay: h.fakeOverlay("search-input") })),
);

import {
  createQuickSwitcherManager,
  createSearchOverlayController,
} from "../../src/pages/main-page/OverlayManagers";

function type(text: string): void {
  for (const key of text) {
    const target = document.activeElement ?? document.body;
    const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    target.dispatchEvent(e);
    if (!e.defaultPrevented && target instanceof HTMLTextAreaElement) target.value += key;
  }
}

const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await frame();
}

let root: HTMLDivElement;
let composer: HTMLTextAreaElement;
beforeEach(() => {
  root = document.createElement("div");
  composer = document.createElement("textarea");
  document.body.append(root, composer);
});
afterEach(() => {
  document.body.replaceChildren();
});

describe("type-ahead while an overlay loads", () => {
  it("Ctrl+K from the message box: a cancelled open drops the keys, the next open hands them to the switcher", async () => {
    const qs = createQuickSwitcherManager(() => root);
    const detach = qs.attach();
    composer.focus();

    const ctrlK = (): void => {
      composer.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }),
      );
    };
    ctrlK();
    type("xy");
    detach();
    expect(composer.value).toBe("");

    const detach2 = qs.attach();
    composer.focus();
    ctrlK();
    type("ra");
    h.quick.resolve();
    await settle();
    type("ndom");
    const input = root.querySelector<HTMLInputElement>("[data-testid='qs-input']");
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(input?.value).toBe("ra");
    expect(composer.value).toBe("");
    detach2();
  });

  it("search opened by a typed key keeps that key and the ones after it", async () => {
    const c = createSearchOverlayController({
      api: { search: vi.fn() } as never,
      getRoot: () => root,
      getCurrentChannelId: () => 1,
    });
    c.open("h");
    type("ello");
    h.search.resolve();
    await settle();
    const input = root.querySelector<HTMLInputElement>("[data-testid='search-input']");
    expect(input?.value).toBe("hello");
    expect(composer.value).toBe("");
    c.cleanup();
  });
});
