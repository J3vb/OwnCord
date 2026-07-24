import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared mutable state read lazily by the mock factories below.
const h = vi.hoisted(() => ({
  monitors: [] as Array<{
    position: { x: number; y: number };
    size: { width: number; height: number };
  }>,
  monitorsError: null as Error | null,
  maximized: false,
  outerPos: { x: 0, y: 0 },
  outerSize: { width: 1280, height: 720 },
  center: vi.fn(),
}));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: () => Promise.resolve(h.maximized),
    outerPosition: () => Promise.resolve(h.outerPos),
    outerSize: () => Promise.resolve(h.outerSize),
    center: h.center,
  }),
  availableMonitors: () =>
    h.monitorsError !== null ? Promise.reject(h.monitorsError) : Promise.resolve(h.monitors),
}));

const PRIMARY = { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } };

describe("window-state restore validation", () => {
  beforeEach(() => {
    vi.resetModules();
    h.monitors = [PRIMARY];
    h.monitorsError = null;
    h.maximized = false;
    h.outerPos = { x: 200, y: 150 };
    h.outerSize = { width: 1280, height: 720 };
    h.center.mockClear();
  });

  describe("isRectOnScreen", () => {
    it("accepts a rect fully inside a monitor", async () => {
      const { isRectOnScreen } = await import("@lib/window-state");
      expect(isRectOnScreen([PRIMARY], { x: 100, y: 100, width: 1280, height: 720 })).toBe(true);
    });

    it("rejects a rect far off-screen", async () => {
      const { isRectOnScreen } = await import("@lib/window-state");
      expect(isRectOnScreen([PRIMARY], { x: -5000, y: 100, width: 1280, height: 720 })).toBe(false);
    });

    it("accepts a rect on a secondary monitor left of primary", async () => {
      const secondary = { position: { x: -1920, y: 0 }, size: { width: 1920, height: 1080 } };
      const { isRectOnScreen } = await import("@lib/window-state");
      expect(
        isRectOnScreen([PRIMARY, secondary], { x: -1800, y: 50, width: 1280, height: 720 }),
      ).toBe(true);
    });

    it("rejects a rect whose title bar is below every monitor", async () => {
      const { isRectOnScreen } = await import("@lib/window-state");
      expect(isRectOnScreen([PRIMARY], { x: 100, y: 1075, width: 1280, height: 720 })).toBe(false);
    });

    it("rejects a rect with too little horizontal overlap", async () => {
      const { isRectOnScreen } = await import("@lib/window-state");
      // Only 50px of the window remains on-screen at the right edge.
      expect(isRectOnScreen([PRIMARY], { x: 1870, y: 100, width: 1280, height: 720 })).toBe(false);
    });
  });

  describe("initWindowState off-screen guard", () => {
    it("re-centers when the restored window is off-screen", async () => {
      h.outerPos = { x: -5000, y: -5000 };
      const { initWindowState } = await import("@lib/window-state");
      await initWindowState();
      expect(h.center).toHaveBeenCalledTimes(1);
    });

    it("does not re-center when the restored window is on-screen", async () => {
      h.outerPos = { x: 200, y: 150 };
      const { initWindowState } = await import("@lib/window-state");
      await initWindowState();
      expect(h.center).not.toHaveBeenCalled();
    });

    it("does not re-center (or query monitors) when maximized", async () => {
      h.maximized = true;
      h.outerPos = { x: -5000, y: -5000 };
      const { initWindowState } = await import("@lib/window-state");
      await initWindowState();
      expect(h.center).not.toHaveBeenCalled();
    });

    it("leaves placement untouched when availableMonitors fails", async () => {
      h.outerPos = { x: -5000, y: -5000 };
      h.monitorsError = new Error("not supported");
      const { initWindowState } = await import("@lib/window-state");
      await initWindowState();
      expect(h.center).not.toHaveBeenCalled();
    });

    it("leaves placement untouched when no monitors are reported", async () => {
      h.outerPos = { x: -5000, y: -5000 };
      h.monitors = [];
      const { initWindowState } = await import("@lib/window-state");
      await initWindowState();
      expect(h.center).not.toHaveBeenCalled();
    });
  });
});
