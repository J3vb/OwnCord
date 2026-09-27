import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NativeVoiceScreenSources } from "../../../platform/contracts/nativeVoice";

interface FakePickOptions {
  readonly sources: readonly unknown[];
  readonly portal: boolean;
}
type FakePick = {
  source: string;
  quality: "low" | "medium" | "high" | "source";
  fps: number;
} | null;

const host = vi.hoisted(
  (): {
    sources: NativeVoiceScreenSources;
    pick: (opts: FakePickOptions) => FakePick;
  } => ({
    sources: { portal: false, sources: [] },
    pick: () => null,
  }),
);
vi.mock("../../../platform/desktop", () => ({
  desktop: { nativeVoice: { screenSources: () => Promise.resolve(host.sources) } },
}));
// The picker component itself is covered by its own test; here we pin the
// adapter's mapping from the dialog's choice to the host capture settings.
vi.mock("../../../components/ScreenSharePicker", () => ({
  showScreenSharePicker: (opts: { sources: unknown[]; portal: boolean }) =>
    Promise.resolve(host.pick(opts)),
}));

import { pickScreenSource } from "./screenPicker";

const x11: NativeVoiceScreenSources = {
  portal: false,
  sources: [
    {
      id: "screen:277",
      kind: "screen",
      title: "screen",
      thumbnail: "data:image/png;base64,iVBORw==",
    },
    { id: "window:81", kind: "window", title: "Terminal", thumbnail: null },
  ],
};

describe("pickScreenSource", () => {
  beforeEach(() => {
    host.sources = x11;
    host.pick = () => null;
  });
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("maps the dialog's choice onto the host capture and the saved quality", async () => {
    host.pick = () => ({
      source: "window:81",
      quality: "high",
      fps: 30,
    });
    await expect(pickScreenSource()).resolves.toEqual({
      source: "window:81",
      capture: { fps: 30, maxWidth: 1920, maxHeight: 1080 },
      maxBitrate: 6_000_000,
      maxFramerate: 30,
    });
  });

  it("lets the dialog's per-share quality override the saved prefs", async () => {
    host.pick = () => ({ source: "screen:277", quality: "low", fps: 30 });
    await expect(pickScreenSource()).resolves.toEqual({
      source: "screen:277",
      capture: { fps: 5, maxWidth: 1280, maxHeight: 720 },
      maxBitrate: 1_500_000,
      maxFramerate: 5,
    });
  });

  it("uncaps the size for Source at 60/120 fps and caps it at 1080p30 otherwise", async () => {
    host.pick = () => ({ source: "screen:277", quality: "source", fps: 60 });
    await expect(pickScreenSource()).resolves.toEqual({
      source: "screen:277",
      capture: { fps: 60, maxWidth: 0, maxHeight: 0 },
      maxBitrate: 15_000_000,
      maxFramerate: 60,
    });
    host.pick = () => ({ source: "screen:277", quality: "source", fps: 120 });
    await expect(pickScreenSource()).resolves.toMatchObject({
      capture: { fps: 120, maxWidth: 0, maxHeight: 0 },
      maxFramerate: 120,
    });
    host.pick = () => ({ source: "screen:277", quality: "source", fps: 30 });
    await expect(pickScreenSource()).resolves.toMatchObject({
      capture: { fps: 30, maxWidth: 1920, maxHeight: 1080 },
      maxFramerate: 30,
    });
  });

  it("shows only the quality step on Wayland and hands the portal the pick", async () => {
    host.sources = { portal: true, sources: [] };
    host.pick = (opts) => {
      expect(opts.portal).toBe(true);
      expect(opts.sources).toEqual([]);
      return { source: "portal", quality: "medium", fps: 60 };
    };
    await expect(pickScreenSource()).resolves.toMatchObject({ source: "portal" });
  });

  it("resolves null when the dialog is dismissed", async () => {
    host.pick = () => null;
    await expect(pickScreenSource()).resolves.toBeNull();
  });
});
