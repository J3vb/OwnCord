import { describe, it, expect, vi } from "vitest";
import { createRouter } from "../../src/lib/router";
import type { PageId } from "../../src/lib/router";

describe("Router", () => {
  it("starts on the initial page", () => {
    const router = createRouter("connect");
    expect(router.getCurrentPage()).toBe("connect");
  });

  it("navigate changes the current page", () => {
    const router = createRouter("connect");
    router.navigate("main");
    expect(router.getCurrentPage()).toBe("main");
  });

  it("notifies listeners on navigate", () => {
    const router = createRouter("connect");
    const pages: PageId[] = [];
    router.onNavigate((p) => pages.push(p));

    router.navigate("main");
    router.navigate("connect");

    expect(pages).toEqual(["main", "connect"]);
  });

  it("unsubscribe stops notifications", () => {
    const router = createRouter("connect");
    const pages: PageId[] = [];
    const unsub = router.onNavigate((p) => pages.push(p));

    router.navigate("main");
    unsub();
    router.navigate("connect");

    expect(pages).toEqual(["main"]);
  });

  it("does not notify if navigating to same page", () => {
    const router = createRouter("connect");
    const listener = vi.fn();
    router.onNavigate(listener);

    router.navigate("connect"); // same page
    expect(listener).not.toHaveBeenCalled();
  });
});
