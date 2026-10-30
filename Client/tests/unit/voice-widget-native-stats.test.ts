// WP LP-5: the voice widget's ping and bars on Linux. Nothing between the
// widget and the host is mocked except the host itself: a real stats poller
// reads a real `NativeRoom`, connected through a stubbed `platform/desktop`.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NativeVoiceStats } from "../../src/platform/contracts/nativeVoice";

const host = vi.hoisted(() => ({
  stats: null as unknown,
  room: null as unknown,
}));

vi.mock("../../src/platform/desktop", () => ({
  desktop: {
    nativeVoice: {
      connect: () => Promise.resolve({ session: 1, identity: "me", frames: "ws://127.0.0.1:9/t" }),
      disconnect: () =>
        Promise.resolve({ rooms: 0, localTracks: 0, captureStreams: 0, threads: 1 }),
      getStats: () => Promise.resolve(host.stats),
      onEvent: () => () => undefined,
    },
  },
}));
vi.mock("../../src/features/voice/native/platform", () => ({
  isLinuxDesktop: () => true,
  isWindowsDesktop: () => false,
  canPublishScreen: () => true,
}));
vi.mock("@lib/voice/livekitSession", () => ({
  getLocalScreenshareStream: () => null,
  getScreenshareQuality: () => null,
  changeScreenshareSource: vi.fn(),
  canChangeScreenshareSource: () => false,
  setScreenshareQuality: vi.fn(),
  getRoomForStats: () => host.room,
  retryMicPermission: vi.fn(),
  reapplyEnhancedNoiseSuppression: vi.fn(),
  joinVoice: vi.fn(),
  leaveVoice: vi.fn(),
  toggleMute: vi.fn(),
  toggleDeafen: vi.fn(),
}));

import { createVoiceWidget } from "../../src/components/VoiceWidget";
import { createNativeRoom } from "../../src/features/voice/native/nativeRoom";
import { voiceStore, type VoiceStatus, type VoiceUser } from "../../src/stores/voice.store";
import { setConnectionStatus } from "../../src/stores/ui.store";

const audio = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  enhancedNoiseSuppression: false,
};

const reply = (rttSeconds: number): NativeVoiceStats => ({
  atMs: 1000,
  publisher: [
    {
      type: "candidate-pair",
      id: "CP1",
      currentRoundTripTime: rttSeconds,
      bytesSent: 900,
      bytesReceived: 1200,
    },
    { type: "outbound-rtp", id: "OA1", kind: "audio", packetsSent: 100, bytesSent: 4000 },
    {
      type: "inbound-rtp",
      id: "IA1",
      kind: "audio",
      packetsReceived: 100,
      bytesReceived: 3000,
      packetsLost: 0,
      jitter: 0.004,
    },
  ],
  subscriber: [],
  remoteVideo: {},
  localVideo: {},
});

describe("VoiceWidget on a native room", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    setConnectionStatus("connected");
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    container.remove();
    host.room = null;
    host.stats = null;
    vi.useRealTimers();
  });

  function showWidget(): { destroy?: () => void } {
    const users = new Map<number, VoiceUser>();
    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 1,
      voiceUsers: new Map([[1, users]]),
      voiceStatus: "connected" as VoiceStatus,
    }));
    voiceStore.flush();
    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);
    return widget;
  }

  it("shows the native ping and bars", async () => {
    host.stats = reply(0.042);
    const room = createNativeRoom(audio);
    await room.connect("ws://127.0.0.1:7881/lk", "tok");
    host.room = room;
    const widget = showWidget();
    // Before the first sample the readout is honest about having nothing.
    const signal = container.querySelector(".vw-signal") as HTMLButtonElement;
    expect(signal.classList.contains("vw-signal--unavailable")).toBe(true);

    await vi.advanceTimersByTimeAsync(2100);

    expect(signal.classList.contains("vw-signal--unavailable")).toBe(false);
    expect(container.querySelector(".vw-ping")!.textContent).toBe("42ms");
    // 42 ms with no loss is excellent: all four bars are filled.
    const lit = [...signal.querySelectorAll("svg rect")].filter(
      (r) => r.getAttribute("fill") !== "var(--bg-active, #383a40)",
    );
    expect(lit).toHaveLength(4);

    widget.destroy?.();
    await room.disconnect();
  });
});
