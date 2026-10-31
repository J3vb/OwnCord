/**
 * A real call-view video grid with canvas-capture tiles, for the mocked e2e
 * suite, which has no LiveKit track to make a tile with. The grid is mounted
 * through the dev server's module graph over the app, with the call controls
 * wired to a log (`window.__callLog`) so a spec can see which control ran.
 * The production preview serves only the bundle, so `mounted` is false there
 * and the caller skips.
 */
import type { Page } from "@playwright/test";

export interface CallGridTile {
  readonly id: number;
  readonly name: string;
  readonly screenshare?: boolean;
}

export const CALL_GRID_HOST = "#call-grid-host";

/** Mount the grid; false when the module graph is not served. */
export async function mountCallGrid(page: Page, tiles: readonly CallGridTile[]): Promise<boolean> {
  return page.evaluate(
    async ({ moduleUrl, tiles }) => {
      let mod;
      try {
        mod = await import(/* @vite-ignore */ moduleUrl);
      } catch {
        return false;
      }
      const log: string[] = [];
      (window as unknown as { __callLog: string[] }).__callLog = log;
      const host = document.createElement("div");
      host.id = "call-grid-host";
      host.style.cssText = "position:fixed;inset:0;z-index:900;background:#000;display:flex";
      host.innerHTML = "<div style='flex:1;min-height:0;display:flex;flex-direction:column'></div>";
      document.body.appendChild(host);
      const slot = host.firstElementChild as HTMLElement;
      const grid = mod.createVideoGrid();
      grid.mount(slot);
      grid.setCallbacks({
        onExitGrid: () => log.push("chat"),
        callControls: {
          onMuteToggle: () => log.push("mute"),
          onDeafenToggle: () => log.push("deafen"),
          onLeave: () => log.push("leave"),
          onCameraToggle: () => log.push("camera"),
        },
      });
      grid.setCallState({ muted: false, deafened: false, listenOnly: false });
      grid.setExitVisible(true);
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 180;
      const ctx = canvas.getContext("2d")!;
      let n = 0;
      const draw = (): void => {
        ctx.fillStyle = `hsl(${(n++ * 3) % 360} 60% 40%)`;
        ctx.fillRect(0, 0, 320, 180);
        ctx.fillStyle = "#fff";
        ctx.font = "24px sans-serif";
        ctx.fillText("stream", 110, 100);
      };
      draw();
      (window as unknown as { __callGridTimer: number }).__callGridTimer = window.setInterval(
        draw,
        100,
      );
      for (const t of tiles) {
        grid.addStream(t.id, t.name, canvas.captureStream(10), {
          isSelf: false,
          audioUserId: t.id,
          isScreenshare: t.screenshare === true,
        });
      }
      (window as unknown as { __callGrid: unknown }).__callGrid = grid;
      return true;
    },
    { moduleUrl: "/src/components/VideoGrid.ts", tiles },
  );
}

/** The controls the call grid's callbacks have seen, in order. */
export async function callLog(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __callLog: string[] }).__callLog.slice());
}
