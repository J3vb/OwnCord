/**
 * Classic's rail mount: the slot is placed at once, and the rail's code loads
 * on demand into it unless the page was torn down meanwhile.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MountableComponent } from "@lib/text/safeRender";
import { mountServerRail } from "../../../src/features/server-rail/mountServerRail";
import type { ServerSwitcherDeps } from "../../../src/features/server-rail/switcherOptions";

const loader = vi.hoisted(() => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release: () => release() };
});

const rail = vi.hoisted(() => ({
  mount: vi.fn<(container: Element) => void>(),
  destroy: vi.fn<() => void>(),
}));
const createServerRail = vi.hoisted(() => vi.fn((): MountableComponent => rail));

// The rail's chunk resolves only when a test releases it.
vi.mock(import("../../../src/features/server-rail/ServerRail"), async () => {
  await loader.gate;
  return { createServerRail };
});

function deps(over: Partial<ServerSwitcherDeps> = {}): ServerSwitcherDeps {
  return {
    host: "a.example",
    isTornDown: () => false,
    onOpenDm: vi.fn(),
    onShowServer: vi.fn(),
    own: vi.fn(),
    ...over,
  };
}

async function settle(): Promise<void> {
  await vi.dynamicImportSettled();
  for (let i = 0; i < 3; i++) await Promise.resolve();
}

describe("mountServerRail", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // First, while the chunk is still held back: later imports resolve at once.
  it("mounts nothing and calls own never when the page is torn down while the chunk loads", async () => {
    let tornDown = false;
    const own = vi.fn();
    const app = document.createElement("div");
    const slot = mountServerRail(app, deps({ isTornDown: () => tornDown, own }));
    expect(slot?.parentElement).toBe(app);

    tornDown = true;
    loader.release();
    await settle();

    expect(createServerRail).not.toHaveBeenCalled();
    expect(rail.mount).not.toHaveBeenCalled();
    expect(own).not.toHaveBeenCalled();
  });

  it("places and marks the slot at once, then mounts the rail into it and hands over its teardown", async () => {
    const own = vi.fn<(destroy: () => void) => void>();
    const app = document.createElement("div");
    const slot = mountServerRail(app, deps({ own }));
    expect(app.classList.contains("has-server-rail")).toBe(true);
    expect(app.lastElementChild).toBe(slot);
    expect(slot?.className).toBe("server-rail-slot");

    await settle();

    expect(createServerRail).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ currentHost: "a.example" }),
    );
    expect(rail.mount).toHaveBeenCalledExactlyOnceWith(slot);
    expect(own).toHaveBeenCalledTimes(1);
    own.mock.calls[0]?.[0]();
    expect(rail.destroy).toHaveBeenCalledTimes(1);
  });
});
