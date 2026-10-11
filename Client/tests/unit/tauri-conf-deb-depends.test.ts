// The Linux binary links GStreamer directly (native camera capture,
// src-tauri/src/native_voice/camera.rs), so the .deb must declare the runtime
// libraries it loads and the plugins its capture pipeline builds: without
// libgstreamer the binary does not start at all, and without the plugins the
// camera reports missing support. The AppImage bundles both instead
// (bundleMediaFramework).

import { describe, expect, it } from "vitest";

// Asserts src-tauri/tauri.conf.json, which is inside the Client component —
// not a cross-component contract test. See docs/contributing.md#testing.
import tauriConf from "../../src-tauri/tauri.conf.json";

describe("tauri.conf.json — Linux GStreamer runtime", () => {
  it("declares the GStreamer libraries and camera plugins in the .deb", () => {
    expect(tauriConf.bundle.linux.deb.depends).toEqual(
      expect.arrayContaining([
        "libgstreamer1.0-0",
        "libgstreamer-plugins-base1.0-0",
        "gstreamer1.0-plugins-base",
        "gstreamer1.0-plugins-good",
      ]),
    );
  });

  // Recommends, not Depends: a minimal system still installs the package, and
  // apt pulls recommends in by default (the artifact smoke installs with
  // --no-install-recommends, so it is unaffected). Each closes a gap the
  // Windows build does not have: fonts-noto-color-emoji gives colour emoji
  // glyphs; gstreamer1.0-libav and -plugins-bad give WebKitGTK the H264/AAC
  // decoders for mp4 attachments and YouTube embeds; gstreamer1.0-pipewire is
  // the pipewiresrc camera source camera.rs already tries.
  it("recommends the emoji font, video codecs and PipeWire source without depending on them", () => {
    const { depends, recommends } = tauriConf.bundle.linux.deb as {
      depends: string[];
      recommends?: string[];
    };
    const wanted = [
      "fonts-noto-color-emoji",
      "gstreamer1.0-libav",
      "gstreamer1.0-plugins-bad",
      "gstreamer1.0-pipewire",
    ];
    expect(recommends).toEqual(wanted);
    for (const pkg of wanted) {
      expect(depends).not.toContain(pkg);
    }
  });

  it("bundles GStreamer into the AppImage", () => {
    expect(tauriConf.bundle.linux.appimage.bundleMediaFramework).toBe(true);
  });
});
