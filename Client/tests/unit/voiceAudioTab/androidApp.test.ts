import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as mocks from "../../helpers/voiceAudioTabMocks";
import { createVoiceAudioTab } from "@components/settings/VoiceAudioTab";
import { installFakeAudio } from "../../helpers/fakeAudioContext";
import { stubNavigator } from "../../helpers/voiceAudioTabHarness";
import { clearHost, hostAndroidApp, hostDesktopApp } from "../../helpers/androidHost";

vi.mock("../../../src/platform/desktop/pushToTalk", () => mocks.desktopPushToTalkMock());
vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());

const INPUT_MODE_KEY = "owncord:settings:inputMode";

describe("VoiceAudioTab on the Android app and the desktop app", () => {
  let el: HTMLElement;
  let ac: AbortController;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    document.body.innerHTML = "";
    installFakeAudio({ worklets: true });
    stubNavigator();
  });

  afterEach(() => {
    ac.abort();
    clearHost();
    vi.unstubAllGlobals();
  });

  function mount(): void {
    ac = new AbortController();
    el = createVoiceAudioTab(ac.signal).build();
    document.body.appendChild(el);
  }
  const text = (): string => el.textContent ?? "";
  const heading = (name: string): boolean =>
    [...el.querySelectorAll(".settings-card-head h3")].some((h) => h.textContent === name);
  const labelled = (name: string): boolean =>
    el.querySelector(`select[aria-label="${name}"]`) !== null;

  it("shows every desktop control on the desktop app", () => {
    hostDesktopApp();
    mount();
    expect(heading("Input Mode")).toBe(true);
    expect(el.querySelector('[data-testid="input-mode-ptt"]')).not.toBeNull();
    expect(labelled("Output Device")).toBe(true);
    expect(labelled("Screen Share Quality")).toBe(true);
    expect(labelled("Screen Share FPS")).toBe(true);
    expect(labelled("Video Codec")).toBe(true);
  });

  it("leaves out the input mode, output device, screen share and codec controls on Android", () => {
    hostAndroidApp();
    mount();
    expect(heading("Input Mode")).toBe(false);
    expect(el.querySelector('[data-testid="input-mode"]')).toBeNull();
    expect(el.querySelector('[data-testid="ptt-controls"]')).toBeNull();
    expect(labelled("Output Device")).toBe(false);
    expect(labelled("Screen Share Quality")).toBe(false);
    expect(labelled("Screen Share FPS")).toBe(false);
    expect(labelled("Video Codec")).toBe(false);
    expect(el.querySelector('[data-testid="screen-fps-wayland-note"]')).toBeNull();
    // What a phone does have stays.
    expect(labelled("Camera Quality")).toBe(true);
    expect(text()).toContain("Output Volume");
    expect(text()).toContain("Input Sensitivity");
    expect(heading("Camera")).toBe(true);
    expect(heading("Camera & screen share")).toBe(false);
  });

  it("keeps a saved Push to Talk choice on Android, and gates on the sensitivity", () => {
    localStorage.setItem(INPUT_MODE_KEY, '"ptt"');
    localStorage.setItem("owncord:settings:pttVk", "65");
    hostAndroidApp();
    mount();
    // The saved choice is neither shown nor changed.
    expect(localStorage.getItem(INPUT_MODE_KEY)).toBe('"ptt"');
    expect(localStorage.getItem("owncord:settings:pttVk")).toBe("65");
    // A saved Push to Talk on a desktop hides the sensitivity row; here it shows.
    expect(el.querySelector<HTMLElement>(".mic-meter-wrap")!.hidden).toBe(false);
    expect(el.querySelector<HTMLElement>("[data-testid='auto-sensitivity']")!.hidden).toBe(false);
    expect(mocks.mockPttUpdateKey).not.toHaveBeenCalled();
  });

  it("still hides the sensitivity row for a saved Push to Talk on the desktop app", () => {
    localStorage.setItem(INPUT_MODE_KEY, '"ptt"');
    hostDesktopApp();
    mount();
    expect(el.querySelector<HTMLElement>(".mic-meter-wrap")!.hidden).toBe(true);
  });
});
