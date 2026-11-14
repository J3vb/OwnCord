// The music picker: app order, and the choice it resolves with.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listApps: vi.fn() }));
vi.mock("../../platform/desktop", () => ({
  desktop: { musicAudio: { listApps: mocks.listApps } },
}));

import { showMusicPicker, sortAudioApps } from "./MusicPicker";

const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid='${id}']`);
const app = (id: string, name: string, playing: boolean) => ({ id, name, icon: null, playing });

describe("sortAudioApps", () => {
  it("puts playing apps first, then orders by name", () => {
    const sorted = sortAudioApps([
      app("1", "zeta", false),
      app("2", "Beta", true),
      app("3", "alpha", false),
    ]);
    expect(sorted.map((a) => a.id)).toEqual(["2", "3", "1"]);
  });
});

describe("showMusicPicker", () => {
  beforeEach(() => {
    mocks.listApps.mockReset();
  });
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("lists the apps and resolves with the chosen one on Share", async () => {
    mocks.listApps.mockResolvedValue({ ok: true, apps: [app("1", "Player", true)] });
    const result = showMusicPicker();
    await vi.waitFor(() => expect(document.querySelector("[role='radio']")).not.toBeNull());
    (document.querySelector("[role='radio']") as HTMLElement).click();
    byId("music-picker-share")!.click();
    expect(await result).toMatchObject({ id: "1" });
  });

  it("resolves null when the dialog is closed with no choice", async () => {
    mocks.listApps.mockResolvedValue({ ok: true, apps: [app("1", "Player", true)] });
    const result = showMusicPicker();
    await vi.waitFor(() => expect(byId("music-picker")).not.toBeNull());
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(await result).toBeNull();
  });

  it("shows a status instead of rows when the host cannot list apps", async () => {
    mocks.listApps.mockResolvedValue({ ok: false, code: "unavailable" });
    const result = showMusicPicker();
    await vi.waitFor(() => expect(byId("music-picker-status")?.textContent).not.toBe(""));
    expect(document.querySelector("[role='radio']")).toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await result;
  });
});
