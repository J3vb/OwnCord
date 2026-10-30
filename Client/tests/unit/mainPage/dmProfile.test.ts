import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/mainPageMocks";
import { noteJoinFailed, noteJoinSucceeded } from "../../../src/features/voice/joinBackoff";
import { savePref } from "../../../src/lib/prefs/preferences";
import { createMainPage } from "../../../src/pages/MainPage";
import { channelsStore, setActiveChannel } from "../../../src/stores/channels.store";
import { uiStore } from "../../../src/stores/ui.store";
import { voiceStore } from "../../../src/stores/voice.store";
import { dmStore, updateDmParticipant } from "../../../src/stores/dm.store";
import { alertSupersededCall } from "../../../src/features/direct-messages/callAlerts";
import {
  resetStores,
  fakeWs,
  fakeApi,
  textChannel,
  dmChannel,
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
vi.mock("../../../src/components/message-list/attachments", (importOriginal) =>
  mocks.listAttachmentsMock(importOriginal),
);
vi.mock("../../../src/pages/main-page/ChannelController", () => mocks.pageChannelControllerMock());
vi.mock("../../../src/pages/main-page/SidebarArea", () => mocks.pageSidebarAreaMock());
vi.mock("../../../src/features/navigation/destinations", () => mocks.navigationDestinationsMock());
vi.mock("../../../src/pages/main-page/ChatArea", () => mocks.pageChatAreaMock());

const {
  mockMountChannel,
  mockDestroyChannel,
  mockCreateSidebarArea,
  mockCreateChatArea,
  capturedChatAreaRef,
} = mocks;

// The remembered-open pref must never leak between tests, whatever their order.
afterEach(() => {
  localStorage.removeItem("owncord:settings:dmProfileOpen");
});

describe("MainPage — video grid, DM profile panel, calls, settings", () => {
  let container: HTMLDivElement;
  let page: ReturnType<typeof createMainPage>;

  beforeEach(() => {
    resetStores();
    mockMountChannel.mockClear();
    mockDestroyChannel.mockClear();
    mockCreateChatArea.mockClear();
    capturedChatAreaRef.current = null;
    // The panel opens with a 1:1 DM by default (WP 3B-3); the toggle tests below
    // start from "remembered closed" and the auto-open tests set it back.
    savePref("dmProfileOpen", false);
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    page?.destroy?.();
    container.remove();
    localStorage.removeItem("owncord:settings:dmProfileOpen");
  });

  describe("DM profile panel is open by default and remembered", () => {
    const panel = (): HTMLElement | null =>
      capturedChatAreaRef.current!.dmProfileSlot.querySelector<HTMLElement>(
        '[data-testid="dm-profile-sidebar"]',
      );
    const names = (): string | undefined =>
      capturedChatAreaRef.current!.dmProfileSlot.querySelector<HTMLElement>(
        '[data-testid="dps-username"]',
      )?.textContent ?? undefined;
    const pref = (): string | null => localStorage.getItem("owncord:settings:dmProfileOpen");
    const oneToOne = (channelId: number, userId: number, username: string) => ({
      channelId,
      recipient: { id: userId, username, avatar: "", status: "online" },
      participants: [{ id: userId, username, avatar: "", status: "online" }],
      name: "",
      isGroup: false,
      lastMessageId: null,
      lastMessage: "",
      lastMessageAt: "",
      unreadCount: 0,
      mentionCount: 0,
    });
    function mountOnTwoDms(): void {
      channelsStore.setState((prev) => {
        const ch = new Map(prev.channels);
        ch.set(1, textChannel(1, "general"));
        ch.set(70, dmChannel(70, "dm-bob"));
        ch.set(71, dmChannel(71, "dm-carol"));
        ch.set(72, dmChannel(72, "group"));
        return { ...prev, channels: ch, activeChannelId: 70 };
      });
      dmStore.setState(() => ({
        channels: [
          oneToOne(70, 7, "bob"),
          oneToOne(71, 8, "carol"),
          { ...oneToOne(72, 9, "dave"), isGroup: true, name: "group" },
        ],
      }));
      page = createMainPage({ ws: fakeWs(), api: fakeApi() });
      page.mount(container);
      // The mocked chat area's slot is detached; focus needs it in the document.
      container.appendChild(capturedChatAreaRef.current!.dmProfileSlot);
    }
    async function settle(): Promise<void> {
      await import("@components/DmProfileSidebar");
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    it("opens with a 1:1 DM at mount and keeps the panel, updated for the second user, on a DM switch", async () => {
      savePref("dmProfileOpen", true);
      mountOnTwoDms();
      await vi.waitFor(() => expect(names()).toBe("bob"));
      expect(capturedChatAreaRef.current!.profileBtn.getAttribute("aria-pressed")).toBe("true");
      const before = panel();

      setActiveChannel(71);
      channelsStore.flush();
      await vi.waitFor(() => expect(names()).toBe("carol"));
      // The same panel node, repainted: it does not slide in again.
      expect(panel()).toBe(before);
      expect(
        capturedChatAreaRef.current!.dmProfileSlot.querySelectorAll(
          '[data-testid="dm-profile-sidebar"]',
        ),
      ).toHaveLength(1);
      expect(pref()).toBe("true");
    });

    it("opens by default when nothing was saved", async () => {
      localStorage.removeItem("owncord:settings:dmProfileOpen");
      mountOnTwoDms();
      await vi.waitFor(() => expect(panel()).not.toBeNull());
    });

    it("stays closed on mount and on a DM switch when the saved preference is false", async () => {
      mountOnTwoDms();
      await settle();
      expect(panel()).toBeNull();
      setActiveChannel(71);
      channelsStore.flush();
      await settle();
      expect(panel()).toBeNull();
      expect(capturedChatAreaRef.current!.profileBtn.getAttribute("aria-pressed")).toBe("false");
    });

    it("hides for a group or a server channel without changing the preference, and returns for the next 1:1 DM", async () => {
      savePref("dmProfileOpen", true);
      mountOnTwoDms();
      await vi.waitFor(() => expect(panel()).not.toBeNull());

      setActiveChannel(72);
      channelsStore.flush();
      await settle();
      expect(panel()).toBeNull();
      expect(pref()).toBe("true");

      setActiveChannel(1);
      channelsStore.flush();
      await settle();
      expect(panel()).toBeNull();

      setActiveChannel(71);
      channelsStore.flush();
      await vi.waitFor(() => expect(names()).toBe("carol"));
    });

    it("the header's Show User Profile toggle closes, remembers false, then reopens and remembers true", async () => {
      savePref("dmProfileOpen", true);
      mountOnTwoDms();
      await vi.waitFor(() => expect(panel()).not.toBeNull());
      const toggle = (): void => mockCreateChatArea.mock.calls[0]![0].onToggleDmProfile();
      const pressed = (): string | null =>
        capturedChatAreaRef.current!.profileBtn.getAttribute("aria-pressed");

      toggle();
      expect(panel()).toBeNull();
      expect(pressed()).toBe("false");
      expect(pref()).toBe("false");

      toggle();
      await vi.waitFor(() => expect(panel()).not.toBeNull());
      expect(pressed()).toBe("true");
      expect(pref()).toBe("true");
    });

    describe("focus and Escape", () => {
      let composer: HTMLTextAreaElement;
      beforeEach(() => {
        composer = document.createElement("textarea");
        document.body.appendChild(composer);
      });
      afterEach(() => composer.remove());
      const escape = (target: EventTarget = document): KeyboardEvent => {
        // The Settings panel is mounted inside its closed overlay, which only the
        // stylesheet hides; jsdom has none, so hide it or it counts as a dialog.
        for (const settings of document.querySelectorAll<HTMLElement>(".settings-panel")) {
          if (settings.parentElement !== null) settings.parentElement.style.display = "none";
        }
        const ev = new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        });
        target.dispatchEvent(ev);
        return ev;
      };

      it("does not steal focus when the panel opens by itself, at mount or on a DM switch", async () => {
        savePref("dmProfileOpen", true);
        composer.focus();
        mountOnTwoDms();
        await vi.waitFor(() => expect(names()).toBe("bob"));
        expect(document.activeElement).toBe(composer);

        setActiveChannel(71);
        channelsStore.flush();
        await vi.waitFor(() => expect(names()).toBe("carol"));
        expect(document.activeElement).toBe(composer);
      });

      it("does focus the panel when the user opens it from the header", async () => {
        mountOnTwoDms();
        mockCreateChatArea.mock.calls[0]![0].onToggleDmProfile();
        await vi.waitFor(() => expect(panel()).not.toBeNull());
        expect(panel()!.contains(document.activeElement)).toBe(true);
      });

      it("keeps the panel and the pref when a field already used the Escape", async () => {
        savePref("dmProfileOpen", true);
        mountOnTwoDms();
        await vi.waitFor(() => expect(panel()).not.toBeNull());
        const note = panel()!.querySelector<HTMLTextAreaElement>('[data-testid="dps-note"]')!;
        note.focus();
        note.addEventListener("keydown", (e) => e.preventDefault(), { once: true });
        escape(note);
        expect(panel()).not.toBeNull();
        expect(pref()).toBe("true");
      });

      it("ignores an Escape while focus is outside the panel", async () => {
        savePref("dmProfileOpen", true);
        mountOnTwoDms();
        await vi.waitFor(() => expect(panel()).not.toBeNull());
        composer.focus();
        escape(composer);
        expect(panel()).not.toBeNull();
        expect(pref()).toBe("true");
      });

      it("closes on Escape with focus inside and remembers it", async () => {
        savePref("dmProfileOpen", true);
        mountOnTwoDms();
        await vi.waitFor(() => expect(panel()).not.toBeNull());
        panel()!.focus();
        escape();
        expect(panel()).toBeNull();
        expect(pref()).toBe("false");
      });

      it("leaves the panel open when Escape belongs to a dialog opened before it", async () => {
        savePref("dmProfileOpen", true);
        const dialog = document.createElement("div");
        dialog.className = "modal-overlay";
        document.body.appendChild(dialog);
        try {
          mountOnTwoDms();
          await vi.waitFor(() => expect(panel()).not.toBeNull());
          panel()!.focus();
          escape();
          expect(panel()).not.toBeNull();
          expect(pref()).toBe("true");
        } finally {
          dialog.remove();
        }
      });
    });

    it("closing with the panel's own close button is remembered", async () => {
      savePref("dmProfileOpen", true);
      mountOnTwoDms();
      await vi.waitFor(() => expect(panel()).not.toBeNull());
      capturedChatAreaRef
        .current!.dmProfileSlot.querySelector<HTMLButtonElement>('[data-testid="dps-close"]')
        ?.click();
      expect(panel()).toBeNull();
      expect(pref()).toBe("false");
    });
  });

  it("does not open the 1:1 profile panel for a group DM header click", () => {
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(50, dmChannel(50, "Group Chat"));
      return { ...prev, channels: ch, activeChannelId: 50 };
    });
    dmStore.setState(() => ({
      channels: [
        {
          channelId: 50,
          recipient: { id: 10, username: "alice", avatar: "", status: "online" },
          participants: [
            { id: 10, username: "alice", avatar: "", status: "online" },
            { id: 11, username: "bob", avatar: "", status: "online" },
          ],
          name: "Group Chat",
          isGroup: true,
          lastMessageId: null,
          lastMessage: "",
          lastMessageAt: "",
          unreadCount: 0,
          mentionCount: 0,
        },
      ],
    }));

    page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    page.mount(container);

    const chatAreaOpts = mockCreateChatArea.mock.calls[0]![0];
    chatAreaOpts.onToggleDmProfile();

    // dm.store.ts documents .recipient as "the first of participants" for a
    // group, with the explicit instruction that group-correct code reads
    // .participants instead — a 1:1 panel built from .recipient would show
    // one arbitrary member's identity as if it were the whole conversation.
    expect(
      capturedChatAreaRef.current!.dmProfileSlot.querySelector(
        '[data-testid="dm-profile-sidebar"]',
      ),
    ).toBeNull();
  });

  it("does not ring or announce 'Calling…' when starting a call while the socket is reconnecting", () => {
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(50, dmChannel(50, "dm-alice"));
      return { ...prev, channels: ch, activeChannelId: 50 };
    });
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "reconnecting" }));

    const ws = fakeWs();
    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);

    const chatAreaOpts = mockCreateChatArea.mock.calls[0]![0];
    chatAreaOpts.onStartCall();

    // onVoiceJoin already silently refuses to join while the socket is down
    // (VoiceCallbacks.ts's socketLive() guard) — startCall must not still
    // ring and tell the user "Calling…" over a call nobody can hear.
    expect(ws.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "call_ring" }));
  });

  it("keeps an incoming ring alive when Accept is clicked while the socket is reconnecting", () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));

    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);

    ws.emit("call_incoming", { channel_id: 50, from_user: 10, username: "alice" });

    const banner = document.querySelector('[data-testid="incoming-call-banner"]') as HTMLElement;
    expect(banner.style.display).not.toBe("none");

    // The socket drops mid-ring.
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "reconnecting" }));

    const acceptBtn = document.querySelector('[data-testid="incoming-call-accept"]') as HTMLElement;
    acceptBtn.click();

    // Accepting while reconnecting must not silently consume the ring (the
    // banner clearing means ringCtrl.accept() ran and nothing rejoins) — the
    // ring has to survive so the user can accept again once reconnected.
    expect(banner.style.display).not.toBe("none");
  });

  it("keeps an incoming ring alive when Accept is clicked during the join backoff", () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    noteJoinFailed();

    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);

    ws.emit("call_incoming", { channel_id: 50, from_user: 10, username: "alice" });

    const banner = document.querySelector('[data-testid="incoming-call-banner"]') as HTMLElement;
    const acceptBtn = document.querySelector('[data-testid="incoming-call-accept"]') as HTMLElement;
    acceptBtn.click();

    expect(banner.style.display).not.toBe("none");
    expect(ws.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "voice_join" }));
    expect(document.body.textContent).toContain("Voice join failed — try again in 2 s");

    noteJoinFailed(Date.now(), true);
    acceptBtn.click();
    expect(document.body.textContent).toContain("Please wait 4 s before switching voice channels");

    noteJoinSucceeded();
    acceptBtn.click();
    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({ type: "voice_join" }));
  });

  it("Join with video on the incoming banner joins and turns the camera on once connected (3B-4)", async () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);
    await vi.dynamicImportSettled();
    const lk = await import("@lib/voice/livekitSession");
    vi.mocked(lk.enableCamera).mockClear();

    ws.emit("call_incoming", { channel_id: 50, from_user: 10, username: "alice" });
    (document.querySelector('[data-testid="incoming-call-accept-video"]') as HTMLElement).click();
    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({ type: "voice_join" }));
    expect(lk.enableCamera).not.toHaveBeenCalled();

    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 50, voiceStatus: "connected" }));
    voiceStore.flush();
    expect(lk.enableCamera).toHaveBeenCalledTimes(1);
    vi.mocked(lk.enableCamera).mockClear();
    page.destroy?.();
  });

  it("Ctrl+Enter accepts and Escape declines a ringing call (3B-4)", () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);

    ws.emit("call_incoming", { channel_id: 50, from_user: 10, username: "alice" });
    // The closed Settings panel is hidden by stylesheet only, which jsdom does
    // not load; hide it the way the real page's CSS does.
    const settingsOverlay = document.querySelector<HTMLElement>('[data-testid="settings-overlay"]');
    expect(settingsOverlay).not.toBeNull();
    settingsOverlay!.style.display = "none";
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, cancelable: true }),
    );
    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({ type: "voice_join" }));

    ws.emit("call_incoming", { channel_id: 51, from_user: 11, username: "carol" });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(ws.send).toHaveBeenCalledWith({ type: "call_decline", payload: { channel_id: 51 } });
    page.destroy?.();
  });

  it("a ring replaced by a ring from another channel reports the first as missed (3B-4)", async () => {
    const ws = fakeWs();
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    page = createMainPage({ ws, api: fakeApi() });
    page.mount(container);
    vi.mocked(alertSupersededCall).mockClear();

    ws.emit("call_incoming", { channel_id: 50, from_user: 10, username: "alice" });
    ws.emit("call_incoming", { channel_id: 50, from_user: 10, username: "alice" });
    await vi.dynamicImportSettled();
    expect(alertSupersededCall).not.toHaveBeenCalled();

    ws.emit("call_incoming", { channel_id: 51, from_user: 11, username: "carol" });
    await vi.waitFor(() => expect(alertSupersededCall).toHaveBeenCalledTimes(1));
    expect(vi.mocked(alertSupersededCall).mock.calls[0]![0]).toMatchObject({ channelId: 50 });
    page.destroy?.();
  });

  it("keeps the open DM profile panel's status and name live, like the chat header does", async () => {
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(70, dmChannel(70, "dm-bob"));
      return { ...prev, channels: ch, activeChannelId: 70 };
    });
    dmStore.setState(() => ({
      channels: [
        {
          channelId: 70,
          recipient: { id: 7, username: "bob", avatar: "", status: "online" },
          participants: [{ id: 7, username: "bob", avatar: "", status: "online" }],
          name: "bob",
          isGroup: false,
          lastMessageId: null,
          lastMessage: "",
          lastMessageAt: "",
          unreadCount: 0,
          mentionCount: 0,
        },
      ],
    }));

    page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    page.mount(container);

    const chatAreaOpts = mockCreateChatArea.mock.calls[0]![0];
    chatAreaOpts.onToggleDmProfile();

    const slot = capturedChatAreaRef.current!.dmProfileSlot;
    // The panel loads on demand; wait for its import to mount it.
    await vi.waitFor(() => {
      expect(slot.querySelector('[data-testid="dps-status"]')).not.toBeNull();
    });
    const statusEl = slot.querySelector('[data-testid="dps-status"]') as HTMLElement;
    const nameEl = slot.querySelector('[data-testid="dps-username"]') as HTMLElement;
    expect(statusEl.textContent).toContain("Online");
    expect(nameEl.textContent).toBe("bob");

    // Bob goes offline and sets a nickname while the panel stays open, via
    // the same updateDmParticipant call dispatcher.ts's PRESENCE and
    // USER_UPDATE handlers make. The chat header this panel was opened from
    // already stays live across this (ChannelController.ts:621-638) — the
    // profile panel beside it must not be left showing the opposite.
    updateDmParticipant(7, { status: "offline", displayName: "Bobby" });
    dmStore.flush();

    expect(statusEl.textContent).toContain("Offline");
    expect(nameEl.textContent).toBe("Bobby");
  });

  /** Mount the page on a DM with bob and return its profile toggle and slot. */
  function mountOnDm(): { toggle: () => void; slot: HTMLElement } {
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(70, dmChannel(70, "dm-bob"));
      return { ...prev, channels: ch, activeChannelId: 70 };
    });
    dmStore.setState(() => ({
      channels: [
        {
          channelId: 70,
          recipient: { id: 7, username: "bob", avatar: "", status: "online" },
          participants: [{ id: 7, username: "bob", avatar: "", status: "online" }],
          name: "bob",
          isGroup: false,
          lastMessageId: null,
          lastMessage: "",
          lastMessageAt: "",
          unreadCount: 0,
          mentionCount: 0,
        },
      ],
    }));
    page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    page.mount(container);
    const chatAreaOpts = mockCreateChatArea.mock.calls[0]![0];
    return {
      toggle: () => chatAreaOpts.onToggleDmProfile(),
      slot: capturedChatAreaRef.current!.dmProfileSlot,
    };
  }

  /** Let the panel's lazy import (and anything it schedules) settle. */
  async function settleDmProfileImport(): Promise<void> {
    await import("@components/DmProfileSidebar");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("a close click while the DM profile panel is still loading leaves it closed", async () => {
    const { toggle, slot } = mountOnDm();
    toggle();
    toggle();
    await settleDmProfileImport();
    expect(slot.querySelector('[data-testid="dps-status"]')).toBeNull();

    // The dropped load does not wedge the toggle: the next click opens it.
    toggle();
    await vi.waitFor(() => {
      expect(slot.querySelectorAll('[data-testid="dps-status"]')).toHaveLength(1);
    });
  });

  it("the DM row menu's Profile on a DM that is not active shows that DM's panel", async () => {
    const { slot } = mountOnDm();
    const bob = dmStore.getState().channels[0]!;
    dmStore.setState(() => ({
      channels: [
        bob,
        {
          ...bob,
          channelId: 71,
          recipient: { id: 8, username: "carol", avatar: "", status: "online" },
          participants: [{ id: 8, username: "carol", avatar: "", status: "online" }],
          name: "carol",
        },
      ],
    }));
    const sidebarOpts = mockCreateSidebarArea.mock.calls.at(-1)![0] as {
      onOpenDmProfile: () => void;
    };
    // What SidebarArea's row menu does: select the DM, then ask for the panel
    // in the same tick, before the store's listeners have run.
    channelsStore.setState((prev) => {
      const ch = new Map(prev.channels);
      ch.set(71, dmChannel(71, "dm-carol"));
      return { ...prev, channels: ch };
    });
    setActiveChannel(71);
    sidebarOpts.onOpenDmProfile();
    await vi.waitFor(() => {
      expect(slot.querySelector('[data-testid="dps-username"]')?.textContent).toBe("carol");
    });
    await settleDmProfileImport();
    expect(slot.querySelectorAll('[data-testid="dps-username"]')).toHaveLength(1);
  });

  it("the last of several quick DM profile clicks wins, with one panel at most", async () => {
    const { toggle, slot } = mountOnDm();
    toggle();
    toggle();
    toggle();
    await settleDmProfileImport();
    expect(slot.querySelectorAll('[data-testid="dps-status"]')).toHaveLength(1);

    toggle();
    expect(slot.querySelector('[data-testid="dps-status"]')).toBeNull();
  });
});
