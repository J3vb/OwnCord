import { describe, it, expect } from "vitest";
import { createNavigationGuard } from "../../src/lib/navigation-guard";

describe("createNavigationGuard", () => {
  it("reports the only navigation as current", () => {
    const guard = createNavigationGuard();
    const isCurrent = guard.begin();
    expect(isCurrent()).toBe(true);
  });

  it("supersedes an earlier navigation when a newer one begins", () => {
    const guard = createNavigationGuard();
    const first = guard.begin();
    const second = guard.begin();

    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it("only the latest of many navigations is current", () => {
    const guard = createNavigationGuard();
    const predicates = [guard.begin(), guard.begin(), guard.begin()];

    expect(predicates.map((p) => p())).toEqual([false, false, true]);
  });

  it("discards a stale async mount: a navigation that awaited across a newer begin() is superseded", async () => {
    const guard = createNavigationGuard();
    const mounted: string[] = [];

    // Simulates renderPage: destroy happens synchronously, mount only after an
    // awaited dynamic import — and only if still the current navigation.
    async function renderPage(pageId: string, importDelay: Promise<void>): Promise<void> {
      const isCurrent = guard.begin();
      await importDelay; // dynamic import boundary
      if (!isCurrent()) return;
      mounted.push(pageId);
    }

    let resolveSlow!: () => void;
    const slowImport = new Promise<void>((resolve) => {
      resolveSlow = resolve;
    });

    const slowRender = renderPage("main", slowImport);
    // A newer navigation begins (and mounts) while the first import is pending.
    await renderPage("connect", Promise.resolve());

    resolveSlow();
    await slowRender;

    expect(mounted).toEqual(["connect"]);
  });

  it("independent guards do not interfere", () => {
    const a = createNavigationGuard();
    const b = createNavigationGuard();
    const aFirst = a.begin();
    b.begin();

    expect(aFirst()).toBe(true);
  });
});
