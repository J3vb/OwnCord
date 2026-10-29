import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NativeVoiceScreenSources } from "../../../platform/contracts/nativeVoice";

interface FakePickOptions {
  readonly sources: readonly unknown[];
  readonly portal: boolean;
  readonly sourceOnly?: boolean;
  readonly audioAvailable?: boolean;
}
type FakePick = {
  source: string;
  quality: "low" | "medium" | "high" | "source";
  fps: number;
  audio?: boolean;
} | null;

const host = vi.hoisted(
  (): {
    sources: NativeVoiceScreenSources;
    pick: (opts: FakePickOptions) => FakePick;
  } => ({
    sources: { portal: false, sources: [], audio: false },
    pick: () => null,
  }),
);
vi.mock("../../../platform/desktop", () => ({
  desktop: { nativeVoice: { screenSources: () => Promise.resolve(host.sources) } },
}));

import {
  armScreenRestart,
  disarmScreenRestart,
  noteChangedQuality,
  noteChangedSource,
  pickChangeSource,
  pickScreenSource,
  shareSettings,
} from "./screenPicker";
import { setScreenSourcePicker } from "./screenPickerSlot";

const x11: NativeVoiceScreenSources = {
  portal: false,
  audio: false,
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
    // The UI layer (MainPage) registers the dialog; this test registers a
    // stand-in so the adapter's mapping from the dialog's choice to the host
    // capture settings is pinned without depending on the component.
    setScreenSourcePicker((opts) => Promise.resolve(host.pick(opts)));
  });
  afterEach(() => {
    setScreenSourcePicker(null);
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
      quality: "high",
      fps: 30,
      capture: { fps: 30, maxWidth: 1920, maxHeight: 1080 },
      maxBitrate: 6_000_000,
      maxFramerate: 30,
      simulcast: true,
    });
  });

  it("publishes a High pick at 120 fps without the lower layer", async () => {
    host.pick = () => ({ source: "screen:277", quality: "high", fps: 120 });
    await expect(pickScreenSource()).resolves.toMatchObject({
      maxFramerate: 120,
      simulcast: false,
    });
  });

  it("defaults the dialog to the screen share's own quality (720p30)", async () => {
    let seen: unknown;
    host.pick = (opts) => {
      seen = (opts as { defaultQuality?: unknown }).defaultQuality;
      return null;
    };
    await pickScreenSource();
    expect(seen).toBe("medium");
  });

  it("lets the dialog's per-share quality override the saved prefs", async () => {
    host.pick = () => ({ source: "screen:277", quality: "low", fps: 30 });
    await expect(pickScreenSource()).resolves.toEqual({
      source: "screen:277",
      quality: "low",
      fps: 30,
      capture: { fps: 5, maxWidth: 1280, maxHeight: 720 },
      maxBitrate: 1_500_000,
      maxFramerate: 5,
      simulcast: false,
    });
  });

  it("uncaps the size for Source at 60/120 fps and caps it at 1080p30 otherwise", async () => {
    host.pick = () => ({ source: "screen:277", quality: "source", fps: 60 });
    await expect(pickScreenSource()).resolves.toEqual({
      source: "screen:277",
      quality: "source",
      fps: 60,
      capture: { fps: 60, maxWidth: 0, maxHeight: 0 },
      maxBitrate: 15_000_000,
      maxFramerate: 60,
      simulcast: false,
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
    host.sources = { portal: true, sources: [], audio: false };
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

  it("resolves null when no picker is registered (headless), without touching the host", async () => {
    setScreenSourcePicker(null);
    await expect(pickScreenSource()).resolves.toBeNull();
  });
});

describe("armScreenRestart (WP 1C-6)", () => {
  beforeEach(() => {
    host.sources = x11;
    setScreenSourcePicker((opts) => Promise.resolve(host.pick(opts)));
  });
  afterEach(() => {
    disarmScreenRestart();
    setScreenSourcePicker(null);
  });

  it("reuses the last pick, with no dialog, while the host still lists its source", async () => {
    host.pick = () => ({ source: "window:81", quality: "high", fps: 30 });
    const first = await pickScreenSource();

    await expect(armScreenRestart()).resolves.toBe(true);
    const shown = vi.fn(() => null);
    host.pick = shown;
    await expect(pickScreenSource()).resolves.toEqual(first);
    expect(shown).not.toHaveBeenCalled();
    // Used once: the next share asks again.
    await expect(pickScreenSource()).resolves.toBeNull();
    expect(shown).toHaveBeenCalledOnce();
  });

  it("a confirmed pick carries the audio choice, and a restart reuses it", async () => {
    host.sources = { ...x11, audio: true };
    let offered: boolean | undefined;
    host.pick = (opts) => {
      offered = opts.audioAvailable;
      return { source: "screen:277", quality: "medium", fps: 30, audio: true };
    };
    const first = await pickScreenSource();
    expect(offered).toBe(true);
    expect(first).toMatchObject({ audio: true });

    await expect(armScreenRestart()).resolves.toBe(true);
    await expect(pickScreenSource()).resolves.toEqual(first);
  });

  it("a pick without the switch has no audio, and a restart keeps audio while the server restarts", async () => {
    host.pick = () => ({ source: "screen:277", quality: "medium", fps: 30 });
    await expect(pickScreenSource()).resolves.not.toHaveProperty("audio");

    host.sources = { ...x11, audio: true };
    host.pick = () => ({ source: "screen:277", quality: "medium", fps: 30, audio: true });
    await pickScreenSource();
    host.sources = { ...x11, audio: false };
    await expect(armScreenRestart()).resolves.toBe(true);
    await expect(pickScreenSource()).resolves.toMatchObject({ audio: true });
  });

  it("refuses when the shared window is gone", async () => {
    host.pick = () => ({ source: "window:81", quality: "high", fps: 30 });
    await pickScreenSource();
    host.sources = {
      portal: false,
      audio: false,
      sources: x11.sources.filter((s) => s.id !== "window:81"),
    };

    await expect(armScreenRestart()).resolves.toBe(false);
  });

  it("refuses on Wayland, where only the portal dialog can pick", async () => {
    host.sources = { portal: true, sources: [], audio: false };
    host.pick = () => ({ source: "portal", quality: "medium", fps: 30 });
    await pickScreenSource();

    await expect(armScreenRestart()).resolves.toBe(false);
  });

  it("refuses a portal pick even when the host lists a source of that name", async () => {
    host.sources = {
      portal: true,
      audio: false,
      sources: [{ id: "portal", kind: "screen", title: "portal", thumbnail: null }],
    };
    host.pick = () => ({ source: "portal", quality: "medium", fps: 30 });
    await pickScreenSource();

    await expect(armScreenRestart()).resolves.toBe(false);
  });

  it("disarming puts the dialog back", async () => {
    host.pick = () => ({ source: "screen:277", quality: "medium", fps: 30 });
    await pickScreenSource();
    await armScreenRestart();
    disarmScreenRestart();
    const shown = vi.fn(() => null);
    host.pick = shown;

    await expect(pickScreenSource()).resolves.toBeNull();
    expect(shown).toHaveBeenCalledOnce();
  });
});

describe("pickChangeSource", () => {
  beforeEach(() => {
    host.sources = x11;
    setScreenSourcePicker((opts) => Promise.resolve(host.pick(opts)));
  });
  afterEach(() => {
    disarmScreenRestart();
    setScreenSourcePicker(null);
  });

  it("asks for the source only, and a later restart shares the new one", async () => {
    host.pick = () => ({ source: "window:81", quality: "high", fps: 30 });
    const first = await pickScreenSource();
    host.pick = (opts) => {
      expect(opts.sourceOnly).toBe(true);
      return { source: "screen:277", quality: "low", fps: 5 };
    };
    await expect(pickChangeSource()).resolves.toBe("screen:277");
    noteChangedSource("screen:277");

    await expect(armScreenRestart()).resolves.toBe(true);
    // Same capture and encoding as the share's own pick, the new source.
    await expect(pickScreenSource()).resolves.toEqual({ ...first, source: "screen:277" });
  });

  it("offers the listed sources, not the portal, to the dialog", async () => {
    let offered: FakePickOptions | undefined;
    host.pick = (opts) => {
      offered = opts;
      return { source: "screen:277", quality: "low", fps: 5 };
    };

    await pickChangeSource();

    expect(offered).toMatchObject({ portal: false, sourceOnly: true, sources: x11.sources });
  });

  it("leaves the pick to the portal on Wayland, with no dialog", async () => {
    host.sources = { portal: true, sources: [], audio: false };
    const shown = vi.fn(() => null);
    host.pick = shown;
    await expect(pickChangeSource()).resolves.toBe("portal");
    expect(shown).not.toHaveBeenCalled();
  });

  it("a picked source the host never swapped in leaves the restart on the old one", async () => {
    host.pick = () => ({ source: "window:81", quality: "high", fps: 30 });
    const first = await pickScreenSource();
    host.pick = () => ({ source: "screen:277", quality: "low", fps: 5 });
    await expect(pickChangeSource()).resolves.toBe("screen:277");

    await expect(armScreenRestart()).resolves.toBe(true);
    await expect(pickScreenSource()).resolves.toEqual(first);
  });

  it("resolves null when the dialog is dismissed", async () => {
    host.pick = () => null;
    await expect(pickChangeSource()).resolves.toBeNull();
  });
});

describe("shareSettings", () => {
  it("maps a quality and frame rate onto the host capture and the publish encoding", () => {
    expect(shareSettings("high", 30)).toEqual({
      capture: { fps: 30, maxWidth: 1920, maxHeight: 1080 },
      maxBitrate: 6_000_000,
      maxFramerate: 30,
      simulcast: true,
    });
    expect(shareSettings("source", 120)).toMatchObject({
      capture: { fps: 120, maxWidth: 0, maxHeight: 0 },
      maxFramerate: 120,
      simulcast: false,
    });
  });
});

describe("noteChangedQuality", () => {
  beforeEach(() => {
    host.sources = x11;
    setScreenSourcePicker((opts) => Promise.resolve(host.pick(opts)));
  });
  afterEach(() => {
    disarmScreenRestart();
    setScreenSourcePicker(null);
  });

  it("a restart after a reconnect re-shares at the changed quality, on the same source", async () => {
    host.pick = () => ({ source: "window:81", quality: "high", fps: 30, audio: true });
    await pickScreenSource();

    noteChangedQuality("low", 30);

    await expect(armScreenRestart()).resolves.toBe(true);
    await expect(pickScreenSource()).resolves.toEqual({
      source: "window:81",
      quality: "low",
      fps: 30,
      ...shareSettings("low", 30),
      audio: true,
    });
  });
});
