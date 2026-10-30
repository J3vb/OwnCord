/**
 * The voice widget loads when the user is first in voice (O-6b). Each test
 * builds a fresh module graph so the widget's import can be held open.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  gate: null as null | { promise: Promise<void>; open: () => void; fail: () => void },
  loads: { value: 0 },
}));

vi.mock("@lib/voice/livekitSession", () => ({
  leaveVoice: vi.fn(),
  switchInputDevice: vi.fn().mockResolvedValue(undefined),
  switchOutputDevice: vi.fn().mockResolvedValue(undefined),
  setVoiceSensitivity: vi.fn(),
  setInputVolume: vi.fn(),
  setOutputVolume: vi.fn(),
  reapplyAudioProcessing: vi.fn().mockResolvedValue(undefined),
  getRoomForStats: vi.fn().mockReturnValue(null),
  reapplyEnhancedNoiseSuppression: vi.fn().mockResolvedValue(undefined),
  retryMicPermission: vi.fn().mockResolvedValue(undefined),
  getSessionDebugInfo: vi.fn().mockReturnValue({}),
  setMuted: vi.fn(),
  setDeafened: vi.fn(),
  enableCamera: vi.fn().mockResolvedValue(undefined),
  disableCamera: vi.fn().mockResolvedValue(undefined),
  enableScreenshare: vi.fn().mockResolvedValue(undefined),
  disableScreenshare: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  getLogBuffer: () => [],
  clearLogBuffer: vi.fn(),
  addLogListener: () => () => {},
  setLogLevel: vi.fn(),
}));

vi.mock("@lib/toast", () => ({
  showToast: vi.fn(),
}));

vi.mock("@lib/profiles", () => ({
  createProfileManager: vi.fn().mockReturnValue({
    loadProfiles: vi.fn().mockResolvedValue(undefined),
    getAll: vi.fn().mockReturnValue([]),
    store: { getState: () => ({ profiles: [], healthStatuses: new Map() }) },
  }),
  createTauriBackend: vi.fn().mockReturnValue({}),
}));

vi.mock("@components/ChannelSidebar", () => ({
  createChannelSidebar: vi.fn().mockReturnValue({
    mount: vi.fn(),
    destroy: vi.fn(),
  }),
}));

vi.mock("@components/DmSidebar", () => ({
  createDmSidebar: vi.fn().mockReturnValue({
    mount: vi.fn(),
    destroy: vi.fn(),
    update: vi.fn(),
  }),
}));

vi.mock("@components/MemberList", () => ({
  createMemberList: vi.fn().mockReturnValue({
    mount: vi.fn(),
    destroy: vi.fn(),
  }),
}));

vi.mock("@components/UserBar", () => ({
  createUserBar: vi.fn().mockReturnValue({
    mount: vi.fn(),
    destroy: vi.fn(),
  }),
}));

vi.mock("@components/QuickSwitchOverlay", () => ({
  createQuickSwitchOverlay: vi.fn().mockReturnValue({
    mount: vi.fn(),
    destroy: vi.fn(),
  }),
}));

const mockOpenUrl = vi.fn(async (_url: string) => {});
// The opener is the `open_external_url` command; `mockOpenUrl` records its URL.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args?: { url: string }) => {
    if (command !== "open_external_url") throw new Error(`unexpected invoke ${command}`);
    return mockOpenUrl(args!.url);
  },
}));

vi.mock("@components/EditChannelModal", () => ({
  createEditChannelModal: vi.fn().mockReturnValue({
    mount: vi.fn(),
    destroy: vi.fn(),
  }),
}));

vi.mock("@components/DeleteChannelModal", () => ({
  createDeleteChannelModal: vi.fn().mockReturnValue({
    mount: vi.fn(),
    destroy: vi.fn(),
  }),
}));

vi.mock("../../src/pages/main-page/VoiceCallbacks", () => ({
  createVoiceWidgetCallbacks: vi.fn().mockReturnValue({
    onDisconnect: vi.fn(),
    onMuteToggle: vi.fn(),
    onDeafenToggle: vi.fn(),
    onCameraToggle: vi.fn(),
    onScreenshareToggle: vi.fn(),
  }),
  createSidebarVoiceCallbacks: vi.fn().mockReturnValue({
    onVoiceJoin: vi.fn(),
    onVoiceLeave: vi.fn(),
  }),
  createVoiceModerationCallbacks: vi.fn().mockReturnValue({
    onServerMute: vi.fn(),
    onServerDeafen: vi.fn(),
    onMove: vi.fn(),
    onDisconnect: vi.fn(),
  }),
}));

vi.mock("../../src/pages/main-page/OverlayManagers", () => ({
  createInviteManagerController: vi.fn().mockReturnValue({
    open: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn(),
  }),
}));

import type { SidebarAreaOptions } from "../../src/pages/main-page/SidebarArea";

function defaultOpts(): SidebarAreaOptions {
  return {
    ws: {
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(() => vi.fn()),
      off: vi.fn(),
    } as unknown as SidebarAreaOptions["ws"],
    api: {
      createDm: vi.fn().mockResolvedValue({
        channel_id: 200,
        recipient: { id: 20, username: "Bob", avatar: "", status: "online" },
      }),
      closeDm: vi.fn().mockResolvedValue(undefined),
      getInvites: vi.fn().mockResolvedValue([]),
      createInvite: vi
        .fn()
        .mockResolvedValue({ code: "abc", expires_at: "", max_uses: 0, use_count: 0 }),
      revokeInvite: vi.fn().mockResolvedValue(undefined),
      adminCreateChannel: vi.fn().mockResolvedValue(undefined),
      adminUpdateChannel: vi.fn().mockResolvedValue(undefined),
      adminDeleteChannel: vi.fn().mockResolvedValue(undefined),
      purgeMessages: vi.fn().mockResolvedValue({ channel_id: 1, ids: [3, 2], count: 2 }),
      adminKickMember: vi.fn().mockResolvedValue(undefined),
      adminBanMember: vi.fn().mockResolvedValue(undefined),
      adminChangeRole: vi.fn().mockResolvedValue(undefined),
      getConfig: vi.fn().mockReturnValue({ host: "localhost:8080" }),
    } as unknown as SidebarAreaOptions["api"],
    limiters: {
      voice: { tryConsume: vi.fn().mockReturnValue(true) },
      voiceVideo: { tryConsume: vi.fn().mockReturnValue(true) },
    } as unknown as SidebarAreaOptions["limiters"],
    presenceSender: {
      send: vi.fn(),
      rollbackRefused: vi.fn(),
      destroy: vi.fn(),
    },
    getRoot: vi.fn().mockReturnValue(document.createElement("div")),
    getToast: vi.fn().mockReturnValue({ show: vi.fn() }),
  };
}

type SidebarModule = typeof import("../../src/pages/main-page/SidebarArea");
type VoiceStore = typeof import("../../src/stores/voice.store");

function makeGate(): NonNullable<typeof h.gate> {
  let open!: () => void;
  let fail!: () => void;
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = () => reject(new Error("chunk load failed"));
  });
  promise.catch(() => {});
  return { promise, open, fail };
}

describe("SidebarArea voice widget", () => {
  let container: HTMLDivElement;
  let result: ReturnType<SidebarModule["createSidebarArea"]> | null = null;
  let sidebar: SidebarModule;
  let voice: VoiceStore;
  let toast: typeof import("@lib/toast");

  beforeAll(async () => {
    sidebar = await import("../../src/pages/main-page/SidebarArea");
    voice = await import("../../src/stores/voice.store");
    toast = await import("@lib/toast");
  });
  beforeEach(() => {
    voice.resetVoiceStore();
    h.gate = makeGate();
    h.loads.value = 0;
    // A gated stand-in for the lazy chunk that still yields the real widget.
    vi.doUnmock("@components/VoiceWidget");
    vi.doMock("@components/VoiceWidget", async () => {
      h.loads.value += 1;
      await h.gate!.promise;
      return await vi.importActual<object>("@components/VoiceWidget");
    });
    vi.mocked(toast.showToast).mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    if (result !== null) {
      for (const c of result.children) c.destroy?.();
      for (const unsub of result.unsubscribers) unsub();
      result = null;
    }
    container.remove();
    vi.doUnmock("@components/VoiceWidget");
  });

  function build(): void {
    result = sidebar.createSidebarArea(defaultOpts());
    container.appendChild(result.sidebarWrapper);
  }

  function join(id: number): void {
    voice.joinVoiceChannel(id);
    voice.voiceStore.flush();
  }
  function leave(): void {
    voice.leaveVoiceChannel();
    voice.voiceStore.flush();
  }

  const widgetEl = (): HTMLElement | null => container.querySelector(".voice-widget");

  it("a failed import toasts once and a channel switch tries again", async () => {
    build();
    join(5);
    h.gate!.fail();
    await vi.waitFor(() => expect(toast.showToast).toHaveBeenCalledTimes(1));
    expect(widgetEl()).toBeNull();

    h.gate = makeGate();
    join(6);
    h.gate.open();
    await vi.waitFor(() => expect(widgetEl()).not.toBeNull());
  });

  it("does not load until the user is in voice", async () => {
    build();
    await Promise.resolve();
    expect(h.loads.value).toBe(0);
    expect(widgetEl()).toBeNull();
  });

  it("loads when the voice channel becomes set and mounts once it arrives", async () => {
    build();
    join(5);
    await vi.waitFor(() => expect(h.loads.value).toBe(1));
    expect(widgetEl()).toBeNull();
    h.gate!.open();
    await vi.waitFor(() => expect(widgetEl()).not.toBeNull());
  });

  it("loads at build time when a channel is already set (auto-join at boot)", async () => {
    join(5);
    build();
    await vi.waitFor(() => expect(h.loads.value).toBe(1));
    h.gate!.open();
    await vi.waitFor(() => expect(widgetEl()).not.toBeNull());
  });

  it("renders the state that existed before the module arrived", async () => {
    build();
    join(5);
    voice.setVoiceStatus("connected");
    voice.voiceStore.flush();
    h.gate!.open();
    await vi.waitFor(() => expect(widgetEl()).not.toBeNull());
    expect(widgetEl()!.classList.contains("visible")).toBe(true);
    // And it stays in step afterwards.
    leave();
    voice.voiceStore.flush();
    await vi.waitFor(() => expect(widgetEl()!.classList.contains("visible")).toBe(false));
  });

  it("loads once across a leave and a rejoin during the load", async () => {
    build();
    join(5);
    leave();
    join(6);
    h.gate!.open();
    await vi.waitFor(() => expect(widgetEl()).not.toBeNull());
    expect(container.querySelectorAll(".voice-widget")).toHaveLength(1);
    await vi.waitFor(() => expect(h.loads.value).toBe(1));
  });

  it("mounts nothing when the sidebar is torn down before the code arrives", async () => {
    build();
    join(5);
    for (const unsub of result!.unsubscribers) unsub();
    h.gate!.open();
    await new Promise((r) => setTimeout(r, 0));
    expect(widgetEl()).toBeNull();
    expect(toast.showToast).not.toHaveBeenCalled();
  });

  it("page teardown (build-time copies of children and unsubscribers) destroys a late-loaded widget", async () => {
    build();
    // What MainPage does: copy both lists once, before the widget loads.
    const children = [...result!.children];
    const unsubs = [...result!.unsubscribers];
    join(5);
    h.gate!.open();
    await vi.waitFor(() => expect(widgetEl()).not.toBeNull());

    for (const c of children) c.destroy?.();
    for (const u of unsubs) u();

    // The widget is removed, and a later state change does not bring it back.
    // (The lifecycle guard also fails this test if its window listener or
    // elapsed interval were left live.)
    expect(widgetEl()).toBeNull();
    leave();
    join(7);
    expect(widgetEl()).toBeNull();
  });
});
