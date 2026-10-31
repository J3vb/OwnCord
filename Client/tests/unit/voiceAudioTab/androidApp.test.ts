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

  it("leaves out the output device, screen share and codec controls on Android", () => {
    hostAndroidApp();
    mount();
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

  it("offers Push to Talk on Android with the talk button, not a key to bind", () => {
    hostAndroidApp();
    mount();
    expect(heading("Input Mode")).toBe(true);
    expect(el.querySelector('[data-testid="input-mode-ptt"]')).not.toBeNull();
    const ptt = el.querySelector<HTMLElement>('[data-testid="ptt-controls"]')!;
    expect(ptt.textContent).toContain("Hold to talk");
    expect(ptt.querySelector(".kbd")).toBeNull();
    expect(el.querySelector('[data-testid="ptt-release-delay"]')).toBeNull();
  });

  it("choosing Push to Talk on Android arms the talk button, never the key service", async () => {
    hostAndroidApp();
    mount();
    el.querySelector<HTMLButtonElement>('[data-testid="input-mode-ptt"]')!.click();
    expect(localStorage.getItem(INPUT_MODE_KEY)).toBe('"ptt"');
    expect(el.querySelector<HTMLElement>(".mic-meter-wrap")!.hidden).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.mockPttUpdateKey).not.toHaveBeenCalled();
    expect(mocks.mockPttStop).not.toHaveBeenCalled();
  });

  it("keeps a saved Push to Talk choice on Android, and hides the sensitivity row as on the desktop", () => {
    localStorage.setItem(INPUT_MODE_KEY, '"ptt"');
    hostAndroidApp();
    mount();
    expect(localStorage.getItem(INPUT_MODE_KEY)).toBe('"ptt"');
    expect(el.querySelector<HTMLElement>(".mic-meter-wrap")!.hidden).toBe(true);
    expect(el.querySelector<HTMLElement>("[data-testid='auto-sensitivity']")!.hidden).toBe(true);
    expect(mocks.mockPttUpdateKey).not.toHaveBeenCalled();
  });

  it("still hides the sensitivity row for a saved Push to Talk on the desktop app", () => {
    localStorage.setItem(INPUT_MODE_KEY, '"ptt"');
    hostDesktopApp();
    mount();
    expect(el.querySelector<HTMLElement>(".mic-meter-wrap")!.hidden).toBe(true);
  });
});
