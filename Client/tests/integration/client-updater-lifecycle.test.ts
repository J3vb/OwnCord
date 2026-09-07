import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MountableComponent } from "@lib/safe-render";
import type { DownloadProgress } from "@lib/updater";

const { invoke, relaunch, listen, unlisten } = vi.hoisted(() => ({
  invoke: vi.fn(),
  relaunch: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let createUpdateNotifier: typeof import("@components/UpdateNotifier").createUpdateNotifier;
let downloadAndInstallUpdate: typeof import("@lib/updater").downloadAndInstallUpdate;
let host: HTMLElement;
let finishInstall: () => void;
let failInstall: (err: Error) => void;
const notifiers: MountableComponent[] = [];

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  ({ createUpdateNotifier } = await import("@components/UpdateNotifier"));
  ({ downloadAndInstallUpdate } = await import("@lib/updater"));
  host = document.createElement("div");
  document.body.appendChild(host);
  unlisten.mockReset();
  listen.mockReset().mockResolvedValue(unlisten);
  relaunch.mockReset().mockResolvedValue(undefined);
  invoke.mockReset().mockImplementation((command: string) => {
    if (command === "check_client_update") {
      return Promise.resolve({ available: true, version: "1.2.1", body: "" });
    }
    if (command === "download_and_install_update") {
      return new Promise<void>((resolve, reject) => {
        finishInstall = resolve;
        failInstall = reject;
      });
    }
    throw new Error(`Unexpected command ${command}`);
  });
});

afterEach(() => {
  for (const notifier of notifiers) notifier.destroy?.();
  notifiers.length = 0;
  host.remove();
  vi.useRealTimers();
});

function mount(serverUrl: string): MountableComponent {
  const notifier = createUpdateNotifier({ serverUrl });
  notifiers.push(notifier);
  notifier.mount(host);
  return notifier;
}

function emitProgress(received: number, total: number): void {
  const handler = listen.mock.calls.at(-1)?.[1] as (event: { payload: DownloadProgress }) => void;
  handler({ payload: { received, total } });
}

async function startInstall(): Promise<void> {
  (host.querySelector(".update-banner-install") as HTMLButtonElement).click();
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(0);
}

function installCalls(): unknown[][] {
  return invoke.mock.calls.filter(([command]) => command === "download_and_install_update");
}

describe("client update across page changes", () => {
  it("keeps one native installation and transfers progress to a replacement notifier", async () => {
    const first = mount("https://first.example");
    await vi.advanceTimersByTimeAsync(3000);
    await startInstall();
    expect(installCalls()).toHaveLength(1);
    emitProgress(25, 100);
    const oldProgress = host.querySelector(".update-banner-text");

    // Switching servers destroys MainPage's notifier while the native download runs.
    first.destroy?.();
    mount("https://second.example");
    expect(host.querySelector(".update-banner-text")?.textContent).toBe("Downloading update… 25%");
    expect(host.querySelector(".update-banner-install")).toBeNull();
    await vi.advanceTimersByTimeAsync(3000);

    // The service also guards callers that still try to start an installation.
    const joined = downloadAndInstallUpdate("https://second.example");
    await vi.advanceTimersByTimeAsync(0);
    expect(installCalls()).toHaveLength(1);
    expect(listen).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls.filter(([command]) => command === "check_client_update")).toHaveLength(
      1,
    );
    emitProgress(60, 100);
    expect(host.querySelector(".update-banner-text")?.textContent).toBe("Downloading update… 60%");
    expect(oldProgress?.textContent).toBe("Downloading update… 25%");

    finishInstall();
    await joined;
    expect(host.querySelector(".update-banner-text")?.textContent).toBe(
      "Update installed. Restarting…",
    );
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("reports a failed download on the replacement page and lets its Retry start once", async () => {
    const first = mount("https://first.example");
    await vi.advanceTimersByTimeAsync(3000);
    await startInstall();
    first.destroy?.();
    mount("https://second.example");

    failInstall(new Error("download interrupted"));
    await vi.advanceTimersByTimeAsync(0);
    expect(host.querySelector(".update-banner-text")?.textContent).toBe(
      "Update failed. Please try again later.",
    );
    expect(relaunch).not.toHaveBeenCalled();
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".update-banner-install")?.textContent).toBe("Retry");

    await startInstall();
    expect(installCalls()).toHaveLength(2);
    expect(installCalls()[1]).toEqual([
      "download_and_install_update",
      { serverUrl: "https://second.example" },
    ]);
    finishInstall();
    await vi.advanceTimersByTimeAsync(0);
    expect(unlisten).toHaveBeenCalledTimes(2);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });
});
