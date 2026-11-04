import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { makeChannel } from "../helpers/channelFactory";
import * as voiceSession from "../helpers/voiceSessionMock";
import * as voiceWidget from "../helpers/voiceWidgetHarness";

const mockRetryMicPermission = vi.fn().mockResolvedValue(undefined);
vi.mock("@lib/voice/livekitSession", () =>
  voiceSession.withOverrides({
    retryMicPermission: (...args: unknown[]) => mockRetryMicPermission(...args),
  }),
);

vi.mock("@lib/voice/connectionStats", () => voiceWidget.connectionStatsMock());

import { createVoiceWidget } from "@components/VoiceWidget";
import { voiceStore } from "@stores/voice.store";
import { channelsStore } from "@stores/channels.store";

function resetStores(): void {
  voiceWidget.resetVoiceWidgetStores();
}

function setVoiceConnected(screenshare = false): void {
  channelsStore.setState((prev) => ({
    ...prev,
    channels: new Map([[1, makeChannel({ name: "Voice", type: "voice" })]]),
  }));
  voiceStore.setState((prev) => ({
    ...prev,
    currentChannelId: 1,
    localScreenshare: screenshare,
    joinedAt: Date.now(),
  }));
}

describe("Screen Share Button in VoiceWidget", () => {
  let container: HTMLDivElement;
  let comp: ReturnType<typeof createVoiceWidget>;
  let handlers: {
    onDisconnect: Mock<() => void>;
    onMuteToggle: Mock<() => void>;
    onDeafenToggle: Mock<() => void>;
    onCameraToggle: Mock<() => void>;
    onScreenshareToggle: Mock<() => void>;
  };

  beforeEach(() => {
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
    handlers = {
      onDisconnect: vi.fn<() => void>(),
      onMuteToggle: vi.fn<() => void>(),
      onDeafenToggle: vi.fn<() => void>(),
      onCameraToggle: vi.fn<() => void>(),
      onScreenshareToggle: vi.fn<() => void>(),
    };
  });

  afterEach(() => {
    comp?.destroy?.();
    container.remove();
    resetStores();
  });

  it("clicking share button calls onScreenshareToggle", () => {
    setVoiceConnected();
    comp = createVoiceWidget(handlers);
    comp.mount(container);

    const shareBtn = container.querySelector('[aria-label="Screenshare"]') as HTMLButtonElement;
    expect(shareBtn).not.toBeNull();
    shareBtn.click();

    expect(handlers.onScreenshareToggle).toHaveBeenCalledOnce();
  });

  it("share button has aria-pressed=true when screenshare is active", () => {
    setVoiceConnected(true);
    comp = createVoiceWidget(handlers);
    comp.mount(container);

    const shareBtn = container.querySelector('[aria-label="Screenshare"]') as HTMLButtonElement;
    expect(shareBtn).not.toBeNull();
    expect(shareBtn.getAttribute("aria-pressed")).toBe("true");
  });

  it("share button has active-ctrl and a swapped icon when screensharing", () => {
    setVoiceConnected(true);
    comp = createVoiceWidget(handlers);
    comp.mount(container);

    const shareBtn = container.querySelector('[aria-label="Screenshare"]') as HTMLButtonElement;
    expect(shareBtn.classList.contains("active-ctrl")).toBe(true);
    expect(shareBtn.querySelector("svg")?.getAttribute("data-icon")).toBe("monitor-off");
  });

  // The redesign (captain 2026-09-30) removed the squeezed "Sharing" text
  // label: the active state is carried by the button's own aria-pressed
  // state, icon swap and tint.
  it("share button keeps its active state on the button, with no text label", () => {
    setVoiceConnected(true);
    comp = createVoiceWidget(handlers);
    comp.mount(container);

    const shareBtn = container.querySelector('[aria-label="Screenshare"]') as HTMLButtonElement;
    expect(shareBtn.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".vw-share-label")).toBeNull();
  });
});
