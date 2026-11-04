import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/videoGridMocks";
import { cascadedDeclaration } from "../../helpers/app-css";
import { expectConsole } from "../../helpers/console";
import {
  createVideoGrid,
  type VideoGridComponent,
  type TileConfig,
} from "../../../src/components/VideoGrid";
import {
  fakeStream,
  fakeStreamWithTrack,
  makeTileConfig,
  useVideoGridHarness,
} from "../../helpers/videoGridHarness";
import { clearHost, hostAndroidApp } from "../../helpers/androidHost";

vi.mock("@lib/ui/toast", () => mocks.uiToastMock());
vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());

const {
  mockSetUserVolume,
  mockGetUserVolume,
  mockGetUserLocalMute,
  mockSetUserLocalMute,
  mockShowToast,
} = mocks;

describe("VideoGrid", () => {
  let container: HTMLDivElement;
  let grid: VideoGridComponent;

  const harness = useVideoGridHarness((c, g) => {
    container = c;
    grid = g;
  });

  describe("call view: control bar and view toggles", () => {
    const person = (userId: number, label: string) => ({
      userId,
      label,
      content: document.createElement("div"),
    });
    const controls = () => ({
      onMuteToggle: vi.fn(),
      onDeafenToggle: vi.fn(),
      onLeave: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    const root = () => container.querySelector<HTMLElement>("[data-testid='video-grid']")!;
    const bar = () => root().querySelector<HTMLElement>(":scope > .video-grid__controls");
    const barButton = (id: string) =>
      bar()!.querySelector<HTMLButtonElement>(`[data-call-control='${id}']`)!;
    const toggle = (key: string) =>
      root().querySelector<HTMLButtonElement>(`[data-view-toggle='${key}']`)!;
    const avatarTiles = () => [...container.querySelectorAll<HTMLElement>(".video-cell--avatar")];
    const tile = (id: number) =>
      container.querySelector<HTMLElement>(`.video-cell[data-user-id='${id}']`)!;
    const SELF = 1;
    const selfCfg = makeTileConfig({ isSelf: true, audioUserId: SELF });

    beforeEach(() => {
      localStorage.clear();
    });

    it("shows the control bar in the call view, in grid and focus mode", () => {
      grid.setCallbacks({ callControls: controls() });
      expect(bar()).toBeNull();

      grid.setExitVisible(true);
      expect(bar()).not.toBeNull();
      expect(bar()!.getAttribute("role")).toBe("toolbar");
      expect(root().classList.contains("video-grid--call")).toBe(true);
      expect(
        [...bar()!.querySelectorAll<HTMLElement>("[data-call-control]")].map(
          (b) => b.dataset["callControl"],
        ),
      ).toEqual(["mute", "deafen", "camera", "share", "leave"]);

      grid.addStream(2, "Otto", fakeStream(), makeTileConfig({ audioUserId: 2 }));
      grid.addStream(3, "Sam", fakeStream(), makeTileConfig({ audioUserId: 3 }));
      grid.setFocusedTile(2);
      expect(root().classList.contains("focus-mode")).toBe(true);
      expect(bar()).not.toBeNull();
      grid.setFocusedTile(null);
      expect(bar()).not.toBeNull();

      // Leaving the call view (another host shows the grid) takes it down.
      grid.setExitVisible(false);
      expect(bar()).toBeNull();
      expect(root().classList.contains("video-grid--call")).toBe(false);
    });

    it("runs the matching call action from each button", () => {
      const cc = controls();
      grid.setCallbacks({ callControls: cc });
      grid.setExitVisible(true);

      barButton("mute").click();
      barButton("deafen").click();
      barButton("camera").click();
      barButton("share").click();
      barButton("leave").click();
      expect(cc.onMuteToggle).toHaveBeenCalledTimes(1);
      expect(cc.onDeafenToggle).toHaveBeenCalledTimes(1);
      expect(cc.onCameraToggle).toHaveBeenCalledTimes(1);
      expect(cc.onScreenshareToggle).toHaveBeenCalledTimes(1);
      expect(cc.onLeave).toHaveBeenCalledTimes(1);
    });

    it("puts the camera picker arrow beside Camera, inert while the camera is locked", () => {
      const onCameraDevice = vi.fn();
      grid.setCallbacks({ callControls: { ...controls(), onCameraDevice } });
      grid.setExitVisible(true);
      expect(
        [...bar()!.querySelectorAll<HTMLElement>("[data-call-control]")].map(
          (b) => b.dataset["callControl"],
        ),
      ).toEqual(["mute", "deafen", "camera", "camera-device", "share", "leave"]);

      const pick = barButton("camera-device");
      expect(pick.getAttribute("aria-label")).toBe("Choose camera");
      expect(pick.getAttribute("aria-haspopup")).toBe("menu");
      pick.click();
      expect(onCameraDevice).toHaveBeenCalledTimes(1);
      expect(onCameraDevice.mock.calls[0]![0]).toBe(pick);
      expect(onCameraDevice.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);

      grid.setCallState({ muted: false, deafened: false, listenOnly: false, connecting: true });
      expect(barButton("camera-device").disabled).toBe(true);
    });

    describe("camera flip", () => {
      const on = { muted: false, deafened: false, listenOnly: false, camera: true };
      const off = { ...on, camera: false };
      const settle = () => new Promise((r) => setTimeout(r, 0));

      it("shows only while the camera is on and the device has both cameras", async () => {
        const available = vi.fn().mockResolvedValue(true);
        grid.setCallbacks({
          callControls: { ...controls(), cameraFlip: { available, flip: vi.fn() } },
        });
        grid.setExitVisible(true);
        expect(barButton("camera-flip").hidden).toBe(true);
        expect(available).not.toHaveBeenCalled();

        grid.setCallState(on);
        await settle();
        expect(barButton("camera-flip").hidden).toBe(false);
        expect(barButton("camera-flip").getAttribute("aria-label")).toBe("Flip camera");

        grid.setCallState(off);
        expect(barButton("camera-flip").hidden).toBe(true);
      });

      it("stays hidden on a device without both cameras, and asks again next camera-on", async () => {
        const available = vi.fn().mockResolvedValue(false);
        grid.setCallbacks({
          callControls: { ...controls(), cameraFlip: { available, flip: vi.fn() } },
        });
        grid.setExitVisible(true);
        grid.setCallState(on);
        await settle();
        expect(barButton("camera-flip").hidden).toBe(true);

        grid.setCallState(off);
        available.mockResolvedValue(true);
        grid.setCallState(on);
        await settle();
        expect(available).toHaveBeenCalledTimes(2);
        expect(barButton("camera-flip").hidden).toBe(false);
      });

      it("drops an answer that lands after the camera went off and on again", async () => {
        const answers: Array<(ok: boolean) => void> = [];
        const available = vi.fn(() => new Promise<boolean>((r) => answers.push(r)));
        grid.setCallbacks({
          callControls: { ...controls(), cameraFlip: { available, flip: vi.fn() } },
        });
        grid.setExitVisible(true);
        grid.setCallState(on);
        grid.setCallState(off);
        grid.setCallState(on);
        expect(available).toHaveBeenCalledTimes(2);

        answers[1]!(true);
        await settle();
        answers[0]!(false);
        await settle();
        expect(barButton("camera-flip").hidden).toBe(false);
      });

      it("ignores taps while a flip is still switching", async () => {
        let finish!: () => void;
        const flip = vi.fn(() => new Promise<void>((r) => (finish = r)));
        grid.setCallbacks({
          callControls: { ...controls(), cameraFlip: { available: async () => true, flip } },
        });
        grid.setExitVisible(true);
        grid.setCallState(on);
        await settle();

        barButton("camera-flip").click();
        expect(barButton("camera-flip").disabled).toBe(true);
        barButton("camera-flip").click();
        expect(flip).toHaveBeenCalledTimes(1);

        finish();
        await settle();
        expect(barButton("camera-flip").disabled).toBe(false);
        barButton("camera-flip").click();
        expect(flip).toHaveBeenCalledTimes(2);
      });
    });

    it("builds the bar from callbacks set after the call view opened", () => {
      grid.setExitVisible(true);
      expect(bar()).toBeNull();
      const cc = controls();
      grid.setCallbacks({ callControls: cc });
      barButton("camera").click();
      expect(cc.onCameraToggle).toHaveBeenCalledTimes(1);
    });

    it("draws your camera and share state, inert while the join connects", () => {
      grid.setCallbacks({ callControls: controls() });
      grid.setExitVisible(true);
      const camera = barButton("camera");
      const share = barButton("share");
      expect(camera.getAttribute("aria-pressed")).toBe("false");
      expect(camera.getAttribute("aria-label")).toBe("Turn on camera");
      expect(share.getAttribute("aria-label")).toBe("Share your screen");

      grid.setCallState({
        muted: true,
        deafened: false,
        listenOnly: false,
        camera: true,
        screenshare: true,
      });
      expect(barButton("mute").getAttribute("aria-pressed")).toBe("true");
      expect(camera.getAttribute("aria-pressed")).toBe("true");
      expect(camera.getAttribute("aria-label")).toBe("Turn off camera");
      expect(camera.querySelector("svg")!.getAttribute("data-icon")).toBe("camera-off");
      expect(share.getAttribute("aria-pressed")).toBe("true");
      expect(share.getAttribute("aria-label")).toBe("Stop sharing");
      expect(share.querySelector("svg")!.getAttribute("data-icon")).toBe("monitor-off");
      expect(camera.disabled).toBe(false);

      grid.setCallState({ muted: false, deafened: false, listenOnly: false, connecting: true });
      expect(camera.disabled).toBe(true);
      expect(share.disabled).toBe(true);
      expect(camera.title).toBe("Connecting…");

      // The chat socket is down: frozen with the reason, like the voice widget.
      grid.setCallState({
        muted: false,
        deafened: false,
        listenOnly: false,
        offline: "reconnecting",
      });
      expect(camera.disabled).toBe(true);
      expect(share.title).toBe("Reconnecting…");

      // A moderator's mute or deafen: that control is inert, with the reason.
      grid.setCallState({
        muted: true,
        deafened: true,
        listenOnly: false,
        serverMuted: true,
        serverDeafened: true,
      });
      expect(barButton("mute").disabled).toBe(true);
      expect(barButton("mute").title).toBe("You were muted by a moderator");
      expect(barButton("deafen").disabled).toBe(true);
      expect(barButton("deafen").title).toBe("You were deafened by a moderator");
      expect(camera.disabled).toBe(false);

      // No share permission or the video limit: share is inert with the reason.
      grid.setCallState({
        muted: false,
        deafened: false,
        listenOnly: false,
        shareBlock: "This channel has reached its video limit",
      });
      expect(share.disabled).toBe(true);
      expect(share.title).toBe("This channel has reached its video limit");
      expect(camera.disabled).toBe(false);
    });

    it("offers camera and share on a full-screen tile too", async () => {
      const cc = controls();
      grid.setCallbacks({ callControls: cc });
      grid.addStream(2, "Otto", fakeStream(), makeTileConfig({ audioUserId: 2 }));
      tile(2).querySelector<HTMLButtonElement>("[data-tile-control='fullscreen']")!.click();
      await Promise.resolve();
      const fs = tile(2).querySelector<HTMLElement>(".video-fs-calls")!;
      fs.querySelector<HTMLButtonElement>("[data-call-control='share']")!.click();
      expect(cc.onScreenshareToggle).toHaveBeenCalledTimes(1);
    });

    it("hides avatar tiles without Show non-video participants, and saves it", () => {
      grid.setExitVisible(true);
      grid.setPeople([person(2, "Otto"), person(3, "Sam")]);
      expect(avatarTiles().filter((t) => !t.hidden)).toHaveLength(2);
      expect(toggle("nonVideo").getAttribute("aria-pressed")).toBe("true");

      toggle("nonVideo").click();
      expect(toggle("nonVideo").getAttribute("aria-pressed")).toBe("false");
      expect(avatarTiles().every((t) => t.hidden)).toBe(true);
      expect(localStorage.getItem("owncord:settings:callShowNonVideo")).toBe("false");
      // A person who joins later stays hidden too.
      grid.setPeople([person(2, "Otto"), person(3, "Sam"), person(4, "Ana")]);
      expect(avatarTiles().every((t) => t.hidden)).toBe(true);

      toggle("nonVideo").click();
      expect(avatarTiles().some((t) => t.hidden)).toBe(false);
    });

    it("hides only your own camera tile without Show my camera", () => {
      grid.setExitVisible(true);
      grid.addStream(SELF, "You", fakeStream(), selfCfg);
      grid.addStream(2, "Otto", fakeStream(), makeTileConfig({ audioUserId: 2 }));
      grid.addStream(SELF + 1_000_000, "Your screen", fakeStream(), {
        ...selfCfg,
        isScreenshare: true,
      });

      toggle("selfCamera").click();
      expect(tile(SELF).hidden).toBe(true);
      expect(tile(2).hidden).toBe(false);
      expect(tile(SELF + 1_000_000).hidden).toBe(false);
      expect(localStorage.getItem("owncord:settings:callShowSelfCamera")).toBe("false");

      toggle("selfCamera").click();
      expect(tile(SELF).hidden).toBe(false);
    });

    it("leaves focus mode when the focused tile is your hidden camera", () => {
      grid.setExitVisible(true);
      grid.addStream(SELF, "You", fakeStream(), selfCfg);
      grid.addStream(2, "Otto", fakeStream(), makeTileConfig({ audioUserId: 2 }));
      grid.setFocusedTile(SELF);

      toggle("selfCamera").click();
      expect(grid.getFocusedTileId()).toBeNull();
      expect(root().classList.contains("focus-mode")).toBe(false);
      expect(tile(2).parentElement).toBe(root());
    });

    it("offers the strip toggle only in focus view, and hides the strip with it", () => {
      grid.setExitVisible(true);
      grid.addStream(2, "Otto", fakeStream(), makeTileConfig({ audioUserId: 2 }));
      grid.addStream(3, "Sam", fakeStream(), makeTileConfig({ audioUserId: 3 }));
      expect(toggle("strip").hidden).toBe(true);

      grid.setFocusedTile(2);
      expect(toggle("strip").hidden).toBe(false);
      expect(root().querySelector(".video-focus-strip")).not.toBeNull();

      toggle("strip").click();
      // Hidden, not detached: a video taken out of the document pauses.
      const strip = root().querySelector<HTMLElement>(".video-focus-strip")!;
      expect(strip.hidden).toBe(true);
      expect(strip.contains(tile(3))).toBe(true);
      expect(tile(2).parentElement!.classList.contains("video-focus-main")).toBe(true);
      expect(localStorage.getItem("owncord:settings:callShowStrip")).toBe("false");

      toggle("strip").click();
      expect(root().querySelector<HTMLElement>(".video-focus-strip")!.hidden).toBe(false);
    });

    it("moves focus past your hidden camera when the focused stream ends", () => {
      grid.setExitVisible(true);
      grid.addStream(SELF, "You", fakeStream(), selfCfg);
      grid.addStream(2, "Otto", fakeStream(), makeTileConfig({ audioUserId: 2 }));
      grid.addStream(3, "Sam", fakeStream(), makeTileConfig({ audioUserId: 3 }));
      toggle("selfCamera").click();
      grid.setFocusedTile(2);

      grid.removeStream(2);
      expect(grid.getFocusedTileId()).toBe(3);
    });

    it("keeps keyboard focus on a bar button or toggle while focus view redraws", () => {
      document.body.appendChild(container);
      grid.setCallbacks({ callControls: controls() });
      grid.setExitVisible(true);
      grid.addStream(2, "Otto", fakeStream(), makeTileConfig({ audioUserId: 2 }));
      grid.addStream(3, "Sam", fakeStream(), makeTileConfig({ audioUserId: 3 }));
      grid.setFocusedTile(2);

      barButton("camera").focus();
      grid.setPeople([person(4, "Ana")]);
      expect(document.activeElement).toBe(barButton("camera"));

      toggle("strip").focus();
      toggle("strip").click();
      expect(document.activeElement).toBe(toggle("strip"));
      // The grid's own controls stay after the tiles.
      expect(root().lastElementChild).toBe(bar());
      container.remove();
    });

    it("seats show chat in the view bar in the call view, and back in the grid without it", () => {
      grid.setExitVisible(true);
      const exit = () =>
        root().querySelector<HTMLButtonElement>("[data-tile-control='exit-grid']")!;
      expect(exit().parentElement!.classList.contains("video-grid__views")).toBe(true);
      expect(exit().hidden).toBe(false);

      grid.setExitVisible(false);
      expect(exit().parentElement).toBe(root());
      expect(exit().hidden).toBe(true);
    });

    it("reads the saved toggles when the grid mounts", () => {
      localStorage.setItem("owncord:settings:callShowNonVideo", "false");
      localStorage.setItem("owncord:settings:callShowSelfCamera", "false");
      localStorage.setItem("owncord:settings:callShowStrip", "false");
      grid.destroy?.();
      container = document.createElement("div");
      grid = harness.adopt(createVideoGrid());
      grid.mount(container);
      grid.setExitVisible(true);
      grid.setPeople([person(2, "Otto")]);
      grid.addStream(SELF, "You", fakeStream(), selfCfg);

      expect(toggle("nonVideo").getAttribute("aria-pressed")).toBe("false");
      expect(toggle("selfCamera").getAttribute("aria-pressed")).toBe("false");
      expect(toggle("strip").getAttribute("aria-pressed")).toBe("false");
      expect(avatarTiles()[0]!.hidden).toBe(true);
      expect(tile(SELF).hidden).toBe(true);
    });

    it("hides nothing outside the call view (the DM call panel hosts the grid)", () => {
      localStorage.setItem("owncord:settings:callShowNonVideo", "false");
      localStorage.setItem("owncord:settings:callShowSelfCamera", "false");
      grid.destroy?.();
      container = document.createElement("div");
      grid = harness.adopt(createVideoGrid());
      grid.mount(container);
      grid.setPeople([person(2, "Otto")]);
      grid.addStream(SELF, "You", fakeStream(), selfCfg);

      expect(root().querySelector(".video-grid__views")).toBeNull();
      expect(avatarTiles()[0]!.hidden).toBe(false);
      expect(tile(SELF).hidden).toBe(false);

      grid.setExitVisible(true);
      expect(tile(SELF).hidden).toBe(true);
      grid.setExitVisible(false);
      expect(tile(SELF).hidden).toBe(false);
      expect(avatarTiles()[0]!.hidden).toBe(false);
    });

    it("leaves room below the tiles for the bar (CSS)", () => {
      expect(cascadedDeclaration(".video-grid--call", "padding-bottom")).toBeDefined();
    });
  });

  describe("full tile menu", () => {
    const OTTO = 2;
    const SCREEN = OTTO + 1_000_000;
    const SELF = 1;
    const remote = (overrides: Partial<TileConfig> = {}): TileConfig =>
      makeTileConfig({ audioUserId: OTTO, name: "Otto", ...overrides });
    const cell = (id: number) =>
      container.querySelector<HTMLElement>(`.video-cell[data-user-id='${id}']`)!;
    const menu = () => document.querySelector<HTMLElement>(".video-tile-menu");
    const actions = () =>
      [...menu()!.querySelectorAll<HTMLElement>("[data-action]")].map((m) => m.dataset["action"]);
    const item = (action: string) =>
      menu()!.querySelector<HTMLButtonElement>(`[data-action='${action}']`)!;
    async function openMenu(id: number, x = 30, y = 40): Promise<HTMLElement | null> {
      cell(id).dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }),
      );
      await vi.dynamicImportSettled();
      return menu();
    }
    const modOptions = () => ({
      serverMuted: false,
      serverDeafened: false,
      moveTargets: [],
      onServerMute: vi.fn(),
      onServerDeafen: vi.fn(),
      onMove: vi.fn(),
      onDisconnect: vi.fn(),
    });
    const controls = () => ({
      onMuteToggle: vi.fn(),
      onDeafenToggle: vi.fn(),
      onLeave: vi.fn(),
      onCameraToggle: vi.fn(),
    });

    beforeEach(() => {
      localStorage.clear();
    });

    afterEach(() => {
      menu()?.remove();
      mockSetUserLocalMute.mockReset();
      mockSetUserVolume.mockReset();
      mockGetUserVolume.mockReturnValue(100);
      mockGetUserLocalMute.mockReturnValue(false);
    });

    it("gives another person's tile the person, sound and view rows", async () => {
      grid.setCallbacks({
        tileMenu: { onProfile: vi.fn(), onMessage: vi.fn(), moderation: () => modOptions() },
      });
      grid.addStream(OTTO, "Otto", fakeStream(), remote());
      await openMenu(OTTO);

      expect(actions()).toEqual([
        "profile",
        "message",
        "local-mute",
        "focus",
        "fullscreen",
        "popout",
        "stop-watching",
        "server-mute",
        "server-deafen",
        "voice-disconnect",
      ]);
      expect(menu()!.querySelector("[data-menu-volume='voice']")).not.toBeNull();
      expect(menu()!.querySelector("[data-menu-volume='stream']")).toBeNull();
    });

    it("leaves out Profile, Message and moderation without their handlers", async () => {
      grid.addStream(OTTO, "Otto", fakeStream(), remote());
      await openMenu(OTTO);

      expect(actions()).toEqual(["local-mute", "focus", "fullscreen", "popout", "stop-watching"]);
    });

    it("hides moderation when the host returns nothing, and says why when it returns a reason", async () => {
      const moderation = vi.fn((_userId: number): string | undefined => undefined);
      grid.setCallbacks({ tileMenu: { moderation } });
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), remote({ isScreenshare: true }));
      await openMenu(SCREEN);
      // Asked for the person, not the screen-share tile id.
      expect(moderation).toHaveBeenCalledWith(OTTO);
      expect(actions()).not.toContain("server-mute");
      expect(actions()).not.toContain("voice-mod-unavailable");
      menu()!.remove();

      moderation.mockReturnValue("No verdict yet");
      await openMenu(SCREEN);
      expect(item("voice-mod-unavailable").textContent).toBe("No verdict yet");
      expect(actions()).not.toContain("server-mute");
    });

    it("runs Profile and Message for the person at the click, and closes the menu", async () => {
      const onProfile = vi.fn();
      const onMessage = vi.fn();
      grid.setCallbacks({ tileMenu: { onProfile, onMessage } });
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), remote({ isScreenshare: true }));

      await openMenu(SCREEN, 30, 40);
      item("profile").click();
      expect(onProfile).toHaveBeenCalledWith(OTTO, 30, 40);
      expect(menu()).toBeNull();

      await openMenu(SCREEN);
      item("message").click();
      expect(onMessage).toHaveBeenCalledWith(OTTO);
      expect(menu()).toBeNull();
    });

    it("runs each moderation row for the person", async () => {
      const mod = modOptions();
      grid.setCallbacks({ tileMenu: { moderation: () => mod } });
      grid.addStream(OTTO, "Otto", fakeStream(), remote());

      await openMenu(OTTO);
      item("server-mute").click();
      expect(mod.onServerMute).toHaveBeenCalledWith(true);
      await openMenu(OTTO);
      item("server-deafen").click();
      expect(mod.onServerDeafen).toHaveBeenCalledWith(true);
      await openMenu(OTTO);
      item("voice-disconnect").click();
      expect(mod.onDisconnect).toHaveBeenCalledTimes(1);
    });

    it("Profile from a full-screen tile leaves full screen first, so the card can be seen", async () => {
      const onProfile = vi.fn();
      grid.setCallbacks({ tileMenu: { onProfile } });
      grid.addStream(OTTO, "Otto", fakeStream(), remote());
      await openMenu(OTTO);
      item("fullscreen").click();
      // jsdom has no requestFullscreen: the window-filling fallback.
      expect(cell(OTTO).classList.contains("video-cell--theatre")).toBe(true);

      await openMenu(OTTO);
      expect(item("fullscreen").textContent).toBe("Exit full screen");
      item("profile").click();
      expect(cell(OTTO).classList.contains("video-cell--theatre")).toBe(false);
      expect(onProfile).toHaveBeenCalledTimes(1);
    });

    it("Focus opens the tile in focus view, and then reads Back to grid", async () => {
      grid.addStream(OTTO, "Otto", fakeStream(), remote());
      grid.addStream(3, "Sam", fakeStream(), remote({ audioUserId: 3, name: "Sam" }));
      await openMenu(OTTO);
      expect(item("focus").textContent).toBe("Focus");
      item("focus").click();
      expect(grid.getFocusedTileId()).toBe(OTTO);

      await openMenu(OTTO);
      expect(item("focus").textContent).toBe("Back to grid");
      item("focus").click();
      expect(grid.getFocusedTileId()).toBeNull();
    });

    it("leaves Pop out out of the menu in the Android app, which has one window", async () => {
      hostAndroidApp();
      try {
        grid.addStream(OTTO, "Otto", fakeStream(), remote());
        await openMenu(OTTO);
        expect(actions()).toEqual(["local-mute", "focus", "fullscreen", "stop-watching"]);
      } finally {
        clearHost();
      }
    });

    it("Pop out opens the tile in a window of its own", async () => {
      const open = vi.spyOn(window, "open").mockReturnValue(null);
      try {
        grid.addStream(OTTO, "Otto", fakeStream(), remote());
        await openMenu(OTTO);
        expect(item("popout").textContent).toBe("Pop out");
        item("popout").click();
        expect(open).toHaveBeenCalledTimes(1);
        // No window here: the tile stays and says so.
        expect(mockShowToast).toHaveBeenCalledWith("Couldn't open the pop-out window", "error");
        expectConsole("warn", "Pop out window refused");
      } finally {
        open.mockRestore();
      }
    });

    it("lets a menu taller than the window scroll instead of running off it", async () => {
      const height = vi
        .spyOn(HTMLElement.prototype, "offsetHeight", "get")
        .mockReturnValue(window.innerHeight + 200);
      try {
        grid.addStream(OTTO, "Otto", fakeStream(), remote());
        await openMenu(OTTO);
        expect(menu()!.style.maxHeight).toBe(`${window.innerHeight - 16}px`);
        expect(menu()!.style.overflowY).toBe("auto");
        expect(menu()!.style.top).toBe("8px");
      } finally {
        height.mockRestore();
      }
    });

    it("Stop watching in the menu stops the stream", async () => {
      grid.addStream(OTTO, "Otto", fakeStream(), remote());
      await openMenu(OTTO);
      item("stop-watching").click();
      expect(cell(OTTO).classList.contains("video-cell--stopped")).toBe(true);
    });

    it("Mute silences the person for you only, and stays open", async () => {
      grid.addStream(OTTO, "Otto", fakeStream(), remote());
      await openMenu(OTTO);
      const mute = item("local-mute");
      expect(mute.getAttribute("role")).toBe("menuitemcheckbox");
      expect(mute.getAttribute("aria-checked")).toBe("false");

      mockSetUserLocalMute.mockImplementation((_id: number, on: boolean) =>
        mockGetUserLocalMute.mockReturnValue(on),
      );
      mute.click();
      expect(mockSetUserLocalMute).toHaveBeenCalledWith(OTTO, true);
      expect(mute.getAttribute("aria-checked")).toBe("true");
      expect(menu()).not.toBeNull();
    });

    it("unchecking Mute on a person at 0% brings them back at 100% on the slider and tile", async () => {
      mockGetUserVolume.mockReturnValue(0);
      grid.addStream(OTTO, "Otto", fakeStream(), remote());
      await openMenu(OTTO);
      const mute = item("local-mute");
      expect(mute.getAttribute("aria-checked")).toBe("true");

      mockSetUserVolume.mockImplementation((_id: number, v: number) =>
        mockGetUserVolume.mockReturnValue(v),
      );
      mute.click();
      expect(mockSetUserLocalMute).toHaveBeenCalledWith(OTTO, false);
      expect(mockSetUserVolume).toHaveBeenCalledWith(OTTO, 100);
      expect(menu()!.querySelector<HTMLInputElement>("[data-menu-volume='voice']")!.value).toBe(
        "100",
      );
      expect(cell(OTTO).querySelector("output")!.textContent).toBe("100%");
      expect(mute.getAttribute("aria-checked")).toBe("false");
    });

    describe("your own camera tile", () => {
      const self = () => makeTileConfig({ isSelf: true, audioUserId: SELF });

      it("offers Hide my camera and Turn off camera in the call view, nothing about others", async () => {
        const cc = controls();
        grid.setCallbacks({
          callControls: cc,
          tileMenu: { onProfile: vi.fn(), onMessage: vi.fn(), moderation: () => modOptions() },
        });
        grid.setExitVisible(true);
        grid.addStream(SELF, "Me (You)", fakeStream(), self());
        await openMenu(SELF);

        expect(menu()!.getAttribute("aria-label")).toBe("Your camera");
        expect(actions()).toEqual(["hide-self", "camera-off"]);
        expect(menu()!.querySelector("[data-menu-volume]")).toBeNull();
      });

      it("Hide my camera hides the tile and turns the Show my camera toggle off", async () => {
        grid.setCallbacks({ callControls: controls() });
        grid.setExitVisible(true);
        grid.addStream(SELF, "Me (You)", fakeStream(), self());
        await openMenu(SELF);
        item("hide-self").click();

        expect(cell(SELF).hidden).toBe(true);
        const toggle = container.querySelector("[data-view-toggle='selfCamera']")!;
        expect(toggle.getAttribute("aria-pressed")).toBe("false");
        expect(menu()).toBeNull();
      });

      it("Turn off camera runs the camera control", async () => {
        const cc = controls();
        grid.setCallbacks({ callControls: cc });
        grid.addStream(SELF, "Me (You)", fakeStream(), self());
        await openMenu(SELF);
        // Outside the call view the "Show my camera" toggle does not apply.
        expect(actions()).toEqual(["camera-off"]);
        item("camera-off").click();
        expect(cc.onCameraToggle).toHaveBeenCalledTimes(1);
      });

      it("Hide my camera on a full-screen tile leaves full screen first", async () => {
        grid.setCallbacks({ callControls: controls() });
        grid.setExitVisible(true);
        grid.addStream(SELF, "Me (You)", fakeStream(), self());
        cell(SELF).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        expect(cell(SELF).classList.contains("video-cell--theatre")).toBe(true);

        await openMenu(SELF);
        item("hide-self").click();
        expect(cell(SELF).hidden).toBe(true);
        expect(cell(SELF).classList.contains("video-cell--theatre")).toBe(false);
      });

      it("Hide my camera puts focus on the toggle that brings the tile back", async () => {
        document.body.appendChild(container);
        try {
          grid.setCallbacks({ callControls: controls() });
          grid.setExitVisible(true);
          grid.addStream(SELF, "Me (You)", fakeStream(), self());
          await openMenu(SELF);
          item("hide-self").click();
          expect(document.activeElement).toBe(
            container.querySelector("[data-view-toggle='selfCamera']"),
          );
        } finally {
          container.remove();
        }
      });

      it("opens no menu outside the call view while the camera is locked", async () => {
        grid.setCallbacks({ callControls: controls() });
        grid.setCallState({ muted: false, deafened: false, listenOnly: false, connecting: true });
        grid.addStream(SELF, "Me (You)", fakeStream(), self());
        expect(await openMenu(SELF)).toBeNull();
      });

      it("greys Turn off camera with the reason while the camera is locked", async () => {
        const cc = controls();
        grid.setCallbacks({ callControls: cc });
        grid.setExitVisible(true);
        grid.setCallState({
          muted: false,
          deafened: false,
          listenOnly: false,
          camera: true,
          offline: "reconnecting",
        });
        grid.addStream(SELF, "Me (You)", fakeStream(), self());
        await openMenu(SELF);
        const off = item("camera-off");
        expect(off.disabled).toBe(true);
        expect(off.title).not.toBe("");
        off.click();
        expect(cc.onCameraToggle).not.toHaveBeenCalled();
      });

      it("opens no menu with nothing to offer, and none on your own screen share", async () => {
        grid.addStream(SELF, "Me (You)", fakeStream(), self());
        expect(await openMenu(SELF)).toBeNull();

        grid.setCallbacks({ callControls: controls() });
        grid.addStream(
          SELF + 1_000_000,
          "Your Screen",
          null,
          makeTileConfig({ isSelf: true, audioUserId: SELF, isScreenshare: true }),
        );
        expect(await openMenu(SELF + 1_000_000)).toBeNull();
      });
    });
  });
  describe("stream ended cover", () => {
    const SCREEN = 2 + 1_000_000;
    const screen: TileConfig = { isSelf: false, audioUserId: 2, isScreenshare: true, name: "Otto" };
    const cell = () =>
      container.querySelector<HTMLElement>(`.video-cell[data-user-id='${SCREEN}']`);
    let onStreamRemoved: ReturnType<typeof vi.fn<() => void>>;

    beforeEach(() => {
      vi.useFakeTimers();
      onStreamRemoved = vi.fn();
      grid.setCallbacks({ onStreamRemoved });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("a watched stream that ends says so for 3 s, then its tile goes", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen);
      grid.removeStream(SCREEN);

      expect(cell()?.querySelector(".video-ended")?.textContent).toBe("Otto ended the stream");
      expect(cell()!.querySelector("video")!.srcObject).toBeNull();
      expect(grid.hasStreams()).toBe(true);
      // Nothing under the cover can be clicked or tabbed to.
      const under = [...cell()!.children].filter((c) => !c.classList.contains("video-ended"));
      expect(under.length).toBeGreaterThan(0);
      expect(under.every((c) => c.hasAttribute("inert"))).toBe(true);
      // A second removal (track ended, then unsubscribed) changes nothing.
      grid.removeStream(SCREEN);
      vi.advanceTimersByTime(2999);
      expect(cell()).not.toBeNull();
      expect(onStreamRemoved).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(cell()).toBeNull();
      expect(grid.hasStreams()).toBe(false);
      expect(onStreamRemoved).toHaveBeenCalledTimes(1);
    });

    it("an unpublish that unsubscribes first still shows the cover", () => {
      // livekit-client (and the native room) emit TrackUnsubscribed before
      // TrackUnpublished: the tile is offered back as Watch, then removed.
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen);
      grid.addStream(SCREEN, "Otto (Screen)", null, screen);
      grid.removeStream(SCREEN);

      expect(cell()?.querySelector(".video-ended")?.textContent).toBe("Otto ended the stream");
      vi.advanceTimersByTime(3000);
      expect(cell()).toBeNull();
    });

    it("a stream you stopped watching goes at once when it ends", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen);
      cell()!.querySelector<HTMLButtonElement>("[data-tile-control='stop']")!.click();
      grid.addStream(SCREEN, "Otto (Screen)", null, screen);
      grid.removeStream(SCREEN);

      expect(cell()).toBeNull();
    });

    it("a stream nobody watched, a camera, or your own share goes at once", () => {
      grid.addStream(SCREEN, "Otto (Screen)", null, screen);
      grid.addStream(2, "Otto", fakeStream(), { ...screen, isScreenshare: false });
      grid.addStream(9, "You", fakeStream(), { ...screen, isSelf: true });
      grid.removeStream(SCREEN);
      grid.removeStream(2);
      grid.removeStream(9);

      expect(container.querySelectorAll(".video-cell")).toHaveLength(0);
      expect(container.querySelector(".video-ended")).toBeNull();
    });

    it("the same person streaming again replaces the cover", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen);
      grid.removeStream(SCREEN);
      const again = fakeStream();
      grid.addStream(SCREEN, "Otto (Screen)", again, screen);

      expect(cell()!.querySelector(".video-ended")).toBeNull();
      expect(cell()!.querySelector("video")!.srcObject).toBe(again);
      vi.advanceTimersByTime(3000);
      expect(cell()).not.toBeNull();
      expect(onStreamRemoved).not.toHaveBeenCalled();
    });

    describe("a sharer republishing for another codec", () => {
      let live: boolean;
      let cameraLive: boolean;
      beforeEach(() => {
        live = true;
        cameraLive = false;
        grid.setCallbacks({
          onStreamRemoved,
          isStreamLive: (_userId, screenshare) => (screenshare ? live : cameraLive),
        });
      });

      it("keeps a watched camera's tile and watch through its republish", () => {
        const forgetStreamWatch = vi.fn();
        grid.setCallbacks({
          onStreamRemoved,
          forgetStreamWatch,
          isStreamLive: (_userId, screenshare) => !screenshare && cameraLive,
        });
        cameraLive = true;
        const camera = { ...screen, isScreenshare: false };
        grid.addStream(2, "Otto", fakeStreamWithTrack().stream, camera);
        grid.addStream(2, "Otto", null, camera);
        grid.removeStream(2);

        const tile = (): HTMLElement | null =>
          container.querySelector(".video-cell[data-user-id='2']");
        expect(tile()).not.toBeNull();
        expect(tile()!.classList.contains("video-cell--stopped")).toBe(false);
        const again = fakeStreamWithTrack().stream;
        grid.addStream(2, "Otto", again, camera);
        expect(tile()!.querySelector("video")!.srcObject).toBe(again);
        vi.advanceTimersByTime(10_000);
        expect(tile()).not.toBeNull();
        expect(forgetStreamWatch).not.toHaveBeenCalled();

        // Turned off for real: the tile goes with its watch.
        cameraLive = false;
        grid.removeStream(2);
        vi.advanceTimersByTime(250);
        expect(tile()).toBeNull();
        expect(forgetStreamWatch).toHaveBeenCalledWith(2);
      });

      it("shows no cover while the owner's voice state still says they share, and plays the share when it returns", () => {
        grid.addStream(SCREEN, "Otto (Screen)", fakeStreamWithTrack().stream, screen);
        grid.removeStream(SCREEN);
        // The track's own ended event and the unpublish both arrive.
        grid.removeStream(SCREEN);

        expect(cell()!.querySelector(".video-ended")).toBeNull();
        vi.advanceTimersByTime(1000);
        expect(cell()!.querySelector(".video-ended")).toBeNull();

        const again = fakeStreamWithTrack().stream;
        grid.addStream(SCREEN, "Otto (Screen)", again, screen);
        expect(cell()!.querySelector("video")!.srcObject).toBe(again);
        expect(cell()!.classList.contains("video-cell--stopped")).toBe(false);
        // The wait is over: nothing ends the tile later.
        vi.advanceTimersByTime(10_000);
        expect(cell()).not.toBeNull();
        expect(cell()!.querySelector(".video-ended")).toBeNull();
        expect(onStreamRemoved).not.toHaveBeenCalled();
      });

      it("in livekit's real order (unsubscribe, then unpublish) shows no Watch cover and plays the share when it returns", () => {
        grid.addStream(SCREEN, "Otto (Screen)", fakeStreamWithTrack().stream, screen);
        grid.addStream(SCREEN, "Otto (Screen)", null, screen);
        grid.removeStream(SCREEN);

        expect(cell()!.classList.contains("video-cell--stopped")).toBe(false);
        expect(cell()!.querySelector(".video-stopped")).toBeNull();
        expect(cell()!.querySelector(".video-ended")).toBeNull();

        const again = fakeStreamWithTrack().stream;
        grid.addStream(SCREEN, "Otto (Screen)", again, screen);
        expect(cell()!.querySelector("video")!.srcObject).toBe(again);
        vi.advanceTimersByTime(10_000);
        expect(cell()!.querySelector(".video-ended")).toBeNull();
        expect(onStreamRemoved).not.toHaveBeenCalled();
      });

      it("in livekit's real order still says the stream ended once the owner stops sharing", () => {
        grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen);
        grid.addStream(SCREEN, "Otto (Screen)", null, screen);
        grid.removeStream(SCREEN);

        live = false;
        vi.advanceTimersByTime(250);
        expect(cell()?.querySelector(".video-ended")?.textContent).toBe("Otto ended the stream");
      });

      it("shows the cover as soon as the owner's voice state says the share is over", () => {
        grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen);
        grid.removeStream(SCREEN);
        vi.advanceTimersByTime(500);
        expect(cell()!.querySelector(".video-ended")).toBeNull();

        live = false;
        vi.advanceTimersByTime(250);
        expect(cell()?.querySelector(".video-ended")?.textContent).toBe("Otto ended the stream");
        vi.advanceTimersByTime(3000);
        expect(cell()).toBeNull();
      });

      it("shows the cover once the grace runs out with no share back", () => {
        grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen);
        grid.removeStream(SCREEN);

        vi.advanceTimersByTime(2249);
        expect(cell()!.querySelector(".video-ended")).toBeNull();
        vi.advanceTimersByTime(1000);
        expect(cell()!.querySelector(".video-ended")).not.toBeNull();
      });

      it("shows the cover at once when the owner is not sharing, and for a camera never waits", () => {
        live = false;
        grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen);
        grid.removeStream(SCREEN);
        expect(cell()!.querySelector(".video-ended")).not.toBeNull();

        live = true;
        grid.addStream(2, "Otto", fakeStream(), { ...screen, isScreenshare: false });
        grid.removeStream(2);
        expect(container.querySelector(".video-cell[data-user-id='2']")).toBeNull();
      });

      it("a held tile that is closed stops looking at the owner", () => {
        const isStreamLive = vi.fn(() => true);
        grid.setCallbacks({ onStreamRemoved, isStreamLive });
        grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen);
        grid.removeStream(SCREEN);
        const looked = isStreamLive.mock.calls.length;

        grid.destroy?.();
        vi.advanceTimersByTime(10_000);

        expect(isStreamLive.mock.calls.length).toBe(looked);
        expect(onStreamRemoved).not.toHaveBeenCalled();
      });
    });

    it("a re-share within the cover stays watched and in focus", () => {
      const forgetStreamWatch = vi.fn();
      const setStreamWatched = vi.fn();
      grid.setCallbacks({ onStreamRemoved, forgetStreamWatch, setStreamWatched });
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen);
      grid.setFocusedTile(SCREEN);
      grid.addStream(SCREEN, "Otto (Screen)", null, screen);
      grid.removeStream(SCREEN);
      vi.advanceTimersByTime(2000);
      const again = fakeStream();
      grid.addStream(SCREEN, "Otto (Screen)", again, screen);

      expect(cell()!.querySelector(".video-ended")).toBeNull();
      expect(cell()!.classList.contains("video-cell--stopped")).toBe(false);
      expect(cell()!.querySelector("video")!.srcObject).toBe(again);
      expect(grid.getFocusedTileId()).toBe(SCREEN);
      vi.advanceTimersByTime(3000);
      expect(forgetStreamWatch).not.toHaveBeenCalled();
      expect(setStreamWatched).not.toHaveBeenCalledWith(SCREEN, false);
    });

    it("after the cover the watch is forgotten: a later share is offered as Watch", () => {
      const forgetStreamWatch = vi.fn();
      grid.setCallbacks({ onStreamRemoved, forgetStreamWatch });
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen);
      grid.removeStream(SCREEN);
      vi.advanceTimersByTime(2999);
      expect(forgetStreamWatch).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(forgetStreamWatch).toHaveBeenCalledWith(SCREEN);

      grid.addStream(SCREEN, "Otto (Screen)", null, screen);
      expect(cell()!.classList.contains("video-cell--stopped")).toBe(true);
      expect(cell()!.querySelector("[data-tile-control='watch']")).not.toBeNull();
    });

    it("leaving the call during the cover forgets the held watch", () => {
      const forgetStreamWatch = vi.fn();
      grid.setCallbacks({ onStreamRemoved, forgetStreamWatch });
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen);
      grid.removeStream(SCREEN);
      grid.clearStreams();
      expect(forgetStreamWatch).toHaveBeenCalledWith(SCREEN);
    });

    it("leaving the call drops the cover at once", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen);
      grid.removeStream(SCREEN);
      grid.clearStreams();

      expect(cell()).toBeNull();
      vi.advanceTimersByTime(3000);
      expect(onStreamRemoved).not.toHaveBeenCalled();
    });
  });
});
