import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared mutable state read lazily by the mock factories below.
const h = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  monitors: [] as Array<{
    position: { x: number; y: number };
    size: { width: number; height: number };
  }>,
  monitorsError: null as Error | null,
  setPosition: vi.fn(),
  setSize: vi.fn(),
  maximize: vi.fn(),
}));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    if (cmd === "get_settings") return Promise.resolve(h.settings);
    return Promise.resolve(undefined);
  },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    maximize: h.maximize,
    setPosition: h.setPosition,
    setSize: h.setSize,
    onMoved: vi.fn().mockResolvedValue(() => {}),
    onResized: vi.fn().mockResolvedValue(() => {}),
    outerPosition: vi.fn(),
    outerSize: vi.fn(),
    isMaximized: vi.fn().mockResolvedValue(false),
    isMinimized: vi.fn().mockResolvedValue(false),
  }),
  availableMonitors: () =>
    h.monitorsError !== null ? Promise.reject(h.monitorsError) : Promise.resolve(h.monitors),
  PhysicalPosition: class {
    constructor(
      public x: number,
      public y: number,
    ) {}
  },
  PhysicalSize: class {
    constructor(
      public width: number,
      public height: number,
    ) {}
  },
}));

const PRIMARY = { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } };

function setSaved(state: Record<string, unknown>): void {
  h.settings = { windowState: state };
}

describe("window-state restore validation", () => {
  beforeEach(() => {
    vi.resetModules();
    h.settings = {};
    h.monitors = [PRIMARY];
    h.monitorsError = null;
    h.setPosition.mockClear();
    h.setSize.mockClear();
    h.maximize.mockClear();
  });

  describe("isRectOnScreen", () => {
    it("accepts a rect fully inside a monitor", async () => {
      const { isRectOnScreen } = await import("@lib/window-state");
      expect(
        isRectOnScreen([PRIMARY], { x: 100, y: 100, width: 1280, height: 720, maximized: false }),
      ).toBe(true);
    });

    it("rejects a rect far off-screen", async () => {
      const { isRectOnScreen } = await import("@lib/window-state");
      expect(
        isRectOnScreen([PRIMARY], { x: -5000, y: 100, width: 1280, height: 720, maximized: false }),
      ).toBe(false);
    });

    it("accepts a rect on a secondary monitor left of primary", async () => {
      const secondary = { position: { x: -1920, y: 0 }, size: { width: 1920, height: 1080 } };
      const { isRectOnScreen } = await import("@lib/window-state");
      expect(
        isRectOnScreen([PRIMARY, secondary], {
          x: -1800,
          y: 50,
          width: 1280,
          height: 720,
          maximized: false,
        }),
      ).toBe(true);
    });

    it("rejects a rect whose title bar is below every monitor", async () => {
      const { isRectOnScreen } = await import("@lib/window-state");
      expect(
        isRectOnScreen([PRIMARY], { x: 100, y: 1075, width: 1280, height: 720, maximized: false }),
      ).toBe(false);
    });

    it("rejects a rect with too little horizontal overlap", async () => {
      const { isRectOnScreen } = await import("@lib/window-state");
      // Only 50px of the window remains on-screen at the right edge.
      expect(
        isRectOnScreen([PRIMARY], { x: 1870, y: 100, width: 1280, height: 720, maximized: false }),
      ).toBe(false);
    });
  });

  describe("initWindowState", () => {
    it("restores an on-screen saved position", async () => {
      setSaved({ x: 200, y: 150, width: 1280, height: 720, maximized: false });
      const { initWindowState } = await import("@lib/window-state");
      (await initWindowState())();
      expect(h.setPosition).toHaveBeenCalledTimes(1);
      expect(h.setPosition.mock.calls[0]?.[0]).toMatchObject({ x: 200, y: 150 });
      expect(h.setSize).toHaveBeenCalledTimes(1);
      expect(h.setSize.mock.calls[0]?.[0]).toMatchObject({ width: 1280, height: 720 });
    });

    it("skips restore when the saved position is off-screen", async () => {
      setSaved({ x: -5000, y: -5000, width: 1280, height: 720, maximized: false });
      const { initWindowState } = await import("@lib/window-state");
      (await initWindowState())();
      expect(h.setPosition).not.toHaveBeenCalled();
      expect(h.setSize).not.toHaveBeenCalled();
    });

    it("restores unchecked when availableMonitors fails", async () => {
      setSaved({ x: -5000, y: -5000, width: 1280, height: 720, maximized: false });
      h.monitorsError = new Error("not supported");
      const { initWindowState } = await import("@lib/window-state");
      (await initWindowState())();
      expect(h.setPosition).toHaveBeenCalledTimes(1);
      expect(h.setSize).toHaveBeenCalledTimes(1);
    });

    it("restores unchecked when no monitors are reported", async () => {
      setSaved({ x: 300, y: 300, width: 1280, height: 720, maximized: false });
      h.monitors = [];
      const { initWindowState } = await import("@lib/window-state");
      (await initWindowState())();
      expect(h.setPosition).toHaveBeenCalledTimes(1);
    });

    it("maximizes without querying position when saved maximized", async () => {
      setSaved({ x: -5000, y: -5000, width: 1280, height: 720, maximized: true });
      const { initWindowState } = await import("@lib/window-state");
      (await initWindowState())();
      expect(h.maximize).toHaveBeenCalledTimes(1);
      expect(h.setPosition).not.toHaveBeenCalled();
    });

    it("ignores saved state with non-finite coordinates", async () => {
      setSaved({ x: NaN, y: 100, width: 1280, height: 720, maximized: false });
      const { initWindowState } = await import("@lib/window-state");
      (await initWindowState())();
      expect(h.setPosition).not.toHaveBeenCalled();
      expect(h.maximize).not.toHaveBeenCalled();
    });

    it("ignores saved state with non-positive size", async () => {
      setSaved({ x: 100, y: 100, width: 0, height: 720, maximized: false });
      const { initWindowState } = await import("@lib/window-state");
      (await initWindowState())();
      expect(h.setPosition).not.toHaveBeenCalled();
    });
  });
});
