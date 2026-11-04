import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePhone } from "../helpers/phoneMedia";
import {
  createLazyPhoneCallBar,
  type LazyPhoneCallBar,
} from "../../src/pages/main-page/lazyPhoneCallBar";
import { channelsStore, resetChannelsStore, setChannels } from "../../src/stores/channels.store";
import {
  joinVoiceChannel,
  leaveVoiceChannel,
  resetVoiceStore,
  setVoiceStatus,
  voiceStore,
} from "../../src/stores/voice.store";

// Its module-level listeners must exist before the first test, as in the app,
// not be added by the dynamic import mid-test.
import "../../src/components/PhoneCallBar";

const VOICE = 10;

/** The bar's code loads on demand; wait for it to land and mount. */
async function settle(): Promise<void> {
  voiceStore.flush();
  await vi.dynamicImportSettled();
  for (let i = 0; i < 3; i++) await Promise.resolve();
}

describe("lazy phone call bar", () => {
  let host: HTMLDivElement;
  let lazy: LazyPhoneCallBar | null = null;
  const options = {
    isGridUp: () => false,
    onMuteToggle: vi.fn(),
    onLeave: vi.fn(),
    onOpenCall: vi.fn(),
  };
  const bar = (): HTMLElement | null => host.querySelector('[data-testid="phone-call-bar"]');

  function mountLazy(): LazyPhoneCallBar {
    lazy = createLazyPhoneCallBar(options);
    lazy.mount(host);
    return lazy;
  }

  beforeEach(() => {
    usePhone(true);
    resetVoiceStore();
    resetChannelsStore();
    setChannels([{ id: VOICE, name: "Voice Chat", type: "voice", category: null, position: 0 }]);
    channelsStore.flush();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    lazy?.destroy?.();
    lazy = null;
    host.remove();
    vi.unstubAllGlobals();
  });

  it("holds its place under the header and loads nothing out of a call", async () => {
    mountLazy();
    await settle();
    expect(host.querySelector('[data-testid="phone-call-bar-slot"]')).not.toBeNull();
    expect(bar()).toBeNull();
  });

  it("loads and shows the bar when a phone joins a call", async () => {
    mountLazy();
    joinVoiceChannel(VOICE);
    setVoiceStatus("connected");
    await settle();
    expect(bar()).not.toBeNull();
    expect(bar()?.parentElement?.getAttribute("data-testid")).toBe("phone-call-bar-slot");
    expect(bar()?.hidden).toBe(false);
  });

  it("loads for a call already under way when it mounts", async () => {
    joinVoiceChannel(VOICE);
    mountLazy();
    await settle();
    expect(bar()?.hidden).toBe(false);
  });

  it("does not load off a phone, until the window becomes one", async () => {
    usePhone(false);
    mountLazy();
    joinVoiceChannel(VOICE);
    await settle();
    expect(bar()).toBeNull();

    usePhone(true);
    window.dispatchEvent(new Event("resize"));
    await settle();
    expect(bar()?.hidden).toBe(false);
  });

  it("refresh reaches the loaded bar, and the bar leaves with the call", async () => {
    const l = mountLazy();
    l.refresh();
    joinVoiceChannel(VOICE);
    await settle();
    l.refresh();
    expect(bar()?.hidden).toBe(false);
    leaveVoiceChannel();
    await settle();
    expect(bar()?.hidden).toBe(true);
  });

  it("mounts nothing when torn down while the code loads", async () => {
    const l = mountLazy();
    joinVoiceChannel(VOICE);
    voiceStore.flush();
    l.destroy?.();
    await settle();
    expect(bar()).toBeNull();
    expect(host.querySelector('[data-testid="phone-call-bar-slot"]')).toBeNull();
  });

  it("removes the bar and its timer on teardown", async () => {
    mountLazy();
    joinVoiceChannel(VOICE);
    await settle();
    expect(bar()).not.toBeNull();
    lazy?.destroy?.();
    expect(bar()).toBeNull();
    expect(host.querySelector('[data-testid="phone-call-bar-slot"]')).toBeNull();
  });
});
