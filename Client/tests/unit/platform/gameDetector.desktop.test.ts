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

  it("accepts the launcher sources the host names", async () => {
    for (const source of ["epic", "gog", "battlenet", "lutris", "list", "manual"]) {
      invoke.mockResolvedValue({ name: "Diablo IV", source, startedAtMs: 1 });
      await expect(gameDetector.detect()).resolves.toEqual({
        name: "Diablo IV",
        source,
        startedAtMs: 1,
      });
    }
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
      { name: "Factorio", source: "origin", startedAtMs: 1 },
      { name: "Factorio", source: "steam", startedAtMs: "1" },
      { name: "Factorio", source: "steam", startedAtMs: Number.NaN },
    ]) {
      invoke.mockResolvedValue(payload);
      await expect(gameDetector.detect()).resolves.toBeNull();
    }
  });

  it("hands the user's choices to detect_game, and nothing when there are none", async () => {
    invoke.mockResolvedValue(null);
    const prefs = { manual: [{ path: "C:\\g\\a.exe", name: "A" }], hidden: ["Hades"] };
    await gameDetector.detect(prefs);
    expect(invoke).toHaveBeenCalledWith("detect_game", { prefs });
  });

  it("accepts a manual game from the host", async () => {
    invoke.mockResolvedValue({ name: "Mine", source: "manual", startedAtMs: 5 });
    await expect(gameDetector.detect()).resolves.toEqual({
      name: "Mine",
      source: "manual",
      startedAtMs: 5,
    });
  });

  it("lists the running programs, keeping only well-formed ones", async () => {
    invoke.mockResolvedValue([
      { name: "Factorio", path: "/g/factorio" },
      { name: "", path: "/x" },
      { name: "NoPath" },
      { name: "Spaces", path: "  " },
      null,
      "x",
      { name: 4, path: "/y" },
    ]);
    await expect(gameDetector.listRunningPrograms()).resolves.toEqual([
      { name: "Factorio", path: "/g/factorio" },
    ]);
    expect(invoke).toHaveBeenCalledWith("list_running_programs");
  });

  it("lists nothing, not a rejection, when the host call fails or answers oddly", async () => {
    invoke.mockRejectedValue(new Error("no host"));
    await expect(gameDetector.listRunningPrograms()).resolves.toEqual([]);
    invoke.mockResolvedValue({ not: "an array" });
    await expect(gameDetector.listRunningPrograms()).resolves.toEqual([]);
  });
});
