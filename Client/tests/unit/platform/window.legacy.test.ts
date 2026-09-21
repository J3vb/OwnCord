// Legacy binding for the WindowControl suite: the in-place seam in
// `lib/window-state.ts` (`nativeWindow`), bound with no cast. B7-5 re-runs
// `window.suite.ts` against `platform/desktop` once the operations move there.
import { vi } from "vitest";
import type { MonitorRect, WindowControl } from "../../../src/platform/contracts/window";
import { describeWindowControlSuite } from "./window.suite";

const h = vi.hoisted(() => ({
  maximized: false,
  monitors: [] as readonly unknown[],
  monitorsError: null as unknown,
  position: { x: 0, y: 0 },
  size: { width: 0, height: 0 },
  centered: 0,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: () => Promise.resolve(h.maximized),
    outerPosition: () => Promise.resolve(h.position),
    outerSize: () => Promise.resolve(h.size),
    center: () => {
      h.centered++;
      return Promise.resolve();
    },
  }),
  availableMonitors: () =>
    h.monitorsError !== null ? Promise.reject(h.monitorsError) : Promise.resolve(h.monitors),
}));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

describeWindowControlSuite(async () => {
  Object.assign(h, {
    maximized: false,
    monitors: [],
    monitorsError: null,
    position: { x: 0, y: 0 },
    size: { width: 0, height: 0 },
    centered: 0,
  });
  const mod = await import("../../../src/lib/window-state");
  const legacy: WindowControl = mod.nativeWindow;
  return {
    subject: legacy,
    native: {
      maximized(value: boolean) {
        h.maximized = value;
      },
      monitors(value: readonly MonitorRect[]) {
        h.monitors = value;
      },
      monitorsFailWith(error: unknown) {
        h.monitorsError = error;
      },
      placedAt(position, size) {
        h.position = position;
        h.size = size;
      },
      centered: () => h.centered,
    },
  };
});
