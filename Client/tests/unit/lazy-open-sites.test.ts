/**
 * Screens that load on first use (O-6a): a second trigger while the code loads
 * opens once, a teardown before it resolves mounts nothing, and a failed load
 * shows the generic toast and tries again on the next try.
 *
 * The loaders cache a loaded module (as the module system does), so each screen
 * is exercised by one test that drives its whole first-use sequence through a
 * gate the mocked module waits on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { expectConsole } from "../helpers/console";

const h = vi.hoisted(() => {
  const gates = {
    quick: { wait: Promise.resolve(), release: (): void => undefined },
    search: { wait: Promise.resolve(), release: (): void => undefined },
  };
  for (const g of Object.values(gates)) {
    g.wait = new Promise<void>((resolve) => {
      g.release = resolve;
    });
  }
  return {
    gates,
    searchFails: { value: true },
    mount: vi.fn(),
    destroy: vi.fn(),
    createQuickSwitcher: vi.fn(),
    createSearchOverlay: vi.fn(),
    showToast: vi.fn(),
  };
});

vi.mock("@components/QuickSwitcher", async () => {
  await h.gates.quick.wait;
  return { createQuickSwitcher: h.createQuickSwitcher };
});
vi.mock("@components/SearchOverlay", async () => {
  await h.gates.search.wait;
  // The first import fails once the gate opens; vitest evaluates the factory
  // again on the next import because a throw is not cached.
  if (h.searchFails.value) {
    h.searchFails.value = false;
    throw new Error("chunk load failed");
  }
  return { createSearchOverlay: h.createSearchOverlay };
});
vi.mock("@lib/ui/toast", () => ({ showToast: h.showToast }));

import {
  createQuickSwitcherManager,
  createSearchOverlayController,
} from "../../src/pages/main-page/OverlayManagers";
import { shellText } from "../../src/i18n/shell";

const ctrlK = (): void => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
};

let root: HTMLDivElement;
beforeEach(() => {
  root = document.createElement("div");
  document.body.appendChild(root);
  h.mount.mockClear();
  h.destroy.mockClear();
  h.createQuickSwitcher.mockReset().mockReturnValue({ mount: h.mount, destroy: h.destroy });
  h.createSearchOverlay.mockReset().mockReturnValue({ mount: h.mount, destroy: h.destroy });
  h.showToast.mockClear();
});
afterEach(() => root.remove());

describe("search overlay loads on first use", () => {
  it("a failed first load toasts once and mounts nothing, then the next open tries again", async () => {
    const c = createSearchOverlayController({
      api: { search: vi.fn() } as never,
      getRoot: () => root,
      getCurrentChannelId: () => 1,
    });
    // Two opens while the code is still loading.
    c.open();
    c.open();
    h.gates.search.release();
    await vi.waitFor(() => {
      expect(h.showToast).toHaveBeenCalledWith(shellText("common.openFailed"), "error");
    });
    expectConsole("error", /Failed to load search-overlay/);
    expect(h.showToast).toHaveBeenCalledTimes(1);
    expect(h.createSearchOverlay).not.toHaveBeenCalled();

    // Not stuck pending: the next open loads again and mounts once, however
    // many times it is triggered.
    c.open();
    c.open();
    await vi.waitFor(() => {
      expect(h.createSearchOverlay).toHaveBeenCalledOnce();
    });
    expect(h.mount).toHaveBeenCalledOnce();
    c.cleanup();
  });
});

describe("search overlay cleanup during the load", () => {
  it("mounts nothing when cleanup runs before the code arrives", async () => {
    h.gates.search.release();
    const c = createSearchOverlayController({
      api: { search: vi.fn() } as never,
      getRoot: () => root,
      getCurrentChannelId: () => 1,
    });
    c.open();
    c.open(); // ignored while pending
    c.cleanup();
    await vi.dynamicImportSettled();
    expect(h.createSearchOverlay).not.toHaveBeenCalled();
  });
});

describe("quick switcher loads on first use", () => {
  it("opens once for a repeated Ctrl+K, and a detach before the code arrives mounts nothing", async () => {
    let live: HTMLDivElement | null = root;
    const detachA = createQuickSwitcherManager(() => live).attach();
    ctrlK();
    ctrlK(); // swallowed while loading: opens once, not twice and not a toggle
    detachA(); // teardown before the code arrives cancels the mount
    h.gates.quick.release();
    await vi.dynamicImportSettled();
    expect(h.createQuickSwitcher).not.toHaveBeenCalled();

    // A page root that is gone when the code arrives mounts nothing either.
    // (The module is loaded now, so this resolves on a microtask.)
    const detachB = createQuickSwitcherManager(() => live).attach();
    ctrlK();
    live = null;
    await vi.dynamicImportSettled();
    expect(h.createQuickSwitcher).not.toHaveBeenCalled();
    detachB();

    live = root;
    const detachC = createQuickSwitcherManager(() => live).attach();
    ctrlK();
    ctrlK();
    await vi.waitFor(() => {
      expect(h.createQuickSwitcher).toHaveBeenCalledOnce();
    });
    expect(h.mount).toHaveBeenCalledOnce();
    detachC();
  });

  it("Settings or a dialog opening during the load stops the switcher mounting", async () => {
    h.gates.quick.release();
    let suspended = false;
    const detach = createQuickSwitcherManager(
      () => root,
      () => suspended,
    ).attach();

    ctrlK();
    suspended = true; // e.g. Settings opened while the code loaded
    await vi.dynamicImportSettled();
    expect(h.createQuickSwitcher).not.toHaveBeenCalled();

    suspended = false;
    ctrlK();
    const modal = document.createElement("div");
    modal.className = "modal-overlay visible";
    document.body.appendChild(modal);
    await vi.dynamicImportSettled();
    expect(h.createQuickSwitcher).not.toHaveBeenCalled();
    modal.remove();
    detach();
  });
});
