/**
 * Tests for src/lib/updater.ts.
 *
 * Shared install ownership survives page changes. Failed downloads can be
 * retried; successful native installations remain guarded through relaunch.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const relaunch = vi.fn();
const listen = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args) as unknown,
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: (...args: unknown[]) => relaunch(...args) as unknown,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listen(...args) as unknown,
}));

let checkForUpdate: typeof import("@lib/updater").checkForUpdate;
let downloadAndInstallUpdate: typeof import("@lib/updater").downloadAndInstallUpdate;
let subscribeToUpdateInstall: typeof import("@lib/updater").subscribeToUpdateInstall;

const unlisten = vi.fn();

beforeEach(async () => {
  vi.resetModules();
  ({ checkForUpdate, downloadAndInstallUpdate, subscribeToUpdateInstall } =
    await import("@lib/updater"));
  invoke.mockReset().mockResolvedValue(undefined);
  relaunch.mockReset().mockResolvedValue(undefined);
  unlisten.mockReset();
  listen.mockReset().mockResolvedValue(unlisten);
});

// ── checkForUpdate ─────────────────────────────────────────────────────────

describe("checkForUpdate", () => {
  it("returns the backend result when an update is available", async () => {
    invoke.mockResolvedValue({ available: true, version: "1.2.3", body: "notes" });

    await expect(checkForUpdate("https://s.example")).resolves.toEqual({
      available: true,
      version: "1.2.3",
      body: "notes",
    });
    expect(invoke).toHaveBeenCalledWith("check_client_update", {
      serverUrl: "https://s.example",
    });
  });

  it("returns the backend result when no update is available", async () => {
    invoke.mockResolvedValue({ available: false, version: null, body: null });

    await expect(checkForUpdate("https://s.example")).resolves.toEqual({
      available: false,
      version: null,
      body: null,
    });
  });

  it("degrades to 'no update' when the check fails", async () => {
    invoke.mockRejectedValue(new Error("server unreachable"));

    // An unreachable or older server must not break the client — it just means
    // there is no update to offer.
    await expect(checkForUpdate("https://s.example")).resolves.toEqual({
      available: false,
      version: null,
      body: null,
    });
  });
});

// ── downloadAndInstallUpdate ───────────────────────────────────────────────

describe("downloadAndInstallUpdate", () => {
  it("installs and relaunches", async () => {
    await downloadAndInstallUpdate("https://s.example");

    expect(invoke).toHaveBeenCalledWith("download_and_install_update", {
      serverUrl: "https://s.example",
    });
    expect(relaunch).toHaveBeenCalled();
  });

  it("subscribes to progress even before a replacement page joins the install", async () => {
    await downloadAndInstallUpdate("https://s.example");

    expect(listen).toHaveBeenCalledWith("update-progress", expect.any(Function));
  });

  it("forwards progress events to subscribers and remembers it for new subscribers", async () => {
    const onState = vi.fn();
    const unsubscribe = subscribeToUpdateInstall(onState);
    let finish!: () => void;
    invoke.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const installation = downloadAndInstallUpdate("https://s.example");
    await vi.dynamicImportSettled();

    const handler = listen.mock.calls[0]?.[1] as (e: {
      payload: { received: number; total?: number | null };
    }) => void;
    handler({ payload: { received: 512, total: 2048 } });

    const progressState = { status: "downloading", progress: { received: 512, total: 2048 } };
    expect(onState).toHaveBeenLastCalledWith(progressState);
    const remounted = vi.fn();
    const unsubscribeRemounted = subscribeToUpdateInstall(remounted);
    expect(remounted).toHaveBeenCalledExactlyOnceWith(progressState);

    unsubscribe();
    onState.mockClear();
    handler({ payload: { received: 1024, total: 2048 } });
    expect(onState).not.toHaveBeenCalled();
    expect(remounted).toHaveBeenLastCalledWith({
      status: "downloading",
      progress: { received: 1024, total: 2048 },
    });
    unsubscribeRemounted();
    finish();
    await installation;
  });

  it("normalises a missing total to null", async () => {
    const onState = vi.fn();
    const unsubscribe = subscribeToUpdateInstall(onState);
    let finish!: () => void;
    invoke.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const installation = downloadAndInstallUpdate("https://s.example");
    await vi.dynamicImportSettled();

    const handler = listen.mock.calls[0]?.[1] as (e: {
      payload: { received: number; total?: number | null };
    }) => void;
    // A server that sends no Content-Length yields an undefined total; the UI
    // needs a null it can branch on to show an indeterminate bar.
    handler({ payload: { received: 512 } });

    expect(onState).toHaveBeenLastCalledWith({
      status: "downloading",
      progress: { received: 512, total: null },
    });
    unsubscribe();
    finish();
    await installation;
  });

  it("detaches the progress listener after a successful install", async () => {
    await downloadAndInstallUpdate("https://s.example");

    expect(unlisten).toHaveBeenCalled();
  });

  it("detaches the progress listener when the install fails", async () => {
    invoke.mockRejectedValue(new Error("download failed"));

    await expect(downloadAndInstallUpdate("https://s.example")).rejects.toThrow("download failed");

    // The finally block is what stops a failed update from leaking a listener
    // that keeps firing into a dead progress bar on the next attempt.
    expect(unlisten).toHaveBeenCalled();
  });

  it("does not relaunch when the install fails", async () => {
    invoke.mockRejectedValue(new Error("download failed"));

    await expect(downloadAndInstallUpdate("https://s.example")).rejects.toThrow("download failed");

    expect(relaunch).not.toHaveBeenCalled();
  });

  it("propagates a relaunch failure", async () => {
    relaunch.mockRejectedValue(new Error("relaunch blocked"));

    await expect(downloadAndInstallUpdate("https://s.example")).rejects.toThrow("relaunch blocked");
  });

  it("reserves the operation before progress-listener registration finishes", async () => {
    let register!: (cleanup: () => void) => void;
    listen.mockReturnValue(
      new Promise<() => void>((resolve) => {
        register = resolve;
      }),
    );
    const first = downloadAndInstallUpdate("https://first.example");
    const second = downloadAndInstallUpdate("https://second.example");
    expect(second).toBe(first);
    await vi.dynamicImportSettled();
    expect(listen).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();

    register(unlisten);
    await Promise.all([first, second]);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("download_and_install_update", {
      serverUrl: "https://first.example",
    });
    expect(relaunch).toHaveBeenCalledTimes(1);
    expect(downloadAndInstallUpdate("https://third.example")).toBe(first);
  });

  it("keeps one installation while relaunch is pending", async () => {
    let finishRelaunch!: () => void;
    relaunch.mockReturnValue(
      new Promise<void>((resolve) => {
        finishRelaunch = resolve;
      }),
    );
    const state = vi.fn();
    const unsubscribe = subscribeToUpdateInstall(state);
    const first = downloadAndInstallUpdate("https://first.example");
    await vi.dynamicImportSettled();
    expect(state).toHaveBeenLastCalledWith({ status: "restarting" });
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(downloadAndInstallUpdate("https://second.example")).toBe(first);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
    finishRelaunch();
    await first;
    unsubscribe();
  });

  it("allows a new installation after a native failure", async () => {
    invoke.mockRejectedValueOnce(new Error("download failed"));
    const state = vi.fn();
    const unsubscribe = subscribeToUpdateInstall(state);
    await expect(downloadAndInstallUpdate("https://s.example")).rejects.toThrow("download failed");
    expect(state).toHaveBeenLastCalledWith({ status: "failed", restartRequired: false });
    expect(relaunch).not.toHaveBeenCalled();

    await downloadAndInstallUpdate("https://s.example");
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(listen).toHaveBeenCalledTimes(2);
    expect(unlisten).toHaveBeenCalledTimes(2);
    expect(relaunch).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("allows a retry when progress-listener registration fails", async () => {
    listen.mockRejectedValueOnce(new Error("events unavailable"));
    await expect(downloadAndInstallUpdate("https://s.example")).rejects.toThrow(
      "events unavailable",
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
    await downloadAndInstallUpdate("https://s.example");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("requires a manual restart after relaunch fails instead of reinstalling", async () => {
    relaunch.mockRejectedValue(new Error("relaunch blocked"));
    const state = vi.fn();
    const unsubscribe = subscribeToUpdateInstall(state);
    const first = downloadAndInstallUpdate("https://s.example");
    await expect(first).rejects.toThrow("relaunch blocked");
    expect(state).toHaveBeenLastCalledWith({ status: "failed", restartRequired: true });
    const second = downloadAndInstallUpdate("https://s.example");
    expect(second).toBe(first);
    await expect(second).rejects.toThrow("relaunch blocked");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("isolates observer failures from installation and relaunch", async () => {
    const unsubscribeBroken = subscribeToUpdateInstall(() => {
      throw new Error("view destroyed");
    });
    const observer = vi.fn();
    const unsubscribe = subscribeToUpdateInstall(observer);
    await expect(downloadAndInstallUpdate("https://s.example")).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenLastCalledWith({ status: "restarting" });
    unsubscribeBroken();
    unsubscribe();
  });
});
