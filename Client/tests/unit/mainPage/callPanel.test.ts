import { describe, it, expect, vi, afterEach } from "vitest";
import * as mocks from "../../helpers/mainPageMocks";
import { createMainPage } from "../../../src/pages/MainPage";
import { channelsStore } from "../../../src/stores/channels.store";
import { uiStore } from "../../../src/stores/ui.store";
import { voiceStore, type VoiceUser } from "../../../src/stores/voice.store";
import { desktop } from "../../../src/platform/desktop";
import { SCREENSHARE_TILE_ID_OFFSET } from "../../../src/lib/constants";
import {
  fakeWs,
  useMainPageHarness,
  mountPage,
  voiceUser,
  connectedDm,
  mountSettled,
  callPanelEl,
  incomingBannerEl,
  roster,
} from "../../helpers/mainPageHarness";

vi.mock("../../../src/features/content-consent/external", (importOriginal) =>
  mocks.consentExternalMock(importOriginal),
);
vi.mock("@lib/logger", () => mocks.loggerMock());
vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());
vi.mock("@lib/media/notificationSound", () => mocks.mediaNotificationSoundMock());
vi.mock("../../../src/features/direct-messages/callAlerts", () => mocks.messagesCallAlertsMock());
vi.mock("@components/UpdateNotifier", () => mocks.updateNotifierMock());
vi.mock("@lib/voice/audioElements", () => mocks.voiceAudioElementsMock());
vi.mock("@lib/presence/autoIdle", () => mocks.presenceAutoIdleMock());
vi.mock("../../../src/features/messaging/content/attachments", (importOriginal) =>
  mocks.listAttachmentsMock(importOriginal),
);
vi.mock("../../../src/pages/main-page/ChannelController", () => mocks.pageChannelControllerMock());
vi.mock("../../../src/pages/main-page/SidebarArea", () => mocks.pageSidebarAreaMock());
vi.mock("../../../src/features/navigation/destinations", () => mocks.navigationDestinationsMock());
vi.mock("../../../src/pages/main-page/ChatArea", () => mocks.pageChatAreaMock());

const { capturedChatAreaRef } = mocks;

describe("MainPage — video grid, DM profile panel, calls, settings", () => {
  let container: HTMLDivElement;
  let page: ReturnType<typeof createMainPage>;

  useMainPageHarness({
    wired: (c) => {
      container = c;
    },
    currentPage: () => page,
  });

  it("answers a ring for the open DM in the call panel and hides the banner, handing it back when you look elsewhere", async () => {
    const ws = fakeWs();
    connectedDm(50);
    page = await mountSettled(container, ws);

    ws.emit("call_incoming", { channel_id: 50, from_user: 10, username: "bob" });

    const banner = incomingBannerEl();
    const panel = callPanelEl();
    expect(panel.dataset.state).toBe("incoming");
    expect(banner.style.display).toBe("none");

    // Another channel on screen: the banner is the only way to answer.
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 7 }));
    channelsStore.flush();
    expect(banner.style.display).not.toBe("none");

    // Settings over the DM hides the panel, so the banner answers there too.
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 50 }));
    channelsStore.flush();
    expect(banner.style.display).toBe("none");
    uiStore.setState((prev) => ({ ...prev, settingsOpen: true }));
    uiStore.flush();
    expect(banner.style.display).not.toBe("none");
  });

  it("shows the DM's own call video in its panel, keeping the chat in view", async () => {
    connectedDm(50);
    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 50,
      voiceUsers: new Map([
        [
          50,
          new Map([
            [1, voiceUser(1, { username: "alice" })],
            [10, voiceUser(10, { username: "bob", screenshare: true })],
          ]),
        ],
      ]),
      localCamera: true,
    }));
    page = await mountSettled(container);
    voiceStore.flush();

    const slots = capturedChatAreaRef.current!.slots;
    const panelVideo = document.querySelector('[data-testid="dcp-video"]');
    expect(panelVideo).not.toBeNull();
    expect(panelVideo!.contains(slots.videoGridSlot)).toBe(true);
    // Your own camera no longer takes over the DM's chat.
    expect(slots.messagesSlot.style.display).toBe("");
    expect(slots.inputSlot.style.display).toBe("");

    // Opening another channel hands the grid back to the chat column.
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 7 }));
    channelsStore.flush();
    expect(panelVideo!.contains(slots.videoGridSlot)).toBe(false);

    page.destroy?.();
  });

  it("keeps the DM call panel's video up across repeated video changes, never switching it off in between", async () => {
    connectedDm(50);
    const alice = voiceUser(1, { username: "alice" });
    const bob = (extra: Partial<VoiceUser> = {}) => voiceUser(10, { username: "bob", ...extra });
    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 50,
      voiceUsers: roster(50, [alice, bob({ screenshare: true })]),
    }));
    page = await mountSettled(container);
    voiceStore.flush();

    const mute = document.querySelector('[data-testid="dcp-mute"]');
    expect(mute).not.toBeNull();
    const setPeople = capturedChatAreaRef.current!.videoGrid.setPeople;
    setPeople.mockClear();

    for (const extra of [{ screenshare: true, camera: true }, { screenshare: true }]) {
      voiceStore.setState((prev) => ({
        ...prev,
        voiceUsers: roster(50, [alice, bob(extra)]),
      }));
      voiceStore.flush();
    }

    expect(setPeople).not.toHaveBeenCalledWith([]);
    expect(document.querySelector('[data-testid="dcp-mute"]')).toBe(mute);

    page.destroy?.();
  });

  it("joining voice calls ensureLoaded once per channel, not on every voice update", () => {
    page = mountPage(container);
    const ensureLoaded = capturedChatAreaRef.current!.videoGrid.ensureLoaded;
    expect(ensureLoaded).not.toHaveBeenCalled();

    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 9 }));
    voiceStore.flush();
    expect(ensureLoaded).toHaveBeenCalledTimes(1);

    // Other voice updates in the same channel do not ask again.
    voiceStore.setState((prev) => ({ ...prev, localMuted: !prev.localMuted }));
    voiceStore.flush();
    expect(ensureLoaded).toHaveBeenCalledTimes(1);

    // A leave asks nothing; the next join (a retry after a failed import) does.
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: null }));
    voiceStore.flush();
    expect(ensureLoaded).toHaveBeenCalledTimes(1);
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 9 }));
    voiceStore.flush();
    expect(ensureLoaded).toHaveBeenCalledTimes(2);
  });

  it("rings the video tiles of whoever is speaking in the current call", () => {
    page = mountPage(container);
    const grid = capturedChatAreaRef.current!.videoGrid;

    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 9,
      voiceUsers: new Map([
        [
          9,
          new Map([
            [10, voiceUser(10, { username: "bob", speaking: true, camera: true })],
            [11, voiceUser(11, { username: "cy", camera: true })],
          ]),
        ],
      ]),
    }));
    voiceStore.flush();

    const last = grid.setSpeaking.mock.calls.at(-1)![0] as ReadonlySet<number>;
    expect([...last]).toEqual([10]);
  });

  it("wires full screen, the full-screen call controls, stream stats and video views into the video grid", async () => {
    const lk = await import("@lib/voice/livekitSession");
    const setFullscreen = vi.spyOn(desktop.window, "setFullscreen").mockResolvedValue(undefined);
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    page = mountPage(container, ws);
    const grid = capturedChatAreaRef.current!.videoGrid;
    const cbs = grid.setCallbacks.mock.calls.at(-1)![0] as {
      setWindowFullscreen: (on: boolean) => Promise<void>;
      callControls: {
        onMuteToggle: () => void;
        onDeafenToggle: () => void;
        onLeave: () => void;
        onCameraToggle: () => void;
        onScreenshareToggle: () => void;
      };
      getStreamStats: (tileId: number) => Promise<unknown>;
      getLocalShareStats: () => Promise<unknown>;
      setStreamView: (tileId: number, view: { enabled: boolean }) => void;
    };

    await cbs.setWindowFullscreen(true);
    expect(setFullscreen).toHaveBeenCalledWith(true);

    // Stats for a screen-share tile ask for that user's screen share.
    await cbs.getStreamStats(10 + SCREENSHARE_TILE_ID_OFFSET);
    expect(lk.getRemoteVideoStats).toHaveBeenLastCalledWith(10, "screenshare");
    await cbs.getStreamStats(10);
    expect(lk.getRemoteVideoStats).toHaveBeenLastCalledWith(10, "camera");
    // Your own share's tile reads the rate it is sending.
    await expect(cbs.getLocalShareStats()).resolves.toEqual({ sentFps: 57 });
    // A tile's view goes to that user's screen share or camera the same way.
    cbs.setStreamView(10 + SCREENSHARE_TILE_ID_OFFSET, { enabled: false });
    expect(lk.setRemoteVideoView).toHaveBeenLastCalledWith(10, "screenshare", { enabled: false });
    cbs.setStreamView(10, { enabled: true });
    expect(lk.setRemoteVideoView).toHaveBeenLastCalledWith(10, "camera", { enabled: true });

    // Leave from a full-screen tile leaves the call.
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 9 }));
    cbs.callControls.onLeave();
    expect(ws.send).toHaveBeenCalledWith({ type: "voice_leave", payload: {} });

    // The full-screen controls show your mute state.
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 9, localMuted: true }));
    voiceStore.flush();
    expect(grid.setCallState).toHaveBeenLastCalledWith({
      muted: true,
      deafened: false,
      listenOnly: false,
      camera: false,
      screenshare: false,
      connecting: false,
      serverMuted: false,
      serverDeafened: false,
    });
    // Joined without a microphone: the controls read listen-only.
    voiceStore.setState((prev) => ({ ...prev, localMuted: false, listenOnly: true }));
    voiceStore.flush();
    expect(grid.setCallState).toHaveBeenLastCalledWith({
      muted: false,
      deafened: false,
      listenOnly: true,
      camera: false,
      screenshare: false,
      connecting: false,
      serverMuted: false,
      serverDeafened: false,
    });
    // The call view's control bar shows your camera and share state, and
    // holds them inert while the join is still connecting.
    voiceStore.setState((prev) => ({
      ...prev,
      listenOnly: false,
      localCamera: true,
      localScreenshare: true,
      voiceStatus: "joining",
    }));
    voiceStore.flush();
    expect(grid.setCallState).toHaveBeenLastCalledWith({
      muted: false,
      deafened: false,
      listenOnly: false,
      camera: true,
      screenshare: true,
      connecting: true,
      serverMuted: false,
      serverDeafened: false,
    });
    // Its camera and share buttons run the same toggles as the voice widget.
    voiceStore.setState((prev) => ({
      ...prev,
      localCamera: false,
      localScreenshare: false,
      voiceStatus: "connected",
    }));
    // A moderator mute and a dropped chat socket reach the bar too.
    voiceStore.setState((prev) => ({ ...prev, localServerMuted: true }));
    voiceStore.flush();
    expect(grid.setCallState).toHaveBeenLastCalledWith(
      expect.objectContaining({ serverMuted: true }),
    );
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "reconnecting" }));
    uiStore.flush?.();
    expect(grid.setCallState).toHaveBeenLastCalledWith(
      expect.objectContaining({ offline: "reconnecting" }),
    );
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    uiStore.flush?.();
    expect(grid.setCallState).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ offline: expect.anything() }),
    );
    voiceStore.setState((prev) => ({ ...prev, localServerMuted: false }));
    cbs.callControls.onCameraToggle();
    expect(lk.enableCamera).toHaveBeenCalledTimes(1);
    cbs.callControls.onScreenshareToggle();
    expect(lk.enableScreenshare).toHaveBeenCalledTimes(1);
    setFullscreen.mockRestore();
  });

  it("toggles mute and deafen from a global shortcut while unfocused (U6)", async () => {
    const shortcutHandlers = new Set<(action: "mute" | "deafen") => void>();
    const onShortcut = vi
      .spyOn(desktop.globalShortcuts, "onShortcut")
      .mockImplementation((handler) => {
        shortcutHandlers.add(handler);
        return () => shortcutHandlers.delete(handler);
      });
    const start = vi.spyOn(desktop.globalShortcuts, "start").mockResolvedValue(undefined);
    const supported = vi.spyOn(desktop.globalShortcuts, "supported").mockResolvedValue(true);
    const ws = fakeWs();
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 9, localMuted: false }));
    page = mountPage(container, ws);

    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    for (const handler of shortcutHandlers) handler("mute");

    // The same toggle the in-app Ctrl+M runs: muting sends voice_mute(true).
    expect(ws.send).toHaveBeenCalledWith({ type: "voice_mute", payload: { muted: true } });

    onShortcut.mockRestore();
    start.mockRestore();
    supported.mockRestore();
  });

  it("toggles once on a focused Ctrl+Shift+M while the global poller runs (1A-5)", async () => {
    const start = vi.spyOn(desktop.globalShortcuts, "start").mockResolvedValue(undefined);
    const supported = vi.spyOn(desktop.globalShortcuts, "supported").mockResolvedValue(true);
    const ws = fakeWs();
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 9, localMuted: false }));
    page = mountPage(container, ws);
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    // jsdom loads no CSS, so the closed Settings panel would read as an open dialog.
    (document.querySelector(".settings-panel") as HTMLElement).style.display = "none";

    // The poller sees the press and emits the shortcut; the in-app handler must not also toggle.
    const event = new KeyboardEvent("keydown", {
      key: "M",
      code: "KeyM",
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    });
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(ws.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "voice_mute" }));
    expect(voiceStore.getState().localMuted).toBe(false);

    start.mockRestore();
    supported.mockRestore();
  });

  it("keeps standing down after a remount while the running poller is re-checked (1A-5)", async () => {
    const start = vi.spyOn(desktop.globalShortcuts, "start").mockResolvedValue(undefined);
    const supported = vi.spyOn(desktop.globalShortcuts, "supported").mockResolvedValue(true);
    const ws = fakeWs();
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 9, localMuted: false }));
    page = mountPage(container, ws);
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    page.destroy?.();

    // A logout or server switch remounts the page; the native poller is still live.
    supported.mockReturnValue(new Promise<boolean>(() => {}));
    page = mountPage(container, ws);
    (document.querySelector(".settings-panel") as HTMLElement).style.display = "none";
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "M", code: "KeyM", ctrlKey: true, shiftKey: true }),
    );

    expect(ws.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "voice_mute" }));

    start.mockRestore();
    supported.mockRestore();
  });

  it("toggles mute in-app on Ctrl+Shift+M where global keys are unsupported (1A-5)", async () => {
    const start = vi.spyOn(desktop.globalShortcuts, "start").mockResolvedValue(undefined);
    const supported = vi.spyOn(desktop.globalShortcuts, "supported").mockResolvedValue(false);
    const ws = fakeWs();
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 9, localMuted: false }));
    page = mountPage(container, ws);
    await vi.waitFor(() => expect(supported).toHaveBeenCalled());
    await Promise.resolve();
    (document.querySelector(".settings-panel") as HTMLElement).style.display = "none";

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "M", code: "KeyM", ctrlKey: true, shiftKey: true }),
    );

    // The host decides whether anything observes keys; the in-app key still answers.
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(ws.send).toHaveBeenCalledWith({ type: "voice_mute", payload: { muted: true } });

    start.mockRestore();
    supported.mockRestore();
  });

  describe("Wayland portal keys", () => {
    const portal = {
      backend: "portal" as const,
      portalVersion: 2,
      triggers: { ptt: null, mute: null, deafen: null },
      canConfigure: true,
      triggersUnnamed: false,
      sessionRefused: false,
    };
    // Spies on the shared registry would otherwise carry their calls into the next test.
    const restore = ["status", "bindPortal", "supported", "start", "onStatusChange"] as const;
    afterEach(() => {
      localStorage.removeItem("owncord:settings:globalKeysPortalBound");
      for (const name of restore) vi.mocked(desktop.globalShortcuts[name]).mockRestore?.();
    });

    it("restores the portal binding at startup only after an earlier successful bind", async () => {
      const status = vi.spyOn(desktop.globalShortcuts, "status").mockResolvedValue(portal);
      const bind = vi.spyOn(desktop.globalShortcuts, "bindPortal").mockResolvedValue(portal);
      vi.spyOn(desktop.globalShortcuts, "supported").mockResolvedValue(false);

      // Never bound before: no dialog is opened on its own.
      page = mountPage(container);
      await vi.waitFor(() => expect(status).toHaveBeenCalled());
      await Promise.resolve();
      expect(bind).not.toHaveBeenCalled();
      page.destroy?.();

      localStorage.setItem("owncord:settings:globalKeysPortalBound", "true");
      localStorage.setItem("owncord:settings:pttVk", String(0x77));
      page = mountPage(container);
      await vi.waitFor(() => expect(bind).toHaveBeenCalledTimes(1));
      expect(bind).toHaveBeenCalledWith({ pttVk: 0x77, muteVk: 0x4d, deafenVk: 0x44 });
      localStorage.removeItem("owncord:settings:pttVk");
    });

    it("does not reopen the dialog when the desktop already holds a trigger", async () => {
      localStorage.setItem("owncord:settings:globalKeysPortalBound", "true");
      const status = vi.spyOn(desktop.globalShortcuts, "status").mockResolvedValue({
        ...portal,
        triggers: { ptt: null, mute: "Ctrl+Alt+M", deafen: null },
      });
      const bind = vi.spyOn(desktop.globalShortcuts, "bindPortal").mockResolvedValue(portal);
      vi.spyOn(desktop.globalShortcuts, "supported").mockResolvedValue(false);
      page = mountPage(container);
      await vi.waitFor(() => expect(status).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(bind).not.toHaveBeenCalled();
    });

    it("forgets the earlier bind when the restore dialog is cancelled, and keeps it on other failures", async () => {
      vi.spyOn(desktop.globalShortcuts, "status").mockResolvedValue(portal);
      vi.spyOn(desktop.globalShortcuts, "supported").mockResolvedValue(false);
      const bind = vi.spyOn(desktop.globalShortcuts, "bindPortal");
      const pref = (): string | null =>
        localStorage.getItem("owncord:settings:globalKeysPortalBound");

      localStorage.setItem("owncord:settings:globalKeysPortalBound", "true");
      bind.mockRejectedValue(Object.assign(new Error("bind_timeout"), { code: "bind_timeout" }));
      page = mountPage(container);
      await vi.waitFor(() => expect(bind).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(pref()).toBe("true");
      page.destroy?.();

      bind.mockRejectedValue(
        Object.assign(new Error("bind_cancelled"), { code: "bind_cancelled" }),
      );
      page = mountPage(container);
      await vi.waitFor(() => expect(pref()).toBe("false"));
    });

    it("lets only the latest supported() answer set the flag when answers arrive out of order", async () => {
      const changeHandlers = new Set<(s: typeof portal) => void>();
      vi.spyOn(desktop.globalShortcuts, "onStatusChange").mockImplementation((handler) => {
        changeHandlers.add(handler);
        return () => changeHandlers.delete(handler);
      });
      vi.spyOn(desktop.globalShortcuts, "status").mockResolvedValue({ ...portal, backend: "none" });
      const start = vi.spyOn(desktop.globalShortcuts, "start").mockResolvedValue(undefined);
      const answers: ((value: boolean) => void)[] = [];
      const supported = vi
        .spyOn(desktop.globalShortcuts, "supported")
        .mockImplementation(() => new Promise<boolean>((resolve) => answers.push(resolve)));
      const ws = fakeWs();
      voiceStore.setState((prev) => ({ ...prev, currentChannelId: 9, localMuted: false }));
      page = mountPage(container, ws);
      await vi.waitFor(() => expect(supported).toHaveBeenCalledTimes(1));
      for (const handler of changeHandlers) handler(portal);
      expect(answers).toHaveLength(2);

      // The newer query answers "no keys" first; the older "yes" must not undo it.
      answers[1]?.(false);
      await Promise.resolve();
      answers[0]?.(true);
      await new Promise((resolve) => setTimeout(resolve, 10));
      // Only the newer query ran start(); the stale "yes" returned early.
      expect(start).toHaveBeenCalledTimes(1);
      (document.querySelector(".settings-panel") as HTMLElement).style.display = "none";
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "M", code: "KeyM", ctrlKey: true, shiftKey: true }),
      );
      expect(vi.mocked(ws.send).mock.calls.filter((c) => c[0].type === "voice_mute")).toHaveLength(
        1,
      );
    });

    it("arms the portal on a desktop that names no keys, and still answers the in-app key", async () => {
      const unnamed = { ...portal, triggersUnnamed: true };
      vi.spyOn(desktop.globalShortcuts, "status").mockResolvedValue(unnamed);
      const start = vi.spyOn(desktop.globalShortcuts, "start").mockResolvedValue(undefined);
      vi.spyOn(desktop.globalShortcuts, "supported").mockResolvedValue(false);
      const ws = fakeWs();
      voiceStore.setState((prev) => ({ ...prev, currentChannelId: 9, localMuted: false }));
      page = mountPage(container, ws);
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
      (document.querySelector(".settings-panel") as HTMLElement).style.display = "none";
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "M", code: "KeyM", ctrlKey: true, shiftKey: true }),
      );
      expect(ws.send).toHaveBeenCalledWith({ type: "voice_mute", payload: { muted: true } });
    });

    it("re-binds at startup when the portal holds the shortcuts but names no keys", async () => {
      localStorage.setItem("owncord:settings:globalKeysPortalBound", "true");
      const status = vi
        .spyOn(desktop.globalShortcuts, "status")
        .mockResolvedValue({ ...portal, triggersUnnamed: true });
      const bind = vi.spyOn(desktop.globalShortcuts, "bindPortal").mockResolvedValue(portal);
      vi.spyOn(desktop.globalShortcuts, "supported").mockResolvedValue(false);
      page = mountPage(container);
      await vi.waitFor(() => expect(status).toHaveBeenCalled());
      await vi.waitFor(() => expect(bind).toHaveBeenCalledTimes(1));
    });

    it("does not bind on a desktop without the portal even after an earlier bind", async () => {
      localStorage.setItem("owncord:settings:globalKeysPortalBound", "true");
      const status = vi
        .spyOn(desktop.globalShortcuts, "status")
        .mockResolvedValue({ ...portal, backend: "none" });
      const bind = vi.spyOn(desktop.globalShortcuts, "bindPortal").mockResolvedValue(portal);
      page = mountPage(container);
      await vi.waitFor(() => expect(status).toHaveBeenCalled());
      await Promise.resolve();
      expect(bind).not.toHaveBeenCalled();
    });

    it("keeps the in-app shortcut until both keys are bound, then stands down", async () => {
      const changeHandlers = new Set<(s: typeof portal) => void>();
      vi.spyOn(desktop.globalShortcuts, "onStatusChange").mockImplementation((handler) => {
        changeHandlers.add(handler);
        return () => changeHandlers.delete(handler);
      });
      vi.spyOn(desktop.globalShortcuts, "status").mockResolvedValue(portal);
      const start = vi.spyOn(desktop.globalShortcuts, "start").mockResolvedValue(undefined);
      const supported = vi.spyOn(desktop.globalShortcuts, "supported").mockResolvedValue(false);
      const ws = fakeWs();
      voiceStore.setState((prev) => ({ ...prev, currentChannelId: 9, localMuted: false }));
      page = mountPage(container, ws);
      await vi.waitFor(() => expect(supported).toHaveBeenCalledTimes(1));
      (document.querySelector(".settings-panel") as HTMLElement).style.display = "none";
      const mutes = (): number =>
        vi.mocked(ws.send).mock.calls.filter((c) => c[0].type === "voice_mute").length;
      const press = (): void => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "M", code: "KeyM", ctrlKey: true, shiftKey: true }),
        );
      };

      press();
      expect(mutes()).toBe(1); // the in-app key still answers

      supported.mockResolvedValue(true);
      for (const handler of changeHandlers) handler(portal);
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
      press();
      expect(mutes()).toBe(1); // the desktop's key owns it now

      page.destroy?.();
      expect(changeHandlers.size).toBe(0);
    });
  });

  // WP 1D-1: outside a call the shortcut toggles the local, saved state and
  // sends nothing; the next join restates it to the server.
  it("toggles mute and deafen from a global shortcut outside a voice channel, sending nothing (U6)", async () => {
    const lk = await import("@lib/voice/livekitSession");
    const shortcutHandlers = new Set<(action: "mute" | "deafen") => void>();
    const onShortcut = vi
      .spyOn(desktop.globalShortcuts, "onShortcut")
      .mockImplementation((handler) => {
        shortcutHandlers.add(handler);
        return () => shortcutHandlers.delete(handler);
      });
    const start = vi.spyOn(desktop.globalShortcuts, "start").mockResolvedValue(undefined);
    const ws = fakeWs();
    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: null,
      localMuted: false,
      localDeafened: false,
    }));
    page = mountPage(container, ws);
    vi.mocked(lk.setMuted).mockClear();
    vi.mocked(lk.setDeafened).mockClear();

    for (const handler of shortcutHandlers) handler("mute");
    expect(lk.setMuted).toHaveBeenCalledWith(true);
    for (const handler of shortcutHandlers) handler("deafen");
    expect(lk.setDeafened).toHaveBeenCalledWith(true);

    expect(ws.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "voice_mute" }));
    expect(ws.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "voice_deafen" }));

    onShortcut.mockRestore();
    start.mockRestore();
  });

  it("pushes the persisted global shortcut bindings to the poller on mount (U6)", async () => {
    const setKeys = vi.spyOn(desktop.globalShortcuts, "setKeys").mockResolvedValue(undefined);
    const start = vi.spyOn(desktop.globalShortcuts, "start").mockResolvedValue(undefined);
    localStorage.setItem("owncord:settings:globalMuteVk", "75"); // Ctrl+Shift+K

    page = mountPage(container);

    expect(setKeys).toHaveBeenCalledWith({ muteVk: 0x4b, deafenVk: 0x44 });
    localStorage.removeItem("owncord:settings:globalMuteVk");
    setKeys.mockRestore();
    start.mockRestore();
  });
});
