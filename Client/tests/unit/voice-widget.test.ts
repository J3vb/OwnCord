import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Must mock before imports
const mockRetryMicPermission = vi.fn().mockResolvedValue(undefined);
const mockShareQuality = vi.fn<() => string | null>(() => "medium");
const mockChangeSource = vi.fn().mockResolvedValue(undefined);
const mockCanChange = vi.fn<() => boolean>(() => true);
const mockSetQuality = vi.fn().mockResolvedValue(undefined);
const mockReapplyEnhanced = vi.fn().mockResolvedValue(undefined);
const mockIsLinuxDesktop = vi.fn(() => false);
vi.mock("../../src/features/voice/native/platform", () => ({
  isLinuxDesktop: () => mockIsLinuxDesktop(),
  isWindowsDesktop: () => false,
  canPublishScreen: () => true,
}));
vi.mock("@lib/voice/livekitSession", () => ({
  getLocalScreenshareStream: () => ({
    getVideoTracks: () => [
      { label: "window:42:0", getSettings: () => ({ displaySurface: "window" }) },
    ],
  }),
  getScreenshareQuality: () => mockShareQuality(),
  changeScreenshareSource: () => mockChangeSource(),
  canChangeScreenshareSource: () => mockCanChange(),
  setScreenshareQuality: (q: string) => mockSetQuality(q),
  getRoomForStats: vi.fn().mockReturnValue(null),
  retryMicPermission: (...args: unknown[]) => mockRetryMicPermission(...args),
  reapplyEnhancedNoiseSuppression: () => mockReapplyEnhanced(),
  joinVoice: vi.fn(),
  leaveVoice: vi.fn(),
  toggleMute: vi.fn(),
  toggleDeafen: vi.fn(),
}));

vi.mock("@lib/voice/connectionStats", () => ({
  createConnectionStatsPoller: vi.fn().mockReturnValue({
    start: vi.fn(),
    stop: vi.fn(),
    getStats: vi.fn().mockReturnValue({
      rtt: 0,
      quality: "excellent",
      outRate: 0,
      inRate: 0,
      outPackets: 0,
      inPackets: 0,
      totalUp: 0,
      totalDown: 0,
      available: true,
    }),
    onUpdate: vi.fn().mockReturnValue(() => {}),
    onQualityChanged: vi.fn().mockReturnValue(() => {}),
  }),
  formatBytes: vi.fn((v: number) => `${v} B`),
  formatRateCompact: vi.fn((v: number) => `${v} B/s`),
}));

import { createVoiceWidget } from "../../src/components/VoiceWidget";
import { createConnectionStatsPoller } from "@lib/voice/connectionStats";
import { voiceStore, type VoiceStatus } from "../../src/stores/voice.store";
import { channelsStore } from "../../src/stores/channels.store";
import { membersStore } from "../../src/stores/members.store";
import { dmStore } from "../../src/stores/dm.store";
import { uiStore, setConnectionStatus } from "../../src/stores/ui.store";
import type { VoiceUser } from "../../src/stores/voice.store";
import { loadPref, savePref } from "../../src/lib/prefs/preferences";

function resetStores(): void {
  voiceStore.setState(() => ({
    currentChannelId: null,
    voiceUsers: new Map(),
    voiceConfigs: new Map(),
    localMuted: false,
    localDeafened: false,
    localCamera: false,
    localScreenshare: false,
    joinedAt: null,
    listenOnly: false,
    voiceStatus: "idle",
  }));
  channelsStore.setState(() => ({
    categories: [],
    channels: new Map(),
    activeChannelId: null,
    roles: [],
  }));
  membersStore.setState(() => ({
    members: new Map(),
    typingUsers: new Map(),
  }));
  // Voice controls freeze when the socket is down; keep it live by default so
  // the interaction tests below operate on enabled controls.
  setConnectionStatus("connected");
}

function setVoiceStatus(status: VoiceStatus): void {
  voiceStore.setState((prev) => ({ ...prev, voiceStatus: status }));
  voiceStore.flush();
}

function setVoiceChannel(channelId: number, users: VoiceUser[]): void {
  const userMap = new Map<number, VoiceUser>();
  for (const u of users) {
    userMap.set(u.userId, u);
  }
  const voiceUsers = new Map<number, ReadonlyMap<number, VoiceUser>>();
  voiceUsers.set(channelId, userMap);

  voiceStore.setState((prev) => ({
    ...prev,
    currentChannelId: channelId,
    voiceUsers,
  }));
}

describe("VoiceWidget", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    resetStores();
    mockRetryMicPermission.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders hidden when not connected to a voice channel", () => {
    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const root = container.querySelector('[data-testid="voice-widget"]');
    expect(root).not.toBeNull();
    expect(root!.classList.contains("visible")).toBe(false);

    widget.destroy?.();
  });

  it("shows visible when connected to a voice channel", () => {
    channelsStore.setState((prev) => {
      const channels = new Map(prev.channels);
      channels.set(1, {
        id: 1,
        name: "Voice Lobby",
        type: "voice",
        category: null,
        position: 0,
        unreadCount: 0,
        mentionCount: 0,
        lastMessageId: null,
        canSend: true,
        topic: "",
        slowMode: 0,
        nsfw: false,
        isPrivate: false,
        voiceMaxUsers: 0,
        voiceMaxVideo: 0,
      });
      return { ...prev, channels };
    });

    setVoiceChannel(1, []);

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const root = container.querySelector('[data-testid="voice-widget"]');
    expect(root!.classList.contains("visible")).toBe(true);

    widget.destroy?.();
  });

  it("displays channel name", () => {
    channelsStore.setState((prev) => {
      const channels = new Map(prev.channels);
      channels.set(1, {
        id: 1,
        name: "Voice Lobby",
        type: "voice",
        category: null,
        position: 0,
        unreadCount: 0,
        mentionCount: 0,
        lastMessageId: null,
        canSend: true,
        topic: "",
        slowMode: 0,
        nsfw: false,
        isPrivate: false,
        voiceMaxUsers: 0,
        voiceMaxVideo: 0,
      });
      return { ...prev, channels };
    });

    setVoiceChannel(1, []);

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const channelName = container.querySelector(".vw-channel");
    expect(channelName?.textContent).toBe("Voice Lobby");

    widget.destroy?.();
  });

  it("does not render voice users (users only shown in sidebar)", () => {
    channelsStore.setState((prev) => {
      const channels = new Map(prev.channels);
      channels.set(1, {
        id: 1,
        name: "Voice Lobby",
        type: "voice",
        category: null,
        position: 0,
        unreadCount: 0,
        mentionCount: 0,
        lastMessageId: null,
        canSend: true,
        topic: "",
        slowMode: 0,
        nsfw: false,
        isPrivate: false,
        voiceMaxUsers: 0,
        voiceMaxVideo: 0,
      });
      return { ...prev, channels };
    });

    setVoiceChannel(1, [
      {
        userId: 10,
        username: "Alice",
        muted: false,
        deafened: false,
        speaking: false,
        camera: false,
        screenshare: false,
      },
    ]);

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const userItems = container.querySelectorAll(".voice-user-item");
    expect(userItems.length).toBe(0);

    widget.destroy?.();
  });

  it("has no mute or deafen button: they live in the user panel", () => {
    setVoiceChannel(1, []);

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    expect(container.querySelector('[aria-label="Disconnect"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Mute"]')).toBeNull();
    expect(container.querySelector('[aria-label="Deafen"]')).toBeNull();

    widget.destroy?.();
  });

  it("calls onDisconnect when disconnect button is clicked", () => {
    const onDisconnect = vi.fn();
    setVoiceChannel(1, []);

    const widget = createVoiceWidget({
      onDisconnect,
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const disconnectBtn = container.querySelector('[aria-label="Disconnect"]') as HTMLButtonElement;
    expect(disconnectBtn).not.toBeNull();
    disconnectBtn.click();
    expect(onDisconnect).toHaveBeenCalledOnce();

    widget.destroy?.();
  });

  it("toggles screenshare active state based on store", () => {
    setVoiceChannel(1, []);
    voiceStore.setState((prev) => ({ ...prev, localScreenshare: true }));

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const screenshareBtn = container.querySelector(
      '[aria-label="Screenshare"]',
    ) as HTMLButtonElement;
    expect(screenshareBtn).not.toBeNull();
    expect(screenshareBtn.classList.contains("active-ctrl")).toBe(true);
    expect(screenshareBtn.getAttribute("aria-pressed")).toBe("true");

    widget.destroy?.();
  });

  it("shows a stream card while sharing: source, Change source, Quality, Stop", async () => {
    setVoiceChannel(1, []);
    const onScreenshareToggle = vi.fn();
    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle,
    });
    widget.mount(container);
    const card = () => container.querySelector<HTMLElement>('[data-testid="vw-stream-card"]');
    await vi.dynamicImportSettled();
    expect(card()).toBeNull();

    voiceStore.setState((prev) => ({ ...prev, localScreenshare: true }));
    voiceStore.flush();
    await vi.dynamicImportSettled();
    expect(card()).not.toBeNull();
    expect(card()!.textContent).toContain("You're sharing a window");
    expect(card()!.textContent).not.toContain("window:42:0");

    const quality = card()!.querySelector<HTMLSelectElement>('[data-testid="vw-stream-quality"]')!;
    expect(quality.value).toBe("medium");
    quality.value = "high";
    quality.dispatchEvent(new Event("change"));
    expect(mockSetQuality).toHaveBeenCalledWith("high");

    card()!.querySelector<HTMLButtonElement>('[data-testid="vw-stream-change"]')!.click();
    expect(mockChangeSource).toHaveBeenCalledOnce();
    card()!.querySelector<HTMLButtonElement>('[data-testid="vw-stream-stop"]')!.click();
    expect(onScreenshareToggle).toHaveBeenCalledOnce();

    voiceStore.setState((prev) => ({ ...prev, localScreenshare: false }));
    voiceStore.flush();
    expect(card()).toBeNull();
    widget.destroy?.();
  });

  it("the stream card offers only Stop where the share cannot change", async () => {
    mockShareQuality.mockReturnValueOnce(null);
    mockCanChange.mockReturnValueOnce(false);
    setVoiceChannel(1, []);
    voiceStore.setState((prev) => ({ ...prev, localScreenshare: true }));
    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);
    await vi.dynamicImportSettled();
    const card = container.querySelector<HTMLElement>('[data-testid="vw-stream-card"]')!;
    expect(card.querySelector<HTMLElement>('[data-testid="vw-stream-change"]')!.hidden).toBe(true);
    expect(card.querySelector<HTMLElement>('[data-testid="vw-stream-quality"]')!.hidden).toBe(true);
    expect(card.querySelector<HTMLElement>('[data-testid="vw-stream-stop"]')!.hidden).toBe(false);
    widget.destroy?.();
  });

  it("the stream card offers Change source without Quality on a Linux share", async () => {
    mockShareQuality.mockReturnValueOnce(null);
    mockCanChange.mockReturnValueOnce(true);
    setVoiceChannel(1, []);
    voiceStore.setState((prev) => ({ ...prev, localScreenshare: true }));
    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);
    await vi.dynamicImportSettled();
    const card = container.querySelector<HTMLElement>('[data-testid="vw-stream-card"]')!;
    expect(card.querySelector<HTMLElement>('[data-testid="vw-stream-change"]')!.hidden).toBe(false);
    expect(card.querySelector<HTMLElement>('[data-testid="vw-stream-quality"]')!.hidden).toBe(true);
    widget.destroy?.();
  });

  it("the stream card shows the share's quality in the select and reverts a refused change", async () => {
    // A Linux share now carries its quality (the native track changes it), so
    // the card shows the select like a web share's.
    mockShareQuality.mockReturnValue("high");
    mockCanChange.mockReturnValueOnce(true);
    setVoiceChannel(1, []);
    voiceStore.setState((prev) => ({ ...prev, localScreenshare: true }));
    voiceStore.flush();
    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);
    await vi.dynamicImportSettled();
    const quality = container.querySelector<HTMLSelectElement>(
      '[data-testid="vw-stream-quality"]',
    )!;
    expect(quality.hidden).toBe(false);
    expect(quality.value).toBe("high");

    // The host refuses: the live quality stays "high", so the select goes back.
    quality.value = "low";
    quality.dispatchEvent(new Event("change"));
    expect(mockSetQuality).toHaveBeenCalledWith("low");
    await vi.waitFor(() => expect(quality.disabled).toBe(false));
    expect(quality.value).toBe("high");
    mockShareQuality.mockReturnValue("medium");
    widget.destroy?.();
  });

  it("cleans up on destroy", () => {
    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const root = container.querySelector('[data-testid="voice-widget"]');
    expect(root).not.toBeNull();

    widget.destroy?.();
    expect(container.querySelector('[data-testid="voice-widget"]')).toBeNull();
  });

  it("calls onCameraToggle when camera button is clicked", () => {
    const onCameraToggle = vi.fn();
    setVoiceChannel(1, []);

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle,
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const cameraBtn = container.querySelector('[aria-label="Camera"]') as HTMLButtonElement;
    expect(cameraBtn).not.toBeNull();
    cameraBtn.click();
    expect(onCameraToggle).toHaveBeenCalledOnce();

    widget.destroy?.();
  });

  it("calls onScreenshareToggle when screenshare button is clicked", () => {
    const onScreenshareToggle = vi.fn();
    setVoiceChannel(1, []);

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle,
    });
    widget.mount(container);

    const shareBtn = container.querySelector('[aria-label="Screenshare"]') as HTMLButtonElement;
    expect(shareBtn).not.toBeNull();
    shareBtn.click();
    expect(onScreenshareToggle).toHaveBeenCalledOnce();

    widget.destroy?.();
  });

  it("toggles camera active state based on store", () => {
    setVoiceChannel(1, []);
    voiceStore.setState((prev) => ({ ...prev, localCamera: true }));

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const cameraBtn = container.querySelector('[aria-label="Camera"]') as HTMLButtonElement;
    expect(cameraBtn.classList.contains("active-ctrl")).toBe(true);
    expect(cameraBtn.getAttribute("aria-pressed")).toBe("true");

    widget.destroy?.();
  });

  it("links the call's name back to the call, for a DM and a guild channel alike", () => {
    dmStore.setState(() => ({
      channels: [
        {
          channelId: 100,
          recipient: { id: 2, username: "otto", avatar: "", status: "online" },
          participants: [{ id: 2, username: "otto", avatar: "", status: "online" }],
          name: "",
          isGroup: false,
          lastMessageId: null,
          lastMessage: "",
          lastMessageAt: "",
          unreadCount: 0,
          mentionCount: 0,
        },
      ],
    }));
    setVoiceChannel(100, []);
    const onOpenCall = vi.fn();
    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
      onOpenCall,
    });
    widget.mount(container);

    const link = container.querySelector<HTMLButtonElement>("[data-testid='vw-channel-link']");
    expect(link?.textContent).toBe("otto");
    expect(link?.title).toBe("Go to the call");
    link!.click();
    expect(onOpenCall).toHaveBeenCalledWith(100);

    // A call whose channel is not known yet stays plain text.
    setVoiceChannel(999, []);
    voiceStore.flush();
    expect(container.querySelector("[data-testid='vw-channel-link']")).toBeNull();

    // A guild voice channel links too: it opens that channel's call view.
    channelsStore.setState((prev) => {
      const channels = new Map(prev.channels);
      channels.set(5, {
        id: 5,
        name: "Voice Lobby",
        type: "voice",
        category: null,
        position: 0,
        unreadCount: 0,
        mentionCount: 0,
        lastMessageId: null,
        canSend: true,
        topic: "",
        slowMode: 0,
        nsfw: false,
        isPrivate: false,
        voiceMaxUsers: 0,
        voiceMaxVideo: 0,
      });
      return { ...prev, channels };
    });
    setVoiceChannel(5, []);
    voiceStore.flush();
    const guildLink = container.querySelector<HTMLButtonElement>("[data-testid='vw-channel-link']");
    expect(guildLink?.textContent).toBe("Voice Lobby");
    guildLink!.click();
    expect(onOpenCall).toHaveBeenLastCalledWith(5);
    expect(container.querySelectorAll(".vw-channel")).toHaveLength(1);

    widget.destroy?.();
    dmStore.setState(() => ({ channels: [] }));
  });

  it("keeps the call's name as plain text when nothing can open the call", () => {
    setVoiceChannel(999, []);
    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);
    expect(container.querySelector("[data-testid='vw-channel-link']")).toBeNull();
    expect(container.querySelectorAll(".vw-channel")).toHaveLength(1);

    widget.destroy?.();
    dmStore.setState(() => ({ channels: [] }));
  });

  it("says what the camera and share buttons do next in their tooltips", () => {
    setVoiceChannel(1, []);
    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);
    const cameraBtn = container.querySelector('[aria-label="Camera"]') as HTMLButtonElement;
    const shareBtn = container.querySelector('[aria-label="Screenshare"]') as HTMLButtonElement;
    expect(cameraBtn.title).toBe("Turn on camera");
    expect(shareBtn.title).toBe("Share your screen");

    voiceStore.setState((prev) => ({ ...prev, localCamera: true, localScreenshare: true }));
    voiceStore.flush();
    expect(cameraBtn.title).toBe("Turn off camera");
    expect(shareBtn.title).toBe("Stop sharing");

    // A freeze reason still wins over the action.
    setConnectionStatus("reconnecting");
    uiStore.flush();
    expect(cameraBtn.title).toBe("Reconnecting…");
    expect(shareBtn.title).toBe("Reconnecting…");

    widget.destroy?.();
  });

  it("disables share with a reason when the grant leaves it out or the video limit is used up", () => {
    channelsStore.setState((prev) => {
      const channels = new Map(prev.channels);
      channels.set(1, {
        id: 1,
        name: "Voice Lobby",
        type: "voice",
        category: null,
        position: 0,
        unreadCount: 0,
        mentionCount: 0,
        lastMessageId: null,
        canSend: true,
        topic: "",
        slowMode: 0,
        nsfw: false,
        isPrivate: false,
        voiceMaxUsers: 0,
        voiceMaxVideo: 2,
      });
      return { ...prev, channels };
    });
    const user = (userId: number, camera: boolean, screenshare: boolean): VoiceUser => ({
      userId,
      username: `u${userId}`,
      muted: false,
      deafened: false,
      speaking: false,
      camera,
      screenshare,
    });
    setVoiceChannel(1, [user(1, false, false), user(2, true, false)]);
    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);
    const shareBtn = container.querySelector('[aria-label="Screenshare"]') as HTMLButtonElement;
    expect(shareBtn.disabled).toBe(false);

    voiceStore.setState((prev) => ({ ...prev, shareDenied: true }));
    voiceStore.flush();
    expect(shareBtn.disabled).toBe(true);
    expect(shareBtn.title).toBe("You don't have permission to share your screen here");

    voiceStore.setState((prev) => ({ ...prev, shareDenied: false }));
    setVoiceChannel(1, [user(1, false, false), user(2, true, false), user(3, false, true)]);
    voiceStore.flush();
    expect(shareBtn.disabled).toBe(true);
    expect(shareBtn.title).toBe("This channel has reached its video limit");

    // Your own share holds a slot: Stop sharing stays live at the limit.
    voiceStore.setState((prev) => ({ ...prev, localScreenshare: true }));
    voiceStore.flush();
    expect(shareBtn.disabled).toBe(false);
    expect(shareBtn.title).toBe("Stop sharing");

    widget.destroy?.();
  });

  it("falls back to 'Voice Channel' when channel is not in store", () => {
    // Don't add channel to channelsStore
    setVoiceChannel(999, []);

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const channelName = container.querySelector(".vw-channel");
    expect(channelName?.textContent).toBe("Voice Channel");

    widget.destroy?.();
  });

  it("shows 'Grant Microphone' button when in listen-only mode", () => {
    setVoiceChannel(1, []);
    voiceStore.setState((prev) => ({ ...prev, listenOnly: true }));

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const grantBtn = container.querySelector(".vw-grant-mic") as HTMLButtonElement;
    expect(grantBtn).not.toBeNull();
    expect(grantBtn.style.display).toBe("block");
    expect(grantBtn.textContent).toBe("Grant Microphone");

    widget.destroy?.();
  });

  it("hides 'Grant Microphone' button when not in listen-only mode", () => {
    setVoiceChannel(1, []);
    voiceStore.setState((prev) => ({ ...prev, listenOnly: false }));

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const grantBtn = container.querySelector(".vw-grant-mic") as HTMLButtonElement;
    expect(grantBtn.style.display).toBe("none");

    widget.destroy?.();
  });

  it("shows an actionable mic notice in listen-only mode and hides it otherwise", () => {
    setVoiceChannel(1, []);
    voiceStore.setState((prev) => ({ ...prev, listenOnly: true }));

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const notice = container.querySelector("[data-testid='vw-mic-notice']") as HTMLDivElement;
    expect(notice.getAttribute("role")).toBe("status");
    // No `setting-desc`: its `margin-top`/font rules apply even while this live
    // region is empty (it stays rendered), adding a stray gap to every voice
    // session and clobbering `.vw-mic-notice`'s own type.
    expect(notice.classList.contains("setting-desc")).toBe(false);
    expect(notice.textContent).toContain("Grant microphone access");

    // The state clears: the text goes, but the live region stays rendered so
    // a later listen-only join fills a region already in the a11y tree.
    voiceStore.setState((prev) => ({ ...prev, listenOnly: false }));
    voiceStore.flush();
    expect(notice.textContent).toBe("");
    expect(notice.style.display).not.toBe("none");
    expect(notice.isConnected).toBe(true);

    widget.destroy?.();
  });

  it("stops promising a permission grant once a retry leaves the mic unavailable", async () => {
    setVoiceChannel(1, []);
    voiceStore.setState((prev) => ({ ...prev, listenOnly: true }));

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const notice = container.querySelector("[data-testid='vw-mic-notice']") as HTMLDivElement;
    expect(notice.textContent).toContain("Grant microphone access");

    const grantBtn = container.querySelector(".vw-grant-mic") as HTMLButtonElement;
    grantBtn.click();

    // retryMicPermission is a no-op mock, so the store stays listen-only —
    // exactly the "retry failed" state. The notice must not keep implying
    // that clicking Grant Microphone is all that stands in the way.
    await vi.waitFor(() => {
      expect(notice.textContent).toContain("still unavailable");
    });

    widget.destroy?.();
  });

  it("clicking 'Grant Microphone' calls retryMicPermission", async () => {
    setVoiceChannel(1, []);
    voiceStore.setState((prev) => ({ ...prev, listenOnly: true }));

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const grantBtn = container.querySelector(".vw-grant-mic") as HTMLButtonElement;
    grantBtn.click();

    expect(mockRetryMicPermission).toHaveBeenCalledOnce();
    // Wait for the promise to resolve
    await vi.waitFor(() => {
      expect(grantBtn.textContent).toBe("Grant Microphone");
      expect(grantBtn.disabled).toBe(false);
    });

    widget.destroy?.();
  });

  it("displays stats pane toggle on signal icon click", () => {
    setVoiceChannel(1, []);

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const statsPane = container.querySelector(".vw-stats") as HTMLDivElement;
    expect(statsPane).not.toBeNull();
    // Initially hidden
    expect(statsPane.classList.contains("visible")).toBe(false);

    // Click signal icon to toggle stats visibility
    const signalWrap = container.querySelector(".vw-signal") as HTMLDivElement;
    signalWrap.click();
    expect(statsPane.classList.contains("visible")).toBe(true);

    // Click again to hide
    signalWrap.click();
    expect(statsPane.classList.contains("visible")).toBe(false);

    widget.destroy?.();
  });

  it("renders the signal readout as unavailable, not a false green, when no stats sample arrives", () => {
    const poller = createConnectionStatsPoller as unknown as ReturnType<typeof vi.fn>;
    poller.mockReturnValueOnce({
      start: vi.fn(),
      stop: vi.fn(),
      getStats: vi.fn().mockReturnValue({
        rtt: 0,
        quality: "excellent",
        outRate: 0,
        inRate: 0,
        outPackets: 0,
        inPackets: 0,
        totalUp: 0,
        totalDown: 0,
        available: false,
      }),
      onUpdate: vi.fn().mockReturnValue(() => {}),
      onQualityChanged: vi.fn().mockReturnValue(() => {}),
    });
    setVoiceChannel(1, []);

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const signalWrap = container.querySelector(".vw-signal") as HTMLButtonElement;
    expect(signalWrap.classList.contains("vw-signal--unavailable")).toBe(true);
    expect(container.querySelector(".vw-ping")!.textContent).toBe("—");

    widget.destroy?.();
  });

  it("displays elapsed timer element with initial 00:00", () => {
    setVoiceChannel(1, []);

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const timerEl = container.querySelector(".vw-timer");
    expect(timerEl).not.toBeNull();
    // Timer starts and updates; with joinedAt=null the timer shows "00:00"
    // or if joinedAt is set, shows elapsed
    expect(timerEl?.textContent).toMatch(/^\d{2}:\d{2}/);

    widget.destroy?.();
  });

  it("hides widget and stops timer when voice channel is left", () => {
    setVoiceChannel(1, []);

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const root = container.querySelector('[data-testid="voice-widget"]') as HTMLDivElement;
    expect(root.classList.contains("visible")).toBe(true);

    // Leave voice channel
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: null }));
    voiceStore.flush();

    expect(root.classList.contains("visible")).toBe(false);

    widget.destroy?.();
  });

  it("contains transport stats labels (Upload, Download, Session)", () => {
    setVoiceChannel(1, []);

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const statsPane = container.querySelector(".vw-stats") as HTMLDivElement;
    expect(statsPane.getAttribute("aria-label")).toBe("Transport Statistics");
    expect(statsPane.textContent).toContain("Upload");
    expect(statsPane.textContent).toContain("Download");
    expect(statsPane.textContent).toContain("Session");

    widget.destroy?.();
  });

  // --- E2EE / voice-session status (docs/architecture/ux/voice-and-e2ee.md §2) ---

  it("shows 'Connecting…' during the joining phase, no secured badge", () => {
    setVoiceChannel(1, []);

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    setVoiceStatus("joining");

    const status = container.querySelector('[data-testid="vw-status"]');
    const secured = container.querySelector('[data-testid="vw-secured"]') as HTMLElement;
    expect(status?.textContent).toBe("Connecting…");
    expect(secured.style.display).toBe("none");

    widget.destroy?.();
  });

  it("shows 'Securing…' while E2EE key exchange runs, no secured badge yet", () => {
    setVoiceChannel(1, []);

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    setVoiceStatus("securing");

    const status = container.querySelector('[data-testid="vw-status"]') as HTMLElement;
    const secured = container.querySelector('[data-testid="vw-secured"]') as HTMLElement;
    expect(status.textContent).toBe("Securing…");
    expect(status.classList.contains("vw-securing")).toBe(true);
    expect(secured.style.display).toBe("none");

    widget.destroy?.();
  });

  it("shows a persistent secured indicator once connected", () => {
    setVoiceChannel(1, []);

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    setVoiceStatus("connected");

    const status = container.querySelector('[data-testid="vw-status"]');
    const secured = container.querySelector('[data-testid="vw-secured"]') as HTMLElement;
    expect(status?.textContent).toBe("Voice Connected");
    expect(secured.style.display).toBe("inline-flex");
    expect(secured.textContent).toContain("Secured");

    widget.destroy?.();
  });

  // OC-0002: the badge was derived purely from voiceStatus === "connected",
  // never from the SDK's live encryption state — a dead E2EE worker that
  // fails asynchronously (after the key exchange and voiceStatus already
  // reached "connected") had no way to ever un-light the badge.
  it("shows a not-secured warning instead of the Secured badge once encryption degrades", () => {
    setVoiceChannel(1, []);

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    setVoiceStatus("connected");
    const secured = container.querySelector('[data-testid="vw-secured"]') as HTMLElement;
    expect(secured.textContent).toContain("Secured");

    voiceStore.setState((prev) => ({ ...prev, encryptionDegraded: true }));
    voiceStore.flush();

    // Still shown (so the warning is not silently missed), but no longer
    // claiming "Secured" — a dead worker must never look like a live one.
    expect(secured.style.display).toBe("inline-flex");
    expect(secured.textContent).not.toContain("Secured");

    widget.destroy?.();
  });

  it("shows 'Reconnecting voice…' during a voice reconnect", () => {
    setVoiceChannel(1, []);

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    setVoiceStatus("reconnecting");

    const status = container.querySelector('[data-testid="vw-status"]') as HTMLElement;
    const secured = container.querySelector('[data-testid="vw-secured"]') as HTMLElement;
    expect(status.textContent).toBe("Reconnecting voice…");
    expect(status.classList.contains("vw-reconnecting")).toBe(true);
    expect(secured.style.display).toBe("none");

    widget.destroy?.();
  });

  // --- Freeze controls during WS reconnect (docs/architecture/ux/README.md §3) ---

  it("keeps local hangup available while freezing WS controls during reconnect", () => {
    setVoiceChannel(1, []);
    const onDisconnect = vi.fn();
    const widget = createVoiceWidget({
      onDisconnect,
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    setConnectionStatus("reconnecting");
    uiStore.flush();

    const cameraBtn = container.querySelector('[aria-label="Camera"]') as HTMLButtonElement;
    const disconnectBtn = container.querySelector('[aria-label="Disconnect"]') as HTMLButtonElement;
    expect(cameraBtn.disabled).toBe(true);
    expect(cameraBtn.title).toBe("Reconnecting…");
    expect(disconnectBtn.disabled).toBe(false);
    disconnectBtn.click();
    expect(onDisconnect).toHaveBeenCalledOnce();

    widget.destroy?.();
  });

  it("shows 'Not connected' reason while the WS socket is disconnected", () => {
    setVoiceChannel(1, []);

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    setConnectionStatus("disconnected");
    uiStore.flush();

    const cameraBtn = container.querySelector('[aria-label="Camera"]') as HTMLButtonElement;
    expect(cameraBtn.disabled).toBe(true);
    expect(cameraBtn.title).toBe("Not connected");

    widget.destroy?.();
  });

  it("re-enables voice controls when the WS socket reconnects", () => {
    setVoiceChannel(1, []);

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    setConnectionStatus("reconnecting");
    uiStore.flush();
    const cameraBtn = container.querySelector('[aria-label="Camera"]') as HTMLButtonElement;
    expect(cameraBtn.disabled).toBe(true);

    setConnectionStatus("connected");
    uiStore.flush();
    expect(cameraBtn.disabled).toBe(false);
    expect(cameraBtn.title).toBe("Turn on camera");

    widget.destroy?.();
  });

  // D-08: a camera or share press before the room exists bounced off with a
  // "Join a voice channel first" toast; the controls wait for the connection.
  it("disables camera and screen share until the join has connected", () => {
    setVoiceChannel(1, []);
    setVoiceStatus("joining");
    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);
    const cameraBtn = container.querySelector('[aria-label="Camera"]') as HTMLButtonElement;
    expect(cameraBtn.disabled).toBe(true);
    expect(cameraBtn.title).toBe("Connecting…");

    setVoiceStatus("connected");
    expect(cameraBtn.disabled).toBe(false);
    expect(cameraBtn.title).toBe("Turn on camera");

    widget.destroy?.();
  });

  // OC-0225: the Grant-Microphone retry's `.finally` used to hardcode
  // `grantMicBtn.disabled = false`, undoing updateFrozen's socket-down
  // freeze if the WS socket dropped while the permission request was in
  // flight.
  it("keeps 'Grant Microphone' frozen if the WS socket drops while a mic request is in flight", async () => {
    setVoiceChannel(1, []);
    voiceStore.setState((prev) => ({ ...prev, listenOnly: true }));

    let resolveMic: () => void = () => {};
    mockRetryMicPermission.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveMic = resolve;
        }),
    );

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const grantBtn = container.querySelector(".vw-grant-mic") as HTMLButtonElement;
    grantBtn.click();
    expect(grantBtn.disabled).toBe(true);

    // WS socket drops while the permission request (OS/browser prompt) is
    // still pending.
    setConnectionStatus("reconnecting");
    uiStore.flush();
    expect(grantBtn.disabled).toBe(true);
    expect(grantBtn.title).toBe("Reconnecting…");

    // Permission request settles (retryMicPermission always resolves, even
    // on a denied prompt, per its internal try/catch).
    resolveMic();
    await vi.waitFor(() => {
      expect(grantBtn.textContent).toBe("Grant Microphone");
    });

    // The socket is still down: the button must stay frozen with the
    // reconnecting reason, not silently re-enabled.
    expect(grantBtn.disabled).toBe(true);
    expect(grantBtn.title).toBe("Reconnecting…");

    widget.destroy?.();
  });

  describe("noise suppression toggle", () => {
    beforeEach(() => {
      localStorage.clear();
      mockReapplyEnhanced.mockClear();
    });

    function mountWidget(): {
      widget: ReturnType<typeof createVoiceWidget>;
      btn: HTMLButtonElement;
    } {
      const widget = createVoiceWidget({
        onDisconnect: vi.fn(),
        onCameraToggle: vi.fn(),
        onScreenshareToggle: vi.fn(),
      });
      widget.mount(container);
      const btn = container.querySelector<HTMLButtonElement>('[data-testid="vw-ns"]')!;
      return { widget, btn };
    }

    it("flips the Enhanced Noise Suppression pref and re-routes the live mic", () => {
      const { widget, btn } = mountWidget();
      expect(btn.getAttribute("aria-label")).toBe("Enhanced Noise Suppression");
      expect(btn.getAttribute("aria-pressed")).toBe("false");

      btn.click();
      expect(loadPref("enhancedNoiseSuppression", false)).toBe(true);
      expect(mockReapplyEnhanced).toHaveBeenCalledTimes(1);
      expect(btn.getAttribute("aria-pressed")).toBe("true");

      btn.click();
      expect(loadPref("enhancedNoiseSuppression", true)).toBe(false);
      expect(mockReapplyEnhanced).toHaveBeenCalledTimes(2);
      expect(btn.getAttribute("aria-pressed")).toBe("false");

      widget.destroy?.();
    });

    it("labels the button the same on Linux native as elsewhere: it applies live", () => {
      const { widget, btn: other } = mountWidget();
      const label = other.getAttribute("aria-label");
      widget.destroy?.();
      mockIsLinuxDesktop.mockReturnValue(true);
      try {
        const { widget: linux, btn } = mountWidget();
        expect(btn.getAttribute("aria-label")).toBe(label);
        expect(label).not.toMatch(/next time you join/);
        linux.destroy?.();
      } finally {
        mockIsLinuxDesktop.mockReturnValue(false);
      }
    });

    it("starts from the saved pref and follows a change made in Settings", () => {
      savePref("enhancedNoiseSuppression", true);
      const { widget, btn } = mountWidget();
      expect(btn.getAttribute("aria-pressed")).toBe("true");

      savePref("enhancedNoiseSuppression", false);
      expect(btn.getAttribute("aria-pressed")).toBe("false");
      expect(mockReapplyEnhanced).not.toHaveBeenCalled();

      widget.destroy?.();
      savePref("enhancedNoiseSuppression", true);
      expect(btn.getAttribute("aria-pressed")).toBe("false");
    });
  });
});
