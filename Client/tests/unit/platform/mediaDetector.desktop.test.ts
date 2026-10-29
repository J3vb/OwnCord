// Desktop binding for the MediaDetector contract (`detect_media`, WP 8.10b). A
// host failure or an odd answer is "unknown", never a rejection the poll loop
// has to survive.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { mediaDetector } = await import("../../../src/platform/desktop/mediaDetector");

const playing = {
  state: "playing",
  title: "Blue in Green",
  artist: "Miles Davis",
  player: "Spotify",
  playerId: "spotify.exe",
  positionMs: 60_000,
  durationMs: 337_000,
};

describe("mediaDetector (desktop)", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("is available on the desktop build", () => {
    expect(mediaDetector.available).toBe(true);
  });

  it("returns the song detect_media names, passing the hidden players", async () => {
    invoke.mockResolvedValue(playing);
    await expect(mediaDetector.detect({ hidden: ["vlc"] })).resolves.toEqual(playing);
    expect(invoke).toHaveBeenCalledWith("detect_media", { prefs: { hidden: ["vlc"] } });
  });

  it("keeps an empty artist and an unknown length", async () => {
    invoke.mockResolvedValue({ ...playing, artist: "", durationMs: 0 });
    await expect(mediaDetector.detect({ hidden: [] })).resolves.toMatchObject({
      state: "playing",
      artist: "",
      durationMs: 0,
    });
  });

  it("answers none when nothing plays", async () => {
    invoke.mockResolvedValue({ state: "none" });
    await expect(mediaDetector.detect({ hidden: [] })).resolves.toEqual({ state: "none" });
  });

  it("answers unknown when the host says so", async () => {
    invoke.mockResolvedValue({ state: "unknown" });
    await expect(mediaDetector.detect({ hidden: [] })).resolves.toEqual({ state: "unknown" });
  });

  it("answers unknown, not a rejection, when the host call fails", async () => {
    invoke.mockRejectedValue(new Error("no host"));
    await expect(mediaDetector.detect({ hidden: [] })).resolves.toEqual({ state: "unknown" });
  });

  it("answers unknown for a payload that is not a well-formed reading", async () => {
    for (const payload of [
      undefined,
      null,
      "playing",
      {},
      { state: "paused" },
      { ...playing, title: "" },
      { ...playing, title: "  " },
      { ...playing, player: "" },
      { ...playing, artist: 5 },
      { ...playing, playerId: undefined },
      { ...playing, positionMs: "1" },
      { ...playing, positionMs: -1 },
      { ...playing, durationMs: Number.NaN },
      { ...playing, durationMs: Number.POSITIVE_INFINITY },
    ]) {
      invoke.mockResolvedValue(payload);
      await expect(mediaDetector.detect({ hidden: [] })).resolves.toEqual({ state: "unknown" });
    }
  });
});
