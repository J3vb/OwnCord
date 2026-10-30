/**
 * Screen share needs getDisplayMedia, which phone browsers lack (WP 6.13f1):
 * the web build then offers no start-share entry and the keybind is a no-op.
 * Runs in the `web` project, where `__OWNCORD_WEB__` is true.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lib/livekitSession", () => ({
  getRoomForStats: vi.fn().mockReturnValue(null),
  retryMicPermission: vi.fn(),
  joinVoice: vi.fn(),
  leaveVoice: vi.fn(),
  toggleMute: vi.fn(),
  toggleDeafen: vi.fn(),
}));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { createVoiceWidget } = await import("@components/VoiceWidget");
const { attachGlobalKeybinds } = await import("../../src/pages/main-page/GlobalKeybinds");
const { voiceStore } = await import("@stores/voice.store");
const { parseKeybinds } = await import("../../src/lib/prefs/keybinds");

function setMediaDevices(value: unknown): void {
  Object.defineProperty(navigator, "mediaDevices", { value, configurable: true });
}

describe("screen share gate (web build)", () => {
  const cleanups: Array<() => void> = [];
  const original = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");

  beforeEach(() => {
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 1 }));
  });

  afterEach(() => {
    for (const run of cleanups.splice(0)) run();
    if (original) Object.defineProperty(navigator, "mediaDevices", original);
    else Reflect.deleteProperty(navigator, "mediaDevices");
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: null }));
  });

  function mountWidget(): HTMLDivElement {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(host);
    cleanups.push(() => {
      widget.destroy?.();
      host.remove();
    });
    return host;
  }

  it("hides the widget share button without getDisplayMedia", () => {
    setMediaDevices({});
    const host = mountWidget();
    expect(host.querySelector(".vw-share-btn")).toBeNull();
    expect(host.querySelector(".vw-controls")).not.toBeNull();
  });

  it("keeps the widget share button with getDisplayMedia", () => {
    setMediaDevices({ getDisplayMedia: vi.fn() });
    const host = mountWidget();
    expect(host.querySelector(".vw-share-btn")).not.toBeNull();
  });

  function pressShareKey(): ReturnType<typeof vi.fn> {
    const onToggleScreenshare = vi.fn();
    const keybinds = parseKeybinds(
      {
        v: 1,
        bindings: { toggleScreenshare: { vk: 0x78, ctrl: false, shift: false, alt: false } },
      },
      { mute: 0x4d, deafen: 0x44 },
      0,
    );
    const detach = attachGlobalKeybinds({
      onSearch: vi.fn(),
      onOpenSettings: vi.fn(),
      onOpenShortcuts: vi.fn(),
      onToggleMute: vi.fn(),
      onToggleDeafen: vi.fn(),
      onToggleCamera: vi.fn(),
      onUploadFile: vi.fn(),
      onStepChannel: vi.fn(),
      onTogglePicker: vi.fn(),
      onMarkChannelRead: vi.fn(),
      onMarkServerRead: vi.fn(),
      onScrollMessages: vi.fn(),
      onToggleScreenshare,
      keybinds: () => keybinds,
      voiceShortcutKeys: () => ({ mute: 0x4d, deafen: 0x44 }),
      isGlobalPollerActive: () => false,
    });
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "F9", code: "F9", cancelable: true }),
    );
    detach();
    return onToggleScreenshare;
  }

  it("makes the share keybind a no-op without getDisplayMedia", () => {
    setMediaDevices(undefined);
    expect(pressShareKey()).not.toHaveBeenCalled();
  });

  it("runs the share keybind with getDisplayMedia", () => {
    setMediaDevices({ getDisplayMedia: vi.fn() });
    expect(pressShareKey()).toHaveBeenCalledTimes(1);
  });
});
