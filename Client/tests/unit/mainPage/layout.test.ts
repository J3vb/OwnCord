import { describe, it, expect, vi } from "vitest";
import * as mocks from "../../helpers/mainPageMocks";
import { savePref } from "../../../src/lib/prefs/preferences";
import { createMainPage } from "../../../src/pages/MainPage";
import { channelsStore, setActiveChannel } from "../../../src/stores/channels.store";
import { authStore } from "../../../src/stores/auth.store";
import { uiStore } from "../../../src/stores/ui.store";
import { voiceStore } from "../../../src/stores/voice.store";
import { dmStore } from "../../../src/stores/dm.store";
import { membersStore } from "../../../src/stores/members.store";
import { Permission } from "../../../src/lib/types";
import {
  resetStores,
  fakeWs,
  fakeApi,
  textChannel,
  dmChannel,
  useMainPageHarness,
  useMainPageScope,
  mountPage,
  seedChannels,
  mountSettled,
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
  mockMountChannel,
  mockDestroyChannel,
  mockCreateChannelController,
  mockCreateSidebarArea,
  capturedChatAreaRef,
  mockReturnToChannel,
  mockRememberChannel,
  inertModeration,
  memberPanels,
} = mocks;

describe("MainPage — activeChannelId subscriber", () => {
  let container: HTMLDivElement;
  let page: ReturnType<typeof createMainPage>;

  useMainPageHarness({
    wired: (c) => {
      container = c;
    },
    currentPage: () => page,
  });

  it("mounts the channel when an active channel is set", () => {
    seedChannels([textChannel(1, "general")], 1);

    page = mountPage(container);

    expect(mockMountChannel).toHaveBeenCalledWith(1, "general", "text");
  });

  it("destroys the mounted channel when the active channel is cleared (deleted/closed while offline)", () => {
    seedChannels([textChannel(1, "general")], 1);

    page = mountPage(container);
    expect(mockMountChannel).toHaveBeenCalledWith(1, "general", "text");

    // The channel is gone and nothing replaces it as active — this is what
    // dispatcher.ts's ready handler now does when the previously-active
    // channel is absent from a fresh snapshot.
    setActiveChannel(null);
    channelsStore.flush();

    expect(mockDestroyChannel).toHaveBeenCalledOnce();
  });

  it("mounts the newly active channel when switching between two channels", () => {
    seedChannels([textChannel(1, "general"), textChannel(2, "random", 1)], 1);

    page = mountPage(container);

    setActiveChannel(2);
    channelsStore.flush();

    expect(mockMountChannel).toHaveBeenCalledWith(2, "random", "text");
    // Switching to a real channel remounts rather than destroying.
    expect(mockDestroyChannel).not.toHaveBeenCalled();
  });
});

describe("MainPage — content view wiring", () => {
  let container: HTMLDivElement;
  let page: ReturnType<typeof createMainPage>;

  type OpenView = (id: "requests" | "moderation", opener: HTMLElement) => void;
  const openView = (): OpenView =>
    (mockCreateSidebarArea.mock.calls.at(-1)![0] as { onOpenView: OpenView }).onOpenView;

  useMainPageScope({
    wired: (c) => {
      container = c;
    },
    currentPage: () => page,
    arrange: () => {
      mockMountChannel.mockClear();
      mockDestroyChannel.mockClear();
      mockReturnToChannel.mockClear();
      mockRememberChannel.mockClear();
      inertModeration.signals.length = 0;
      channelsStore.setState((prev) => ({
        ...prev,
        channels: new Map([[1, textChannel(1, "general")]]),
        activeChannelId: 1,
        roles: [
          { id: 3, name: "Moderator", color: null, permissions: Permission.MODERATE_MEMBERS },
        ],
      }));
      authStore.setState((prev) => ({
        ...prev,
        user: { id: 1, username: "alice", avatar: null, role: "Moderator" },
      }));
    },
    mount: (c) => mountPage(c),
    mounted: (p) => {
      page = p;
    },
  });

  it("saves the server channel for Back before Alt+ArrowDown steps into a DM", () => {
    dmStore.setState(() => ({
      channels: [oneToOneDm(60, 10, "bob")],
    }));
    const activeWhenRemembered: Array<number | null> = [];
    mockRememberChannel.mockImplementation(() =>
      activeWhenRemembered.push(channelsStore.getState().activeChannelId),
    );
    // jsdom loads no CSS, so the closed Settings panel would read as an open
    // dialog and block every global shortcut.
    (document.querySelector(".settings-panel") as HTMLElement).style.display = "none";
    const altDown = (): void => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true }),
      );
    };

    // Channels mode: a step stays among server channels; nothing to remember.
    altDown();
    expect(mockRememberChannel).not.toHaveBeenCalled();

    // "View all" opens the DM view with #general still active.
    uiStore.setState((prev) => ({ ...prev, sidebarMode: "dms" }));
    altDown();
    expect(activeWhenRemembered).toEqual([1]);
    expect(channelsStore.getState().activeChannelId).toBe(60);

    mockRememberChannel.mockReset();
    uiStore.setState((prev) => ({ ...prev, sidebarMode: "channels" }));
  });

  it("places the view column between the chat column and the DM profile slot", () => {
    const view = container.querySelector("[data-testid='feature-view']");
    const chat = capturedChatAreaRef.current!;
    // The thread panel's slot (WP 6.9c) sits right behind the chat column.
    expect(view?.previousElementSibling?.previousElementSibling).toBe(chat.chatArea);
    // The member column (3C-6b) sits between the content view and the DM panel.
    expect(view?.nextElementSibling?.id).toBe("member-column");
    expect(view?.nextElementSibling?.nextElementSibling).toBe(chat.dmProfileSlot);
  });

  it("opens in place of the chat, whose channel is torn down, and closes back", () => {
    const opener = document.createElement("button");
    container.appendChild(opener);
    openView()("moderation", opener);

    expect(mockRememberChannel).toHaveBeenCalled();
    expect(container.querySelector("[data-testid='inert-moderation']")).not.toBeNull();
    expect(capturedChatAreaRef.current!.chatArea.style.display).toBe("none");
    channelsStore.flush();
    expect(mockDestroyChannel).toHaveBeenCalled();

    container.querySelector<HTMLButtonElement>("[data-testid='feature-view-close']")!.click();
    expect(mockReturnToChannel).toHaveBeenCalledTimes(1);
    expect(inertModeration.signals[0]?.aborted).toBe(true);
    expect(capturedChatAreaRef.current!.chatArea.style.display).toBe("");
  });

  it("page teardown clears the view so the next page starts with none", () => {
    openView()("moderation", document.createElement("button"));
    expect(uiStore.getState().activeView).toBe("moderation");

    page.destroy?.();

    expect(inertModeration.signals[0]?.aborted).toBe(true);
    expect(uiStore.getState().activeView).toBeNull();
  });
});

describe("MainPage — member list placement (3C-6b)", () => {
  let container: HTMLDivElement;
  let page: ReturnType<typeof createMainPage>;

  const memberLists = (): number => document.querySelectorAll('[data-testid="member-list"]').length;
  const live = (): number => memberPanels.created - memberPanels.destroyed;
  const flip = (layout: "right" | "left"): void => savePref("memberListLayout", layout);

  useMainPageScope({
    wired: (c) => {
      container = c;
    },
    currentPage: () => page,
    arrange: () => {
      uiStore.setState((prev) => ({ ...prev, sidebarMode: "channels", activeView: null }));
      // These tests flip from the left layout; the default has been right since 3C-6c.
      localStorage.setItem("owncord:settings:memberListLayout", '"left"');
      localStorage.removeItem("owncord:settings:memberListOpen");
      memberPanels.created = 0;
      memberPanels.destroyed = 0;
      channelsStore.setState((prev) => ({
        ...prev,
        channels: new Map([[1, textChannel(1, "general")]]),
        activeChannelId: 1,
      }));
    },
    mount: (c) => mountSettled(c),
    mounted: (p) => {
      page = p;
    },
    teardown: () => {
      localStorage.removeItem("owncord:settings:memberListLayout");
      localStorage.removeItem("owncord:settings:memberListOpen");
    },
  });

  it("builds an always-present, labelled, hidden member column in the app row", () => {
    const column = container.querySelector<HTMLElement>("#member-column")!;
    expect(column.tagName).toBe("ASIDE");
    expect(column.dataset["testid"]).toBe("member-column");
    expect(column.getAttribute("aria-label")).toBe("Member list");
    expect(column.hidden).toBe(true);
    expect(column.parentElement).toBe(container.querySelector('[data-testid="app-layout"]'));
    expect(column.querySelector(".member-column-body")).not.toBeNull();
  });

  it("each layout flip destroys the old member list before it creates the new one", () => {
    for (const layout of ["right", "left", "right", "left"] as const) {
      memberPanels.events.length = 0;
      flip(layout);
      expect(memberPanels.events).toEqual(["destroy", "create"]);
    }
  });

  it("switching layout leaves exactly one member-list in the document", () => {
    // Stored left: the sidebar's section is the only instance.
    expect(memberLists()).toBe(1);
    expect(container.querySelector("#member-column [data-testid='member-list']")).toBeNull();

    flip("right");
    expect(memberLists()).toBe(1);
    expect(container.querySelector("#member-column [data-testid='member-list']")).not.toBeNull();
    expect(live()).toBe(1);

    flip("left");
    expect(memberLists()).toBe(1);
    expect(container.querySelector("#member-column [data-testid='member-list']")).toBeNull();
    expect(live()).toBe(1);

    flip("right");
    expect(memberLists()).toBe(1);
    expect(live()).toBe(1);

    flip("left");
    expect(memberLists()).toBe(1);
    expect(live()).toBe(1);
  });

  it("a flip with a DM on screen leaves no member list in either layout", () => {
    seedChannels([dmChannel(2, "dm-with-bob")], 2);
    uiStore.setState((prev) => ({ ...prev, sidebarMode: "dms" }));
    flip("right");
    expect(container.querySelector("#member-column [data-testid='member-list']")).toBeNull();
    expect(container.querySelector<HTMLElement>("#member-column")!.hidden).toBe(true);
  });

  it("destroy before the column's chunk loads mounts nothing", async () => {
    page.destroy?.();
    container.replaceChildren();
    memberPanels.created = 0;
    memberPanels.destroyed = 0;
    localStorage.setItem("owncord:settings:memberListLayout", '"right"');

    page = mountPage(container);
    page.destroy?.();
    await vi.dynamicImportSettled();

    expect(memberPanels.created).toBe(0);
    expect(document.querySelectorAll('[data-testid="member-list"]').length).toBe(0);
  });

  it("tearing the page down destroys the column's panel", () => {
    flip("right");
    expect(live()).toBe(1);
    page.destroy?.();
    expect(live()).toBe(0);
  });
});

describe("MainPage — focus fallback skips hidden sidebar buttons", () => {
  let container: HTMLDivElement;
  let page: ReturnType<typeof createMainPage>;

  useMainPageScope({
    wired: (c) => {
      container = c;
    },
    currentPage: () => page,
    arrange: () => {
      channelsStore.setState((prev) => ({
        ...prev,
        channels: new Map([[1, textChannel(1, "general")]]),
        activeChannelId: 1,
      }));
    },
    mount: (c) => mountPage(c),
    mounted: (p) => {
      page = p;
    },
  });

  // A member without MANAGE_INVITES has the sidebar's Invite button hidden
  // (inline display:none), and it is the first button in the sidebar. The
  // channel controller's focusFallback (declining the NSFW gate) must not
  // spend its attempt on it: focusing a hidden control is a no-op and focus
  // would stay on <body>. jsdom does not compute display, so it would take
  // the hidden button's focus; the assertion reads the inline style instead.
  it("lands focus on the first visible sidebar button, not a hidden one", () => {
    const sidebar = container.querySelector<HTMLElement>(
      "[data-testid='app-layout'] > .unified-sidebar",
    )!;
    const hiddenInvite = document.createElement("button");
    hiddenInvite.style.display = "none";
    const visible = document.createElement("button");
    sidebar.append(hiddenInvite, visible);

    const { focusFallback } = mockCreateChannelController.mock.calls.at(-1)![0] as {
      focusFallback: () => void;
    };
    focusFallback();

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBeInstanceOf(HTMLButtonElement);
    expect((document.activeElement as HTMLElement).style.display).not.toBe("none");
    expect(document.activeElement).toBe(visible);
  });
});

describe("MainPage — focus fallback when the channel is declined", () => {
  let container: HTMLDivElement;
  let page: ReturnType<typeof createMainPage>;

  useMainPageScope({
    wired: (c) => {
      container = c;
    },
    currentPage: () => page,
    arrange: () => {
      mockCreateChannelController.mockClear();
      channelsStore.setState((prev) => ({
        ...prev,
        channels: new Map([[1, textChannel(1, "general")]]),
        activeChannelId: null,
      }));
    },
    mount: (c) => mountPage(c),
    mounted: (p) => {
      page = p;
    },
  });

  // Declining the age-restricted gate leaves the channel and hands focus to
  // `focusFallback`. With no composer on screen it must land on a sidebar
  // control that can actually take focus: the header's first button (Mark All
  // as Read) is hidden while nothing is unread, and focusing a hidden button is
  // a silent no-op that leaves focus on <body>.
  it("lands on a visible sidebar button, skipping a hidden first one", () => {
    const sidebar = container.querySelector("[data-testid='app-layout'] > .unified-sidebar")!;
    const hidden = document.createElement("button");
    hidden.style.display = "none";
    const shown = document.createElement("button");
    sidebar.append(hidden, shown);

    const { focusFallback } = mockCreateChannelController.mock.calls.at(-1)![0] as {
      focusFallback: () => void;
    };
    focusFallback();

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(shown);
  });
});

describe("MainPage — destroy isolates every teardown step", () => {
  /** Live subscriptions on a store: every subscribe minus its unsubscribe. */
  function trackSubscriptions(store: {
    subscribe: (...a: never[]) => () => void;
    subscribeSelector: (...a: never[]) => () => void;
  }): () => number {
    let live = 0;
    for (const method of ["subscribe", "subscribeSelector"] as const) {
      const original = store[method].bind(store) as (...a: unknown[]) => () => void;
      (store as Record<string, unknown>)[method] = (...args: unknown[]) => {
        live += 1;
        const unsub = original(...args);
        let done = false;
        return () => {
          if (!done) live -= 1;
          done = true;
          unsub();
        };
      };
    }
    return () => live;
  }

  it("a throwing early step still runs every later step and every store unsubscription", async () => {
    resetStores();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const stores = [uiStore, channelsStore, voiceStore, dmStore, membersStore, authStore];
    const originals = stores.map((s) => [s.subscribe, s.subscribeSelector] as const);
    const counts = stores.map((s) => trackSubscriptions(s as never));
    const lk = await import("@lib/voice/livekitSession");
    const page = createMainPage({ ws: fakeWs(), api: fakeApi() });
    try {
      page.mount(container);
      mockDestroyChannel.mockClear();
      const live = counts.reduce((n, c) => n + c(), 0);
      expect(live).toBeGreaterThan(0);

      // voiceCleanupAll sits early in destroy: everything after it must still run.
      vi.mocked(lk.cleanupAll).mockImplementationOnce(() => {
        throw new Error("boom");
      });
      expect(() => page.destroy?.()).not.toThrow();

      expect(counts.map((c) => c())).toEqual(counts.map(() => 0));
      expect(mockDestroyChannel).toHaveBeenCalled();
      expect(container.querySelector("[data-testid='app-layout']")).toBeNull();
    } finally {
      stores.forEach((s, i) => {
        s.subscribe = originals[i]![0];
        s.subscribeSelector = originals[i]![1];
      });
      container.remove();
    }
  });
});
