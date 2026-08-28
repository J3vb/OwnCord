/**
 * Tests for src/lib/updater.ts.
 *
 * Excluded from coverage in vitest.config.ts and only ever `vi.mock`ed by
 * update-notifier.test.ts, so none of it had run under test. It drives the
 * self-update path — a failed check must degrade to "no update" rather than
 * surface an error, and the progress listener must be detached even when the
 * install throws, or a failed update leaves a dangling Tauri event listener.
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

const { checkForUpdate, downloadAndInstallUpdate } = await import("@lib/updater");

const unlisten = vi.fn();

beforeEach(() => {
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

  it("does not subscribe to progress when no callback is given", async () => {
    await downloadAndInstallUpdate("https://s.example");

    expect(listen).not.toHaveBeenCalled();
  });

  it("subscribes to update-progress when a callback is given", async () => {
    await downloadAndInstallUpdate("https://s.example", vi.fn());

    expect(listen).toHaveBeenCalledWith("update-progress", expect.any(Function));
  });

  it("forwards progress events to the callback", async () => {
    const onProgress = vi.fn();
    await downloadAndInstallUpdate("https://s.example", onProgress);

    const handler = listen.mock.calls[0]?.[1] as (e: {
      payload: { received: number; total?: number | null };
    }) => void;
    handler({ payload: { received: 512, total: 2048 } });

    expect(onProgress).toHaveBeenCalledWith({ received: 512, total: 2048 });
  });

  it("normalises a missing total to null", async () => {
    const onProgress = vi.fn();
    await downloadAndInstallUpdate("https://s.example", onProgress);

    const handler = listen.mock.calls[0]?.[1] as (e: {
      payload: { received: number; total?: number | null };
    }) => void;
    // A server that sends no Content-Length yields an undefined total; the UI
    // needs a null it can branch on to show an indeterminate bar.
    handler({ payload: { received: 512 } });

    expect(onProgress).toHaveBeenCalledWith({ received: 512, total: null });
  });

  it("detaches the progress listener after a successful install", async () => {
    await downloadAndInstallUpdate("https://s.example", vi.fn());

    expect(unlisten).toHaveBeenCalled();
  });

  it("detaches the progress listener when the install fails", async () => {
    invoke.mockRejectedValue(new Error("download failed"));

    await expect(downloadAndInstallUpdate("https://s.example", vi.fn())).rejects.toThrow(
      "download failed",
    );

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
});
