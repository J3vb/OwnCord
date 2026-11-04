/**
 * The voice widget loads when the user is first in voice (O-6b). Each test
 * builds a fresh module graph so the widget's import can be held open.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { useMountContainer } from "../helpers/mountContainer";
import * as mocks from "../helpers/sidebarAreaMocks";
import { defaultSidebarAreaOpts } from "../helpers/sidebarAreaOpts";
import * as voiceSession from "../helpers/voiceSessionMock";
import { makeGate, type ChunkGate } from "../helpers/chunkGate";

const h = vi.hoisted(() => ({
  gate: null as null | ChunkGate,
  loads: { value: 0 },
}));

vi.mock("@lib/voice/livekitSession", () =>
  voiceSession.withOverrides({
    switchInputDevice: vi.fn().mockResolvedValue(undefined),
    switchOutputDevice: vi.fn().mockResolvedValue(undefined),
    reapplyEnhancedNoiseSuppression: vi.fn().mockResolvedValue(undefined),
  }),
);

vi.mock("@lib/logger", () => mocks.loggerMock());

vi.mock("@lib/ui/toast", () => mocks.uiToastMock());

vi.mock("@lib/presence/profiles", () => mocks.presenceProfilesMock());

vi.mock("@components/ChannelSidebar", () => mocks.channelSidebarMock());

vi.mock("@components/DmSidebar", () => mocks.dmSidebarMock());

vi.mock("@components/MemberList", () => mocks.memberListMock());

vi.mock("@components/UserBar", () => mocks.userBarMock());

vi.mock("@components/QuickSwitchOverlay", () => mocks.quickSwitchOverlayMock());

vi.mock("@tauri-apps/api/core", () => mocks.apiCoreMock());

vi.mock("@components/EditChannelModal", () => mocks.editChannelModalMock());

vi.mock("@components/DeleteChannelModal", () => mocks.deleteChannelModalMock());

vi.mock("../../src/pages/main-page/VoiceCallbacks", () => mocks.pageVoiceCallbacksMock());

vi.mock("../../src/pages/main-page/OverlayManagers", () => mocks.pageOverlayManagersMock());

type SidebarModule = typeof import("../../src/pages/main-page/SidebarArea");
type VoiceStore = typeof import("../../src/stores/voice.store");

describe("SidebarArea voice widget", () => {
  let container: HTMLDivElement;
  let result: ReturnType<SidebarModule["createSidebarArea"]> | null = null;
  let sidebar: SidebarModule;
  let voice: VoiceStore;
  let toast: typeof import("@lib/ui/toast");

  beforeAll(async () => {
    sidebar = await import("../../src/pages/main-page/SidebarArea");
    voice = await import("../../src/stores/voice.store");
    toast = await import("@lib/ui/toast");
  });
  useMountContainer(
    (c) => {
      container = c;
    },
    () => {
      if (result !== null) {
        for (const c of result.children) c.destroy?.();
        for (const unsub of result.unsubscribers) unsub();
        result = null;
      }
      vi.doUnmock("@components/VoiceWidget");
    },
  );

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
  });

  function build(): void {
    result = sidebar.createSidebarArea(defaultSidebarAreaOpts());
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
