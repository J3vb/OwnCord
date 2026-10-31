import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as codecMocks from "../helpers/voiceCodecTabMocks";

const isLinuxDesktop = vi.hoisted(() => vi.fn(() => false));
const supportsVP9 = vi.hoisted(() => vi.fn(() => true));

vi.mock("../../src/features/voice/native/platform", () =>
  codecMocks.nativePlatformMock(() => isLinuxDesktop()),
);
const nativeVp9 = vi.hoisted(() => ({ value: false }));
vi.mock("../../src/features/voice/native/videoCodecs", () => ({
  nativeVideoCodecs: () => Promise.resolve({ h264: true, vp9: nativeVp9.value, decode: [] }),
}));
vi.mock("../../src/features/voice/native/devices", () => codecMocks.nativeDevicesMock());
vi.mock("../../src/platform/desktop", (importOriginal) =>
  codecMocks.desktopMicTestBusyMock(importOriginal),
);
vi.mock("livekit-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("livekit-client")>()),
  supportsVP9: () => supportsVP9(),
}));
vi.mock("../../src/platform/desktop/pushToTalk", () => codecMocks.inertPushToTalkMock());
vi.mock("@lib/voice/livekitSession", () => codecMocks.reapplyAudioSessionMock());

import { installFakeAudio } from "../helpers/fakeAudioContext";
import { codecOptions, expectCodecsEventually, shownCodecFor } from "../helpers/voiceCodecTab";

beforeEach(() => {
  localStorage.clear();
  isLinuxDesktop.mockReturnValue(false);
  nativeVp9.value = false;
  supportsVP9.mockReturnValue(true);
  installFakeAudio({ worklets: true });
  codecMocks.stubEmptyMediaDevices();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("VoiceAudioTab VP9 entry", () => {
  it("is shown where VP9 can be published", () => {
    expect(codecOptions()).toEqual(["vp8", "h264", "vp9", "auto"]);
  });

  it("is hidden when VP9 is not supported", () => {
    supportsVP9.mockReturnValue(false);
    expect(codecOptions()).toEqual(["vp8", "h264", "auto"]);
  });

  it("never offers VP9 on Linux when the native engine lacks it", async () => {
    isLinuxDesktop.mockReturnValue(true);
    await expectCodecsEventually(["vp8", "h264", "auto"]);
  });

  it("offers VP9 on Linux when the native engine has it", async () => {
    isLinuxDesktop.mockReturnValue(true);
    nativeVp9.value = true;
    // The webview's own check does not matter on Linux.
    supportsVP9.mockReturnValue(false);
    await expectCodecsEventually(["vp8", "h264", "vp9", "auto"]);
  });

  it("shows a saved VP9 that is no longer offered as VP8", () => {
    supportsVP9.mockReturnValue(false);
    expect(shownCodecFor("vp9")).toBe("vp8");
  });
});
