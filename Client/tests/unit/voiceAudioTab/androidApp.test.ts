import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as mocks from "../../helpers/voiceAudioTabMocks";
import { createVoiceAudioTab } from "../../../src/features/settings/VoiceAudioTab";
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
    [...el.querySelectorAll(".settings-section-head h2")].some((h) => h.textContent === name);
  const labelled = (name: string): boolean =>
    el.querySelector(`select[aria-label="${name}"]`) !== null;

  it("shows every desktop control on the desktop app", () => {
    hostDesktopApp();
    mount();
    expect(heading("Input mode")).toBe(true);
    expect(el.querySelector('[data-testid="input-mode-ptt"]')).not.toBeNull();
    expect(labelled("Output device")).toBe(true);
    expect(labelled("Screen share quality")).toBe(true);
    expect(labelled("Screen share FPS")).toBe(true);
    expect(labelled("Video codec")).toBe(true);
    expect(labelled("Input device")).toBe(true);
    expect(el.querySelector('[data-testid="mic-automatic"]')).toBeNull();
  });

  it("shows the phone's automatic mic instead of the input device picker on Android", () => {
    hostAndroidApp();
    mount();
    expect(labelled("Input device")).toBe(false);
    expect(text()).not.toContain("Input device");
    const row = el.querySelector<HTMLElement>('[data-testid="mic-automatic"]')!;
    expect(row.textContent).toContain("Microphone");
    expect(row.textContent).toContain("Automatic");
    // It sits in the microphone card, ahead of the volume slider.
    expect(row.closest(".settings-card")?.textContent).toContain("Input volume");
  });

  it("leaves out the output device, screen share and codec controls on Android", () => {
    hostAndroidApp();
    mount();
    expect(labelled("Output device")).toBe(false);
    expect(labelled("Screen share quality")).toBe(false);
    expect(labelled("Screen share FPS")).toBe(false);
    expect(labelled("Video codec")).toBe(false);
    expect(el.querySelector('[data-testid="screen-fps-wayland-note"]')).toBeNull();
    // What a phone does have stays.
    expect(labelled("Camera quality")).toBe(true);
    expect(text()).toContain("Output volume");
    expect(text()).toContain("Input sensitivity");
    expect(heading("Camera")).toBe(true);
    expect(heading("Camera & screen share")).toBe(false);
  });

  it("offers Push to talk on Android with the talk button, not a key to bind", () => {
    hostAndroidApp();
    mount();
    expect(heading("Input mode")).toBe(true);
    expect(el.querySelector('[data-testid="input-mode-ptt"]')).not.toBeNull();
    const ptt = el.querySelector<HTMLElement>('[data-testid="ptt-controls"]')!;
    expect(ptt.textContent).toContain("Hold to talk");
    expect(ptt.querySelector(".kbd")).toBeNull();
    expect(el.querySelector('[data-testid="ptt-release-delay"]')).toBeNull();
  });

  it("choosing Push to talk on Android arms the talk button, never the key service", async () => {
    hostAndroidApp();
    mount();
    el.querySelector<HTMLButtonElement>('[data-testid="input-mode-ptt"]')!.click();
    expect(localStorage.getItem(INPUT_MODE_KEY)).toBe('"ptt"');
    expect(el.querySelector<HTMLElement>(".mic-meter-wrap")!.hidden).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.mockPttUpdateKey).not.toHaveBeenCalled();
    expect(mocks.mockPttStop).not.toHaveBeenCalled();
  });

  it("keeps a saved Push to talk choice on Android, and hides the sensitivity row as on the desktop", () => {
    localStorage.setItem(INPUT_MODE_KEY, '"ptt"');
    hostAndroidApp();
    mount();
    expect(localStorage.getItem(INPUT_MODE_KEY)).toBe('"ptt"');
    expect(el.querySelector<HTMLElement>(".mic-meter-wrap")!.hidden).toBe(true);
    expect(el.querySelector<HTMLElement>("[data-testid='auto-sensitivity']")!.hidden).toBe(true);
    expect(mocks.mockPttUpdateKey).not.toHaveBeenCalled();
  });

  it("still hides the sensitivity row for a saved Push to talk on the desktop app", () => {
    localStorage.setItem(INPUT_MODE_KEY, '"ptt"');
    hostDesktopApp();
    mount();
    expect(el.querySelector<HTMLElement>(".mic-meter-wrap")!.hidden).toBe(true);
  });
});
