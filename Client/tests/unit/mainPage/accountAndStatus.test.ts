import { describe, it, expect, vi } from "vitest";
import * as mocks from "../../helpers/mainPageMocks";
import { createMainPage } from "../../../src/pages/MainPage";
import { channelsStore } from "../../../src/stores/channels.store";
import { authStore, clearAuth } from "../../../src/stores/auth.store";
import { uiStore } from "../../../src/stores/ui.store";
import { wireConnectionStatus } from "../../../src/lib/dispatcher";
import { createMockWsClient } from "../../helpers/mock-ws";
import { voiceStore } from "../../../src/stores/voice.store";
import { dmStore } from "../../../src/stores/dm.store";
import type { ApiClient } from "../../../src/lib/api";
import { renderYouTubeEmbed } from "../../../src/features/messaging/content/media";
import { renderGenericLinkPreview } from "../../../src/features/messaging/content/embeds";
import {
  externalPartition,
  fetchExternalImage,
} from "../../../src/features/messaging/content/attachments";
import { desktop } from "../../../src/platform/desktop";
import { saveUserStatus } from "../../../src/lib/presence/userStatus";
import { markAllRead } from "../../../src/lib/readState";
import {
  fakeWs,
  fakeApi,
  textChannel,
  dmChannel,
  useMainPageHarness,
  useMainPageScope,
  mountPage,
  seedChannels,
  oneToOneDm,
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

const {
  capturedAutoIdleOptions,
  autoIdleController,
  mockCreateChatArea,
  capturedChatAreaRef,
  mockPruneAttachmentCacheScope,
} = mocks;

type UiPatch = Partial<ReturnType<typeof uiStore.getState>>;

/** Mounts the page as a signed-in user, applies `ui`, and returns the status banner. */
function mountWithBanner(container: HTMLDivElement, ui: UiPatch) {
  const ws = fakeWs();
  authStore.setState((prev) => ({ ...prev, token: "tok-here" }));
  const page = mountPage(container, ws, fakeApi("chat.example.com"));
  uiStore.setState((prev) => ({ ...prev, ...ui }));
  const banner = container.querySelector<HTMLElement>(".reconnecting-banner")!;
  return { ws, page, banner };
}

describe("MainPage — video grid, DM profile panel, calls, settings", () => {
  let container: HTMLDivElement;
  let page: ReturnType<typeof createMainPage>;

  useMainPageHarness({
    wired: (c) => {
      container = c;
    },
    currentPage: () => page,
  });

  it("clears every external-content cache on sign-out so one server's previews never reach the next", async () => {
    const preview = vi.spyOn(desktop.externalContent, "preview").mockResolvedValue({
      ok: true,
      value: { title: "T", description: null, siteName: null, image: null },
    });
    const image = vi
      .spyOn(desktop.externalContent, "image")
      .mockResolvedValue({ ok: true, value: new Blob(["x"]) });
    const createObjectURL = URL.createObjectURL;
    const revokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:teardown");
    URL.revokeObjectURL = vi.fn();
    const pageUrl = "https://news.example.com/teardown";
    const imageUrl = "https://img.example.com/teardown.png";
    const asked = (url: string): number => preview.mock.calls.filter((c) => c[1] === url).length;
    const fetched = (url: string): number =>
      image.mock.calls.filter((c) => "url" in c[1] && c[1].url === url).length;
    const oembed = (): number =>
      preview.mock.calls.filter((c) => c[1].includes("oembed") && c[1].includes("tdvid")).length;
    try {
      page = mountPage(container);

      // Fill each external cache once, and prove a re-render is served from it.
      renderGenericLinkPreview(pageUrl);
      renderYouTubeEmbed("tdvid", "https://youtu.be/tdvid");
      await fetchExternalImage({ url: imageUrl });
      await vi.waitFor(() => expect(asked(pageUrl) + oembed()).toBe(2));
      await new Promise((r) => setTimeout(r, 0));
      renderGenericLinkPreview(pageUrl);
      renderYouTubeEmbed("tdvid", "https://youtu.be/tdvid");
      await fetchExternalImage({ url: imageUrl });
      expect(asked(pageUrl)).toBe(1);
      expect(oembed()).toBe(1);
      expect(fetched(imageUrl)).toBe(1);
      const partitionBefore = externalPartition();

      // The caches reset with the session (sessionRegistry, cache phase); the
      // page itself only tears down its DOM and controllers.
      clearAuth("server_switch");
      page.destroy?.();

      // Every one of them is asked for again, under a fresh broker partition.
      expect(externalPartition()).not.toBe(partitionBefore);
      renderGenericLinkPreview(pageUrl);
      renderYouTubeEmbed("tdvid", "https://youtu.be/tdvid");
      await fetchExternalImage({ url: imageUrl });
      await vi.waitFor(() => {
        expect(asked(pageUrl)).toBe(2);
        expect(oembed()).toBe(2);
      });
      expect(fetched(imageUrl)).toBe(2);
      expect(image).toHaveBeenLastCalledWith(externalPartition(), { url: imageUrl });
    } finally {
      preview.mockRestore();
      image.mockRestore();
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
    }
  });

  it("scopes DM profile notes to the connected host, like channel mutes and the NSFW gate", async () => {
    seedChannels([dmChannel(60, "dm-carol")], 60);
    dmStore.setState(() => ({
      channels: [{ ...oneToOneDm(60, 5, "carol"), name: "carol" }],
    }));

    const hostedApi = {
      getConfig: () => ({ host: "chat.example.com" }),
      getSession: () => ({ signal: new AbortController().signal }),
      getReactionUsers: vi.fn(async () => ({ users: [] })),
      getRecoveryKitStatus: vi.fn(async () => ({ enrolled: false, used_at: null })),
      getSessions: vi.fn(async () => []),
    } as unknown as ApiClient;

    page = mountPage(container, fakeWs(), hostedApi);

    const chatAreaOpts = mockCreateChatArea.mock.calls[0]![0];
    chatAreaOpts.onToggleDmProfile();
    // The panel loads on demand; wait for its import to mount it.
    await vi.waitFor(() => {
      expect(
        capturedChatAreaRef.current!.dmProfileSlot.querySelector('[data-testid="dps-note"]'),
      ).not.toBeNull();
    });

    const noteEl = capturedChatAreaRef.current!.dmProfileSlot.querySelector(
      '[data-testid="dps-note"]',
    ) as HTMLTextAreaElement;
    noteEl.value = "owes me money";
    noteEl.dispatchEvent(new Event("input"));

    try {
      // Server A's note about user 5 must land under a key scoped to server A
      // — the same host scoping already applied to channel mutes and
      // per-user volume (setChannelMutesHost/setAudioVolumeHost, both called
      // with apiConfig.host above).
      expect(localStorage.getItem("owncord:dm-note:chat.example.com:5")).toBe("owes me money");
      // And it must not have gone to the legacy unscoped key, which server
      // B's unrelated user 5 would also read from.
      expect(localStorage.getItem("owncord:dm-note:5")).toBeNull();
    } finally {
      localStorage.removeItem("owncord:dm-note:chat.example.com:5");
      localStorage.removeItem("owncord:dm-note:5");
    }
  });

  it("surfaces the server's partial-success warning on a password change instead of an unqualified success", async () => {
    // PUT /users/me/password answers 200 + warning (not 204) when the
    // password changed but the other sessions could not be revoked. The
    // warning is the only thing telling the user to revoke them by hand,
    // so a green "changed successfully" toast here would hide a live
    // stolen session.
    const warning =
      "password changed, but other sessions could not be revoked; revoke them from the sessions list";
    const hostedApi = {
      getConfig: () => ({ host: "chat.example.com" }),
      getSession: () => ({ signal: new AbortController().signal }),
      changePassword: vi.fn(async () => ({ warning, sessions_revoked: 0 })),
      getRecoveryKitStatus: vi.fn(async () => ({ enrolled: false, used_at: null })),
      getSessions: vi.fn(async () => []),
    } as unknown as ApiClient;

    page = mountPage(container, fakeWs(), hostedApi);
    uiStore.setState((prev) => ({ ...prev, settingsOpen: true }));
    // The store notifies on the next tick, and opening rebuilds the live
    // Account tab then — drive the form a user would see, not the
    // placeholder built at mount.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const inputs = [...container.querySelectorAll<HTMLInputElement>("input[type='password']")];
    const byPlaceholder = (placeholder: string): HTMLInputElement => {
      const el = inputs.find((i) => i.placeholder === placeholder);
      if (el === undefined) throw new Error(`no password input with placeholder ${placeholder}`);
      return el;
    };
    byPlaceholder("Old password").value = "old-password";
    byPlaceholder("New password").value = "new-password-1";
    byPlaceholder("Confirm new password").value = "new-password-1";
    const changeBtn = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Change Password",
    );
    if (changeBtn === undefined) throw new Error("no Change Password button");
    changeBtn.click();

    await vi.waitFor(() => {
      expect(hostedApi.changePassword).toHaveBeenCalledWith("old-password", "new-password-1");
      const toast = container.querySelector('[data-testid="toast"]');
      expect(toast).not.toBeNull();
      expect(toast!.classList.contains("toast-warning")).toBe(true);
      expect(toast!.textContent).toBe(warning);
    });
    expect(container.querySelector(".toast-success")).toBeNull();
    // The form carries the same warning inline (Codex P2 on PR #1503): no
    // green "changed successfully" beside the warning toast.
    // The toast is shown before the callback resolves, so the form's own
    // update lands a microtask later.
    const status = container.querySelector<HTMLElement>('[data-testid="pw-change-status"]');
    expect(status).not.toBeNull();
    await vi.waitFor(() => {
      expect(status!.textContent).toBe(warning);
    });
    // B9-23: the inline warning is the qualified .form-warning class, not an
    // inline --yellow (1.89:1 on light), and keeps the live role it was
    // created with so the swap to the warning text is announced.
    expect(status!.classList.contains("form-warning")).toBe(true);
    expect(status!.getAttribute("role")).toBe("alert");
    expect(container.textContent).not.toContain("Password changed successfully.");
  });

  it("shows Signed in elsewhere on SESSION_REPLACED, and Use here reconnects this device", async () => {
    const mounted = mountWithBanner(container, {
      sessionReplaced: true,
      connectionStatus: "disconnected",
    });
    page = mounted.page;
    const { ws, banner } = mounted;
    await vi.waitFor(() => {
      expect(banner.textContent).toBe("Signed in elsewhere Use here");
    });
    banner.querySelector("button")!.click();

    expect(ws.connect).toHaveBeenCalledWith(
      { host: "chat.example.com", token: "tok-here" },
      { takeover: true },
    );
    expect(uiStore.getState().sessionReplaced).toBe(false);
  });

  it("shows an actionable connection notice on disconnect and Retry redials", async () => {
    const mounted = mountWithBanner(container, {
      sessionReplaced: false,
      connectionStatus: "disconnected",
    });
    page = mounted.page;
    const { ws, banner } = mounted;
    await vi.waitFor(() => {
      expect(banner.textContent).toContain("Can't reach this server");
    });

    const retry = banner.querySelector("button")!;
    expect(retry.textContent).toBe("Retry");
    retry.click();
    expect(ws.connect).toHaveBeenCalledWith({ host: "chat.example.com", token: "tok-here" });
  });

  it("keeps Reconnecting... until a dial fails, then offers Retry", async () => {
    const mounted = mountWithBanner(container, {
      sessionReplaced: false,
      connectionStatus: "reconnecting",
      connectionDialFailed: false,
    });
    page = mounted.page;
    const { ws, banner } = mounted;
    await vi.waitFor(() => {
      expect(banner.textContent).toBe("Reconnecting...");
    });
    expect(banner.querySelector("button")).toBeNull();

    // Same 3-state status: only the dial outcome changed.
    uiStore.setState((prev) => ({ ...prev, connectionDialFailed: true }));
    await vi.waitFor(() => {
      expect(banner.textContent).toContain("Can't reach this server");
    });
    banner.querySelector("button")!.click();
    expect(ws.connect).toHaveBeenCalledWith({ host: "chat.example.com", token: "tok-here" });
    uiStore.setState((prev) => ({ ...prev, connectionDialFailed: false }));
  });

  it("holds one unreachable notice and Retry across repeated failed dials", async () => {
    const socket = createMockWsClient();
    const unwire = wireConnectionStatus(socket);
    const ws = fakeWs();
    authStore.setState((prev) => ({ ...prev, token: "tok-here" }));
    socket.simulateStateChange("connecting");
    socket.simulateStateChange("authenticating");
    socket.simulateStateChange("connected");
    page = mountPage(container, ws, fakeApi("chat.example.com"));

    const banner = container.querySelector<HTMLElement>(".reconnecting-banner")!;
    const live = container.querySelector<HTMLElement>("[data-testid='banner-announce']")!;
    const unreachable =
      "Can't reach this server right now. It may be down or blocked on this network.";
    const announced: string[] = [];
    const observer = new MutationObserver(() => announced.push(live.textContent ?? ""));
    observer.observe(live, { childList: true, characterData: true, subtree: true });
    const settle = async (): Promise<void> => {
      uiStore.flush();
      await Promise.resolve();
    };

    try {
      socket.simulateStateChange("reconnecting");
      await settle();
      expect(banner.textContent).toBe("Reconnecting...");

      socket.simulateStateChange("connecting");
      socket.simulateStateChange("reconnecting");
      await settle();
      expect(banner.textContent).toBe(`${unreachable} Retry`);

      for (let cycle = 0; cycle < 2; cycle++) {
        socket.simulateStateChange("connecting");
        await settle();
        expect(banner.textContent).toBe(`${unreachable} Retry`);
        expect(banner.querySelector("button")).not.toBeNull();
        socket.simulateStateChange("reconnecting");
        await settle();
        expect(banner.textContent).toBe(`${unreachable} Retry`);
        expect(banner.querySelector("button")).not.toBeNull();
      }

      expect(announced.filter((text) => text === unreachable)).toHaveLength(1);
    } finally {
      observer.disconnect();
      unwire();
      uiStore.setState((prev) => ({
        ...prev,
        connectionStatus: "disconnected",
        connectionDialFailed: false,
      }));
    }
  });

  it("re-renders the notice on network loss and return without redialing", async () => {
    const mounted = mountWithBanner(container, {
      sessionReplaced: false,
      connectionStatus: "disconnected",
    });
    page = mounted.page;
    const { ws, banner } = mounted;
    await vi.waitFor(() => {
      expect(banner.textContent).toContain("Can't reach this server");
    });

    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    try {
      window.dispatchEvent(new Event("offline"));
      expect(banner.textContent).toContain("Your device reports no network connection");

      onLine.mockReturnValue(true);
      window.dispatchEvent(new Event("online"));
      expect(banner.textContent).toContain("Can't reach this server");
    } finally {
      onLine.mockRestore();
    }
    expect(ws.connect).not.toHaveBeenCalled();
  });

  it("does not clear a pending restart countdown on a network flap", () => {
    const ws = fakeWs();
    authStore.setState((prev) => ({ ...prev, token: "tok-here" }));
    page = mountPage(container, ws, fakeApi("chat.example.com"));

    // The server announces a restart while the socket is live.
    ws.emit("server_restart", { reason: "update", delay_seconds: 30 });
    const banner = container.querySelector<HTMLElement>(".reconnecting-banner")!;
    expect(banner.textContent).toBe("Server restarting in 30 seconds...");

    // A network interface flaps (VPN toggle / Wi-Fi blip) during the
    // countdown. The socket never dropped, so the countdown must survive.
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
    expect(banner.textContent).toBe("Server restarting in 30 seconds...");
    expect(banner.classList.contains("visible")).toBe(true);
  });

  it("counts down a shutdown notice too: the session survives a restart (Q4)", () => {
    const ws = fakeWs();
    page = mountPage(container, ws, fakeApi("chat.example.com"));

    ws.emit("server_restart", { reason: "shutdown", delay_seconds: 5 });
    const banner = container.querySelector<HTMLElement>(".reconnecting-banner")!;
    expect(banner.textContent).toBe("Server restarting in 5 seconds...");
    expect(banner.classList.contains("visible")).toBe(true);
  });

  it("clears local auth when sign-out-everywhere revoked this device's session", async () => {
    const hostedApi = {
      getConfig: () => ({ host: "chat.example.com" }),
      getSession: () => ({ signal: new AbortController().signal }),
      getRecoveryKitStatus: vi.fn(async () => ({ enrolled: false, used_at: null })),
      getSessions: vi.fn(async () => []),
      revokeAllSessions: vi.fn(async () => ({
        sessions_revoked: 2,
        current_session_revoked: true,
      })),
    } as unknown as ApiClient;
    authStore.setState((prev) => ({ ...prev, isAuthenticated: true, token: "tok" }));
    page = mountPage(container, fakeWs(), hostedApi);
    uiStore.setState((prev) => ({ ...prev, settingsOpen: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    container.querySelector<HTMLButtonElement>('[data-testid="sessions-revoke-all"]')!.click();
    container
      .querySelector<HTMLButtonElement>('[data-testid="sessions-revoke-all-confirm"]')!
      .click();

    await vi.waitFor(() => {
      expect(hostedApi.revokeAllSessions).toHaveBeenCalledOnce();
    });
    await vi.waitFor(() => {
      expect(authStore.getState().isAuthenticated).toBe(false);
    });
  });

  it("toasts a sign-in not yet reviewed from the listing made on mount", async () => {
    const hostedApi = {
      getConfig: () => ({ host: "chat.example.com" }),
      getSession: () => ({ signal: new AbortController().signal }),
      getRecoveryKitStatus: vi.fn(async () => ({ enrolled: false, used_at: null })),
      getSessions: vi.fn(async () => [
        {
          id: 9,
          device: "OwnCord-Client/1.4.0",
          ip: "198.51.100.2",
          created_at: "2026-09-21 08:00:00",
          last_used: "2026-09-21 08:00:00",
          is_current: false,
          unseen: true,
        },
      ]),
    } as unknown as ApiClient;
    page = mountPage(container, fakeWs(), hostedApi);

    await vi.waitFor(() => {
      const toast = container.querySelector('[data-testid="toast"]');
      expect(toast?.textContent).toContain("OwnCord desktop from 198.51.100.2");
    });
  });
});

describe("MainPage — presence", () => {
  let container: HTMLDivElement;
  let page: ReturnType<typeof createMainPage>;

  useMainPageScope({
    wired: (c) => {
      container = c;
    },
    currentPage: () => page,
    fakeTimers: true,
    // Match the client's own idea of the signed-in user's status to the
    // freshly-reset (default "online") saved preference, so the mount-time
    // restoreSavedPresence() call (MainPage.ts:340) is the no-op it
    // documents itself as being, and doesn't spend the single presence
    // token before this test gets to exercise applyPresence directly.
    arrange: () => {
      authStore.setState((prev) => ({
        ...prev,
        user: prev.user === null ? null : { ...prev.user, status: "online" },
      }));
      capturedAutoIdleOptions.current = null;
    },
    teardown: () => {
      localStorage.removeItem("owncord:settings:userStatus");
      localStorage.removeItem("owncord:settings:userStatusOrigin");
    },
  });

  it("does not tell auto-idle about voice calls: Idle still applies in a call", () => {
    page = mountPage(container);
    const options = capturedAutoIdleOptions.current!;
    expect(options).not.toHaveProperty("inCall");
    expect(autoIdleController).not.toHaveProperty("setInCall");

    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 7 }));
    voiceStore.flush();
    expect(authStore.getState().user?.status).toBe("online");

    voiceStore.setState((prev) => ({ ...prev, currentChannelId: null }));
  });

  it("retries the return-to-online presence_update once the limiter's window reopens instead of dropping it forever", () => {
    const ws = fakeWs();
    page = mountPage(container, ws);

    const onStatusChange = capturedAutoIdleOptions.current!.onStatusChange;

    // Auto-idle fires idle after ten quiet minutes; this consumes the single
    // presence token (1 per 10s, rate-limiter.ts).
    saveUserStatus("idle", "auto");
    onStatusChange("idle");
    expect(ws.send).toHaveBeenCalledWith({
      type: "presence_update",
      payload: { status: "idle" },
    });
    (ws.send as ReturnType<typeof vi.fn>).mockClear();

    // The very first mouse event after that flips back to online milliseconds
    // later (autoIdle.ts's unthrottled return-to-activity path) — the token
    // is still gone, so the frame cannot go out immediately.
    saveUserStatus("online", "manual");
    onStatusChange("online");
    expect(ws.send).not.toHaveBeenCalled();

    // Once the limiter's 10s window reopens (plus the OC-0451 margin that
    // clears the server's receipt-measured window), the deferred "online"
    // frame must still go out — without a retry the server and every other
    // client stay stuck on "idle" forever with no further trigger to correct
    // it.
    vi.advanceTimersByTime(11_000);

    expect(ws.send).toHaveBeenCalledWith({
      type: "presence_update",
      payload: { status: "online" },
    });
  });
});

describe("MainPage — server restart banner", () => {
  let container: HTMLDivElement;
  let page: ReturnType<typeof createMainPage>;

  useMainPageScope({
    wired: (c) => {
      container = c;
    },
    currentPage: () => page,
    fakeTimers: true,
  });

  it("re-syncs to the real (connected) status instead of counting down to a fake Reconnecting on an update_aborted cancel", () => {
    const ws = fakeWs();
    page = mountPage(container, ws);

    // Server announces a real restart countdown.
    ws.emit("server_restart", { reason: "update", delay_seconds: 5 });

    const banner = container.querySelector(".reconnecting-banner") as HTMLElement;
    expect(banner.classList.contains("visible")).toBe(true);
    expect(banner.textContent).toBe("Server restarting in 5 seconds...");

    // The staged update then fails to swap; the server cancels the countdown
    // it already announced with a zero-delay update_aborted broadcast
    // (Server/admin/update_handlers.go:181). The socket never actually
    // dropped — uiStore.connectionStatus is still "connected".
    expect(uiStore.getState().connectionStatus).toBe("connected");
    ws.emit("server_restart", { reason: "update_aborted", delay_seconds: 0 });

    // The banner must re-sync to the real (connected) status — hidden — not
    // count down to a permanent "Reconnecting..." over a healthy connection.
    expect(banner.classList.contains("visible")).toBe(false);

    // And nothing left running should later flip it to Reconnecting either
    // (the buggy path fed 0 into showRestart's setInterval, which falls
    // through remaining<=0 into showReconnecting on the very next tick).
    vi.advanceTimersByTime(2000);
    expect(banner.textContent).not.toBe("Reconnecting...");
    expect(banner.classList.contains("visible")).toBe(false);
  });
});

describe("MainPage — mark-all-read teardown", () => {
  let container: HTMLDivElement;
  let page: ReturnType<typeof createMainPage>;

  useMainPageScope({
    wired: (c) => {
      container = c;
    },
    currentPage: () => page,
    fakeTimers: true,
  });

  it("cancels a queued Mark All as Read burst on destroy instead of letting it fire after the page is torn down", () => {
    // Five unread channels: readState.ts paces sends in bursts of 4 per
    // 1100ms, so the 5th send is queued behind a timer instead of going out
    // synchronously.
    seedChannels(
      [
        { ...textChannel(1, "c1"), unreadCount: 1 },
        { ...textChannel(2, "c2"), unreadCount: 1 },
        { ...textChannel(3, "c3"), unreadCount: 1 },
        { ...textChannel(4, "c4"), unreadCount: 1 },
        { ...textChannel(5, "c5"), unreadCount: 1 },
      ],
      null,
    );

    const ws = fakeWs();
    page = mountPage(container, ws);
    // Mount can itself send (e.g. a presence re-sync) — clear those so the
    // counts below track only the mark_read burst.
    (ws.send as ReturnType<typeof vi.fn>).mockClear();

    markAllRead();

    // Only the first burst (4 channels) goes out synchronously; channel 5's
    // send is still sitting in the paced tail.
    const sendCallsAtClick = (ws.send as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(sendCallsAtClick).toBe(4);
    expect(channelsStore.getState().channels.get(5)?.unreadCount).toBe(1);

    // The user logs out / switches server before the paced tail fires. With
    // no next MainPage having mounted yet to re-register the mark-read
    // sender, this connection has been abandoned and the queued send has
    // nowhere legitimate to go.
    page.destroy?.();

    vi.advanceTimersByTime(2000);

    // The stale timer must not have fired a mark_read for channel 5 against
    // this (now-torn-down) connection, and must not have wiped its local
    // unread badge either.
    expect((ws.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(sendCallsAtClick);
    expect(
      (ws.send as ReturnType<typeof vi.fn>).mock.calls.some(
        (call) =>
          (call[0] as { type: string; payload: { channel_id: number } }).type === "mark_read" &&
          call[0].payload.channel_id === 5,
      ),
    ).toBe(false);
    expect(channelsStore.getState().channels.get(5)?.unreadCount).toBe(1);
  });
});

// B7-15c: a successful self-deletion drops that account's cached server
// images from disk, keyed by the same host#userId scope B7-13 caches under.
describe("MainPage — account deletion", () => {
  let container: HTMLDivElement;
  let page: ReturnType<typeof createMainPage>;

  useMainPageHarness({
    wired: (c) => {
      container = c;
    },
    currentPage: () => page,
  });

  async function deleteAccount(api: ApiClient): Promise<void> {
    page = mountPage(container, fakeWs(), api);
    // The Account tab (and its delete control) is only built once Settings is
    // open (DP-52), so open it before driving the delete flow.
    uiStore.setState((prev) => ({ ...prev, settingsOpen: true }));
    uiStore.flush();
    (document.querySelector("[data-testid='delete-account-trigger']") as HTMLElement).click();
    (document.querySelector("[data-testid='delete-account-password']") as HTMLInputElement).value =
      "pw";
    (document.querySelector("[data-testid='delete-account-confirm']") as HTMLElement).click();
    await vi.waitFor(() => expect(api.deleteAccount).toHaveBeenCalledWith("pw"));
    await Promise.resolve();
    await Promise.resolve();
  }

  it("prunes the deleted account's image cache scope after the server confirms", async () => {
    const api = Object.assign(fakeApi("chat.example"), {
      deleteAccount: vi.fn(async () => {}),
    }) as ApiClient;
    await deleteAccount(api);

    await vi.waitFor(() =>
      expect(mockPruneAttachmentCacheScope).toHaveBeenCalledWith("chat.example#1"),
    );
    expect(authStore.getState().isAuthenticated).toBe(false);
  });

  it("account deletion awaits the cache purge before reporting success", async () => {
    let release!: () => void;
    mockPruneAttachmentCacheScope.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const api = Object.assign(fakeApi("chat.example"), {
      deleteAccount: vi.fn(async () => {}),
    }) as ApiClient;
    await deleteAccount(api);
    await vi.waitFor(() => expect(mockPruneAttachmentCacheScope).toHaveBeenCalled());

    expect(container.querySelector(".toast-success")).toBeNull();
    release();
    await vi.waitFor(() => expect(container.querySelector(".toast-success")).not.toBeNull());
  });

  it("prunes nothing when the server refuses the deletion", async () => {
    const api = Object.assign(fakeApi("chat.example"), {
      deleteAccount: vi.fn(async () => {
        throw new Error("Wrong password");
      }),
    }) as ApiClient;
    await deleteAccount(api);

    expect(mockPruneAttachmentCacheScope).not.toHaveBeenCalled();
    expect(authStore.getState().isAuthenticated).toBe(true);
  });
});
