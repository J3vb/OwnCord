// Desktop binding for the GameDetector contract (`detect_game`, WP 8.3b). A
// host failure or an odd answer is "no game", never a rejection the poll loop
// has to survive.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { gameDetector } = await import("../../../src/platform/desktop/gameDetector");

describe("gameDetector (desktop)", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("is available on the desktop build", () => {
    expect(gameDetector.available).toBe(true);
  });

  it("returns the game detect_game names", async () => {
    invoke.mockResolvedValue({ name: "Factorio", source: "steam", startedAtMs: 1761206400000 });
    await expect(gameDetector.detect()).resolves.toEqual({
      name: "Factorio",
      source: "steam",
      startedAtMs: 1761206400000,
    });
    expect(invoke).toHaveBeenCalledWith("detect_game");
  });

  it("answers null when nothing is running", async () => {
    invoke.mockResolvedValue(null);
    await expect(gameDetector.detect()).resolves.toBeNull();
  });

  it("answers null, not a rejection, when the host call fails", async () => {
    invoke.mockRejectedValue(new Error("no host"));
    await expect(gameDetector.detect()).resolves.toBeNull();
  });

  it("answers null for a payload that is not a well-formed game", async () => {
    for (const payload of [
      undefined,
      "Factorio",
      {},
      { name: "", source: "steam", startedAtMs: 1 },
      { name: "  ", source: "steam", startedAtMs: 1 },
      { name: "Factorio", source: "gog", startedAtMs: 1 },
      { name: "Factorio", source: "steam", startedAtMs: "1" },
      { name: "Factorio", source: "steam", startedAtMs: Number.NaN },
    ]) {
      invoke.mockResolvedValue(payload);
      await expect(gameDetector.detect()).resolves.toBeNull();
    }
  });
});
