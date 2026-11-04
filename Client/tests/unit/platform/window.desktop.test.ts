// Desktop binding for the WindowControl suite: `platform/desktop`'s window
// operations. B7-5 ran the same suite file against the in-place seam in
// `lib/prefs/windowState.ts` first (proving it could fail and pinning today's
// behaviour), then re-bound it here. The legacy binding is deleted with this
// commit: its export is gone.
import { vi } from "vitest";
import type { MonitorRect, WindowControl } from "../../../src/platform/contracts/window";
import { describeWindowControlSuite } from "./window.suite";
import * as lm from "../../helpers/loggerMock";

const h = vi.hoisted(() => ({
  maximized: false,
  monitors: [] as readonly unknown[],
  monitorsError: null as unknown,
  position: { x: 0, y: 0 },
  size: { width: 0, height: 0 },
  centered: 0,
  fullscreen: [] as boolean[],
  labelledFullscreen: [] as [string, boolean][],
  zooms: [] as number[],
  zoomError: null as unknown,
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
    setFullscreen: (on: boolean) => {
      h.fullscreen.push(on);
      return Promise.resolve();
    },
  }),
  Window: {
    getByLabel: (label: string) =>
      Promise.resolve({
        setFullscreen: (on: boolean) => {
          h.labelledFullscreen.push([label, on]);
          return Promise.resolve();
        },
      }),
  },
  availableMonitors: () =>
    h.monitorsError !== null ? Promise.reject(h.monitorsError) : Promise.resolve(h.monitors),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    setZoom: (scale: number) => {
      if (h.zoomError !== null) return Promise.reject(h.zoomError);
      h.zooms.push(scale);
      return Promise.resolve();
    },
  }),
}));
vi.mock("@lib/logger", () => lm.loggerMock());

describeWindowControlSuite(async () => {
  Object.assign(h, {
    maximized: false,
    monitors: [],
    monitorsError: null,
    position: { x: 0, y: 0 },
    size: { width: 0, height: 0 },
    centered: 0,
    fullscreen: [],
    labelledFullscreen: [],
    zooms: [],
    zoomError: null,
  });
  const mod = await import("../../../src/platform/desktop/window");
  const desktopBinding: WindowControl = mod.windowControl;
  return {
    subject: desktopBinding,
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
      fullscreenCalls: () => h.fullscreen,
      labelledFullscreenCalls: () => h.labelledFullscreen,
      zoomCalls: () => h.zooms,
      zoomFailWith(error: unknown) {
        h.zoomError = error;
      },
    },
  };
});
