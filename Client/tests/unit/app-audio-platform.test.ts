// The Windows per-app share audio host wrappers (src/platform/desktop/appAudio.ts):
// every invoke result and rejection becomes a typed result, never a throw.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) as unknown }));

const { appAudioAvailable, startAppAudio, stopAppAudio, appAudio } =
  await import("../../src/platform/desktop/appAudio");

beforeEach(() => invoke.mockReset());

describe("appAudioAvailable", () => {
  it("passes the host's answer through", async () => {
    invoke.mockResolvedValueOnce(true);
    expect(await appAudioAvailable()).toBe(true);
    invoke.mockResolvedValueOnce(false);
    expect(await appAudioAvailable()).toBe(false);
    expect(invoke).toHaveBeenCalledWith("app_audio_available");
  });

  it("is false without a host (web, or a failing call)", async () => {
    invoke.mockRejectedValueOnce(new Error("no Tauri"));
    expect(await appAudioAvailable()).toBe(false);
  });
});

describe("startAppAudio", () => {
  it("returns the socket url", async () => {
    invoke.mockResolvedValueOnce({ url: "ws://127.0.0.1:5/tok/app-audio" });
    expect(await startAppAudio("Notepad", "window")).toEqual({
      ok: true,
      url: "ws://127.0.0.1:5/tok/app-audio",
    });
    expect(invoke).toHaveBeenCalledWith("start_app_audio", { label: "Notepad", surface: "window" });
  });

  it.each([
    "unavailable",
    "not_window",
    "own_window",
    "ancestor",
    "not_found",
    "ambiguous",
    "activation_failed",
    "superseded",
    "internal",
  ])("maps the host refusal %s to its code", async (code) => {
    invoke.mockRejectedValueOnce(code);
    expect(await startAppAudio("x", "window")).toEqual({ ok: false, code });
  });

  it("maps an unknown rejection (no host, a thrown Error) to unavailable", async () => {
    invoke.mockRejectedValueOnce(new Error("no Tauri"));
    expect(await startAppAudio("x", "window")).toEqual({ ok: false, code: "unavailable" });
    invoke.mockRejectedValueOnce("something new");
    expect(await startAppAudio("x", "window")).toEqual({ ok: false, code: "unavailable" });
  });

  it("treats an answer without a url as an internal fault", async () => {
    invoke.mockResolvedValueOnce({});
    expect(await startAppAudio("x", "window")).toEqual({ ok: false, code: "internal" });
    invoke.mockResolvedValueOnce(null);
    expect(await startAppAudio("x", "window")).toEqual({ ok: false, code: "internal" });
  });
});

describe("stopAppAudio", () => {
  it("calls the host and swallows a failure", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await expect(stopAppAudio()).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("stop_app_audio");
    invoke.mockRejectedValueOnce(new Error("gone"));
    await expect(stopAppAudio()).resolves.toBeUndefined();
  });
});

describe("the platform member", () => {
  it("exposes the three wrappers", () => {
    expect(appAudio.available).toBe(appAudioAvailable);
    expect(appAudio.start).toBe(startAppAudio);
    expect(appAudio.stop).toBe(stopAppAudio);
  });
});
