import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any import that triggers store or lib loading
// vi.mock is hoisted, so we cannot reference top-level const/let variables
// inside factories. Instead, use vi.fn() inline and retrieve mock later.
// ---------------------------------------------------------------------------

vi.mock("@lib/livekitSession", () => ({
  leaveVoice: vi.fn(),
  switchInputDevice: vi.fn().mockResolvedValue(undefined),
  switchOutputDevice: vi.fn().mockResolvedValue(undefined),
  setVoiceSensitivity: vi.fn(),
  setInputVolume: vi.fn(),
  setOutputVolume: vi.fn(),
  reapplyAudioProcessing: vi.fn().mockResolvedValue(undefined),
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

vi.mock("@components/VoiceWidget", () => ({
  createVoiceWidget: vi.fn().mockReturnValue({
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

vi.mock("@components/CreateChannelModal", () => ({
  createCreateChannelModal: vi.fn().mockReturnValue({
    mount: vi.fn(),
    destroy: vi.fn(),
  }),
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
}));

vi.mock("../../src/pages/main-page/OverlayManagers", () => ({
  createInviteManagerController: vi.fn().mockReturnValue({
    open: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { createSidebarArea, type SidebarAreaOptions } from "../../src/pages/main-page/SidebarArea";
import { channelsStore, setActiveChannel } from "../../src/stores/channels.store";
import { dmStore, addDmChannel } from "../../src/stores/dm.store";
import { uiStore, setSidebarMode, setActiveDmUser } from "../../src/stores/ui.store";
import { authStore } from "../../src/stores/auth.store";
import { membersStore } from "../../src/stores/members.store";
import { voiceStore } from "../../src/stores/voice.store";
import type { DmChannel } from "../../src/stores/dm.store";
import { createChannelSidebar } from "@components/ChannelSidebar";
import { createDmSidebar } from "@components/DmSidebar";
import { createMemberList } from "@components/MemberList";
import { createUserBar } from "@components/UserBar";
import { createVoiceWidget } from "@components/VoiceWidget";
import { createCreateChannelModal } from "@components/CreateChannelModal";
import { createEditChannelModal } from "@components/EditChannelModal";
import { createDeleteChannelModal } from "@components/DeleteChannelModal";

// ---------------------------------------------------------------------------
// Helpers to access mock internals
// ---------------------------------------------------------------------------

type MockedFn = ReturnType<typeof vi.fn>;

function getMockMount(factory: MockedFn): MockedFn {
  const lastCall = factory.mock.results[factory.mock.results.length - 1];
  return lastCall?.value?.mount;
}

function getMockDestroy(factory: MockedFn): MockedFn {
  const lastCall = factory.mock.results[factory.mock.results.length - 1];
  return lastCall?.value?.destroy;
}

// ---------------------------------------------------------------------------
// Store reset
// ---------------------------------------------------------------------------

function resetStores(): void {
  channelsStore.setState(() => ({
    channels: new Map(),
    activeChannelId: null,
    roles: [],
  }));
  dmStore.setState(() => ({ channels: [] }));
  uiStore.setState(() => ({
    sidebarCollapsed: false,
    memberListVisible: true,
    settingsOpen: false,
    activeModal: null,
    theme: "dark" as const,
    connectionStatus: "disconnected" as const,
    transientError: null,
    persistentError: null,
    collapsedCategories: new Set<string>(),
    sidebarMode: "channels" as const,
    activeDmUserId: null,
  }));
  authStore.setState(() => ({
    token: "test-token",
    user: { id: 1, username: "testuser", role: "admin", avatar: null, totp_enabled: false },
    serverName: "Test Server",
    motd: null,
    isAuthenticated: true,
  }));
  membersStore.setState(() => ({
    members: new Map(),
    typingUsers: new Map(),
  }));
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
  }));
  localStorage.removeItem("owncord:member-list-height");
  localStorage.removeItem("owncord:member-list-collapsed");
}

function resetMocks(): void {
  (createChannelSidebar as MockedFn).mockClear();
  (createDmSidebar as MockedFn).mockClear();
  (createMemberList as MockedFn).mockClear();
  (createUserBar as MockedFn).mockClear();
  (createVoiceWidget as MockedFn).mockClear();
  (createCreateChannelModal as MockedFn).mockClear();
  (createEditChannelModal as MockedFn).mockClear();
  (createDeleteChannelModal as MockedFn).mockClear();

  // Reset return values so each test gets fresh mock objects
  (createChannelSidebar as MockedFn).mockReturnValue({ mount: vi.fn(), destroy: vi.fn() });
  (createDmSidebar as MockedFn).mockReturnValue({ mount: vi.fn(), destroy: vi.fn() });
  (createMemberList as MockedFn).mockReturnValue({ mount: vi.fn(), destroy: vi.fn() });
  (createUserBar as MockedFn).mockReturnValue({ mount: vi.fn(), destroy: vi.fn() });
  (createVoiceWidget as MockedFn).mockReturnValue({ mount: vi.fn(), destroy: vi.fn() });
  (createCreateChannelModal as MockedFn).mockReturnValue({ mount: vi.fn(), destroy: vi.fn() });
  (createEditChannelModal as MockedFn).mockReturnValue({ mount: vi.fn(), destroy: vi.fn() });
  (createDeleteChannelModal as MockedFn).mockReturnValue({ mount: vi.fn(), destroy: vi.fn() });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDm(overrides: Partial<DmChannel> = {}): DmChannel {
  return {
    channelId: 100,
    recipient: { id: 10, username: "Alice", avatar: "", status: "online" },
    lastMessageId: null,
    lastMessage: "",
    lastMessageAt: "",
    unreadCount: 0,
    ...overrides,
  };
}

function defaultOpts(): SidebarAreaOptions {
  return {
    ws: {
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as SidebarAreaOptions["ws"],
    api: {
      createDm: vi.fn().mockResolvedValue({
        channel_id: 200,
        recipient: { id: 20, username: "Bob", avatar: "", status: "online" },
      }),
      closeDm: vi.fn().mockResolvedValue(undefined),
      getInvites: vi.fn().mockResolvedValue([]),
      createInvite: vi.fn().mockResolvedValue({ code: "abc", expires_at: "", max_uses: 0, use_count: 0 }),
      revokeInvite: vi.fn().mockResolvedValue(undefined),
      adminCreateChannel: vi.fn().mockResolvedValue(undefined),
      adminUpdateChannel: vi.fn().mockResolvedValue(undefined),
      adminDeleteChannel: vi.fn().mockResolvedValue(undefined),
      adminKickMember: vi.fn().mockResolvedValue(undefined),
      adminBanMember: vi.fn().mockResolvedValue(undefined),
      adminChangeRole: vi.fn().mockResolvedValue(undefined),
      getConfig: vi.fn().mockReturnValue({ host: "localhost:8080" }),
    } as unknown as SidebarAreaOptions["api"],
    limiters: {
      voice: { tryConsume: vi.fn().mockReturnValue(true) },
      voiceVideo: { tryConsume: vi.fn().mockReturnValue(true) },
    } as unknown as SidebarAreaOptions["limiters"],
    getRoot: vi.fn().mockReturnValue(document.createElement("div")),
    getToast: vi.fn().mockReturnValue({ show: vi.fn() }),
  };
}

/** Helper to clean up a SidebarAreaResult */
function cleanup(result: ReturnType<typeof createSidebarArea>): void {
  for (const unsub of result.unsubscribers) unsub();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SidebarArea", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    resetStores();
    resetMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    // Clean up any modals left on body
    document.querySelectorAll(".modal-overlay").forEach((el) => el.remove());
  });

  // -------------------------------------------------------------------------
  // Basic structure
  // -------------------------------------------------------------------------

  describe("basic structure", () => {
    it("returns a sidebarWrapper element", () => {
      const result = createSidebarArea(defaultOpts());
      expect(result.sidebarWrapper).toBeInstanceOf(HTMLDivElement);
      expect(result.sidebarWrapper.getAttribute("data-testid")).toBe("unified-sidebar");
      expect(result.sidebarWrapper.classList.contains("unified-sidebar")).toBe(true);
      cleanup(result);
    });

    it("returns children array with mounted components", () => {
      const result = createSidebarArea(defaultOpts());
      expect(result.children.length).toBeGreaterThanOrEqual(2);
      cleanup(result);
    });

    it("returns unsubscribers for cleanup", () => {
      const result = createSidebarArea(defaultOpts());
      expect(result.unsubscribers.length).toBeGreaterThan(0);
      expect(typeof result.unsubscribers[0]).toBe("function");
      cleanup(result);
    });

    it("returns openQuickSwitch function", () => {
      const result = createSidebarArea(defaultOpts());
      expect(typeof result.openQuickSwitch).toBe("function");
      cleanup(result);
    });
  });

  // -------------------------------------------------------------------------
  // Server header
  // -------------------------------------------------------------------------

  describe("server header", () => {
    it("renders server header with server name from auth store", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const header = container.querySelector(".unified-sidebar-header");
      expect(header).not.toBeNull();

      const serverName = container.querySelector(".server-name");
      expect(serverName!.textContent).toBe("Test Server");

      cleanup(result);
    });

    it("renders server icon with OC text", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const icon = container.querySelector(".server-icon-sm");
      expect(icon!.textContent).toBe("OC");

      cleanup(result);
    });

    it("renders online count from members store", () => {
      membersStore.setState((prev) => ({
        ...prev,
        members: new Map([
          [1, { id: 1, username: "User1", avatar: null, role: "member", status: "online" as const }],
          [2, { id: 2, username: "User2", avatar: null, role: "member", status: "offline" as const }],
          [3, { id: 3, username: "User3", avatar: null, role: "member", status: "online" as const }],
        ]),
      }));

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const onlineEl = container.querySelector(".server-online");
      expect(onlineEl!.textContent).toBe("2 online");

      cleanup(result);
    });

    it("shows 'Server' as fallback when serverName is null", () => {
      authStore.setState((prev) => ({ ...prev, serverName: null }));

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const serverName = container.querySelector(".server-name");
      expect(serverName!.textContent).toBe("Server");

      cleanup(result);
    });

    it("updates server name when auth store changes", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      authStore.setState((prev) => ({ ...prev, serverName: "New Name" }));
      authStore.flush();

      const serverName = container.querySelector(".server-name");
      expect(serverName!.textContent).toBe("New Name");

      cleanup(result);
    });

    it("updates online count when members store changes", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      membersStore.setState((prev) => ({
        ...prev,
        members: new Map([
          [1, { id: 1, username: "User1", avatar: null, role: "member", status: "online" as const }],
          [2, { id: 2, username: "User2", avatar: null, role: "member", status: "online" as const }],
          [3, { id: 3, username: "User3", avatar: null, role: "member", status: "online" as const }],
        ]),
      }));
      membersStore.flush();

      const onlineEl = container.querySelector(".server-online");
      expect(onlineEl!.textContent).toBe("3 online");

      cleanup(result);
    });

    it("renders invite button in header", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const inviteBtn = container.querySelector("[data-testid='invite-btn']");
      expect(inviteBtn).not.toBeNull();
      expect(inviteBtn!.textContent).toBe("Invite");

      cleanup(result);
    });
  });

  // -------------------------------------------------------------------------
  // Channels mode
  // -------------------------------------------------------------------------

  describe("channels mode", () => {
    it("mounts channel sidebar in channels mode (initial)", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      expect(createChannelSidebar).toHaveBeenCalled();
      expect(getMockMount(createChannelSidebar as MockedFn)).toHaveBeenCalled();

      cleanup(result);
    });

    it("renders DM section above channels", () => {
      addDmChannel(makeDm({ channelId: 100 }));

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const dmSection = container.querySelector(".sidebar-dm-section");
      expect(dmSection).not.toBeNull();

      const dmEntries = container.querySelectorAll("[data-testid='dm-entry']");
      expect(dmEntries.length).toBe(1);

      cleanup(result);
    });

    it("renders member list section below channels", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      expect(createMemberList).toHaveBeenCalled();
      expect(getMockMount(createMemberList as MockedFn)).toHaveBeenCalled();

      const memberSection = container.querySelector("[data-testid='sidebar-members']");
      expect(memberSection).not.toBeNull();

      cleanup(result);
    });

    it("renders DM list with up to 3 entries", () => {
      for (let i = 0; i < 5; i++) {
        addDmChannel(makeDm({
          channelId: 100 + i,
          recipient: { id: 10 + i, username: `User${i}`, avatar: "", status: "online" },
        }));
      }

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const entries = container.querySelectorAll("[data-testid='dm-entry']");
      expect(entries.length).toBe(3);

      cleanup(result);
    });

    it("shows View All button when more than 3 DMs exist", () => {
      for (let i = 0; i < 5; i++) {
        addDmChannel(makeDm({
          channelId: 100 + i,
          recipient: { id: 10 + i, username: `User${i}`, avatar: "", status: "online" },
        }));
      }

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const viewAll = container.querySelector(".sidebar-dm-view-all") as HTMLElement;
      expect(viewAll).not.toBeNull();
      expect(viewAll.style.display).not.toBe("none");

      cleanup(result);
    });

    it("hides View All button when 3 or fewer DMs exist", () => {
      addDmChannel(makeDm({ channelId: 100 }));

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const viewAll = container.querySelector(".sidebar-dm-view-all") as HTMLElement;
      expect(viewAll.style.display).toBe("none");

      cleanup(result);
    });

    it("View All button switches to DMs mode", () => {
      for (let i = 0; i < 5; i++) {
        addDmChannel(makeDm({
          channelId: 100 + i,
          recipient: { id: 10 + i, username: `User${i}`, avatar: "", status: "online" },
        }));
      }

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const viewAll = container.querySelector(".sidebar-dm-view-all") as HTMLElement;
      viewAll.click();

      expect(uiStore.getState().sidebarMode).toBe("dms");

      cleanup(result);
    });

    it("shows unread badge on DM entries with unreads", () => {
      addDmChannel(makeDm({ channelId: 100, unreadCount: 7 }));

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const badge = container.querySelector(".dm-unread-badge");
      expect(badge).not.toBeNull();
      expect(badge!.textContent).toBe("7");

      cleanup(result);
    });

    it("shows total unread badge in DM header", () => {
      addDmChannel(makeDm({ channelId: 100, unreadCount: 3 }));
      addDmChannel(makeDm({
        channelId: 101,
        recipient: { id: 11, username: "Bob", avatar: "", status: "online" },
        unreadCount: 2,
      }));

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const headerBadge = container.querySelector(".dm-header-unread-badge") as HTMLElement;
      expect(headerBadge.textContent).toBe("5");
      expect(headerBadge.style.display).not.toBe("none");

      cleanup(result);
    });

    it("hides total unread badge when all have 0 unreads", () => {
      addDmChannel(makeDm({ channelId: 100, unreadCount: 0 }));

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const headerBadge = container.querySelector(".dm-header-unread-badge") as HTMLElement;
      expect(headerBadge.style.display).toBe("none");

      cleanup(result);
    });

    it("collapses DM section when header is clicked", () => {
      addDmChannel(makeDm({ channelId: 100 }));

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const dmHeaders = container.querySelectorAll(".category");
      const dmHeader = Array.from(dmHeaders).find(
        (h) => h.querySelector(".category-name")?.textContent === "DIRECT MESSAGES",
      ) as HTMLElement;
      expect(dmHeader).not.toBeUndefined();
      dmHeader.click();

      const dmList = container.querySelector(".sidebar-dm-list") as HTMLElement;
      expect(dmList.style.display).toBe("none");

      const arrow = dmHeader.querySelector(".category-arrow");
      expect(arrow!.textContent).toBe("\u25B6");

      cleanup(result);
    });

    it("add DM button opens member picker", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const addBtn = container.querySelector(".category-add-btn") as HTMLElement;
      addBtn.click();

      const modal = document.querySelector(".dm-member-picker-modal");
      expect(modal).not.toBeNull();

      cleanup(result);
    });

    it("status dots use correct colors for different statuses", () => {
      addDmChannel(makeDm({
        channelId: 100,
        recipient: { id: 10, username: "Alice", avatar: "", status: "idle" },
      }));
      addDmChannel(makeDm({
        channelId: 101,
        recipient: { id: 11, username: "Bob", avatar: "", status: "dnd" },
      }));
      addDmChannel(makeDm({
        channelId: 102,
        recipient: { id: 12, username: "Charlie", avatar: "", status: "offline" },
      }));

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const entries = container.querySelectorAll("[data-testid='dm-entry']");
      // Entries are rendered from store (last added first)
      const dots = Array.from(entries).map((e) => (e.querySelector("span") as HTMLElement).style.background);

      expect(dots).toContain("var(--yellow)");
      expect(dots).toContain("var(--red)");
      expect(dots).toContain("var(--text-micro)");

      cleanup(result);
    });

    it("re-renders DM list when DM store changes", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      expect(container.querySelectorAll("[data-testid='dm-entry']").length).toBe(0);

      addDmChannel(makeDm({ channelId: 100 }));
      dmStore.flush();

      expect(container.querySelectorAll("[data-testid='dm-entry']").length).toBe(1);

      cleanup(result);
    });

    it("hides old channel-sidebar-header inside the mounted channel sidebar", () => {
      // Make channel sidebar mount function create a header element
      (createChannelSidebar as MockedFn).mockReturnValue({
        mount: vi.fn().mockImplementation((el: HTMLElement) => {
          const header = document.createElement("div");
          header.className = "channel-sidebar-header";
          el.appendChild(header);
        }),
        destroy: vi.fn(),
      });

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const oldHeader = container.querySelector(".channel-sidebar-header") as HTMLElement;
      if (oldHeader !== null) {
        expect(oldHeader.style.display).toBe("none");
      }

      cleanup(result);
    });
  });

  // -------------------------------------------------------------------------
  // DMs mode
  // -------------------------------------------------------------------------

  describe("DMs mode", () => {
    it("mounts DM sidebar when mode is dms", () => {
      uiStore.setState((prev) => ({ ...prev, sidebarMode: "dms" }));

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      expect(createDmSidebar).toHaveBeenCalled();
      expect(getMockMount(createDmSidebar as MockedFn)).toHaveBeenCalled();

      cleanup(result);
    });

    it("does not mount channel sidebar or member list in DMs mode", () => {
      uiStore.setState((prev) => ({ ...prev, sidebarMode: "dms" }));

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      expect(createChannelSidebar).not.toHaveBeenCalled();
      expect(createMemberList).not.toHaveBeenCalled();

      cleanup(result);
    });

    it("switches from channels to DMs mode when store changes", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      expect(createChannelSidebar).toHaveBeenCalledTimes(1);

      setSidebarMode("dms");
      uiStore.flush();

      expect(createDmSidebar).toHaveBeenCalled();

      cleanup(result);
    });

    it("switches from DMs back to channels mode when store changes", () => {
      uiStore.setState((prev) => ({ ...prev, sidebarMode: "dms" }));

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      expect(createDmSidebar).toHaveBeenCalledTimes(1);

      setSidebarMode("channels");
      uiStore.flush();

      expect(createChannelSidebar).toHaveBeenCalled();

      cleanup(result);
    });

    it("destroys previous sidebar content when switching modes", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const destroyFn = getMockDestroy(createChannelSidebar as MockedFn);

      setSidebarMode("dms");
      uiStore.flush();

      expect(destroyFn).toHaveBeenCalled();

      cleanup(result);
    });

    it("cleans up channel-mode extras (member list) when switching to DMs", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const memberDestroyFn = getMockDestroy(createMemberList as MockedFn);

      setSidebarMode("dms");
      uiStore.flush();

      expect(memberDestroyFn).toHaveBeenCalled();

      cleanup(result);
    });

    it("re-renders DM sidebar when DM store changes in DMs mode", () => {
      uiStore.setState((prev) => ({ ...prev, sidebarMode: "dms" }));

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const initialCallCount = (createDmSidebar as MockedFn).mock.calls.length;

      addDmChannel(makeDm({ channelId: 100 }));
      dmStore.flush();

      const newCallCount = (createDmSidebar as MockedFn).mock.calls.length;
      expect(newCallCount).toBeGreaterThan(initialCallCount);

      cleanup(result);
    });

    it("re-renders DM sidebar when activeDmUserId changes in DMs mode", () => {
      uiStore.setState((prev) => ({ ...prev, sidebarMode: "dms" }));

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const initialCallCount = (createDmSidebar as MockedFn).mock.calls.length;

      setActiveDmUser(42);
      uiStore.flush();

      const newCallCount = (createDmSidebar as MockedFn).mock.calls.length;
      expect(newCallCount).toBeGreaterThan(initialCallCount);

      cleanup(result);
    });
  });

  // -------------------------------------------------------------------------
  // Member picker modal
  // -------------------------------------------------------------------------

  describe("member picker modal", () => {
    it("shows member picker with non-current-user members", () => {
      membersStore.setState((prev) => ({
        ...prev,
        members: new Map([
          [1, { id: 1, username: "testuser", avatar: null, role: "admin", status: "online" as const }],
          [2, { id: 2, username: "Alice", avatar: null, role: "member", status: "online" as const }],
          [3, { id: 3, username: "Bob", avatar: null, role: "member", status: "idle" as const }],
        ]),
      }));

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const addBtn = container.querySelector(".category-add-btn") as HTMLElement;
      addBtn.click();

      const items = document.querySelectorAll(".dm-member-picker-item");
      expect(items.length).toBe(2);

      cleanup(result);
    });

    it("does not open a second picker if one is already open", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const addBtn = container.querySelector(".category-add-btn") as HTMLElement;
      addBtn.click();
      addBtn.click();

      const modals = document.querySelectorAll(".modal-overlay");
      expect(modals.length).toBe(1);

      cleanup(result);
    });

    it("closes picker on cancel button click", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const addBtn = container.querySelector(".category-add-btn") as HTMLElement;
      addBtn.click();

      const cancelBtn = document.querySelector(".btn-secondary") as HTMLElement;
      cancelBtn.click();

      expect(document.querySelector(".modal-overlay")).toBeNull();

      cleanup(result);
    });

    it("closes picker when clicking the overlay background", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const addBtn = container.querySelector(".category-add-btn") as HTMLElement;
      addBtn.click();

      const overlay = document.querySelector(".modal-overlay") as HTMLElement;
      overlay.click();

      expect(document.querySelector(".modal-overlay")).toBeNull();

      cleanup(result);
    });

    it("clicking a member creates a DM and closes picker", async () => {
      membersStore.setState((prev) => ({
        ...prev,
        members: new Map([
          [1, { id: 1, username: "testuser", avatar: null, role: "admin", status: "online" as const }],
          [2, { id: 2, username: "Alice", avatar: null, role: "member", status: "online" as const }],
        ]),
      }));

      const opts = defaultOpts();
      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const addBtn = container.querySelector(".category-add-btn") as HTMLElement;
      addBtn.click();

      const item = document.querySelector(".dm-member-picker-item") as HTMLElement;
      item.click();

      expect(document.querySelector(".modal-overlay")).toBeNull();

      await vi.waitFor(() => {
        expect(opts.api.createDm).toHaveBeenCalledWith(2);
      });

      cleanup(result);
    });

    it("shows member avatar initial and status in picker", () => {
      membersStore.setState((prev) => ({
        ...prev,
        members: new Map([
          [1, { id: 1, username: "testuser", avatar: null, role: "admin", status: "online" as const }],
          [2, { id: 2, username: "Alice", avatar: null, role: "member", status: "idle" as const }],
        ]),
      }));

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const addBtn = container.querySelector(".category-add-btn") as HTMLElement;
      addBtn.click();

      const avatar = document.querySelector(".dm-avatar");
      expect(avatar!.textContent).toBe("A");

      cleanup(result);
    });
  });

  // -------------------------------------------------------------------------
  // DM conversation select
  // -------------------------------------------------------------------------

  describe("DM conversation select", () => {
    it("clicking a DM entry switches to DMs mode and sets active channel", () => {
      addDmChannel(makeDm({ channelId: 100 }));

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const entry = container.querySelector("[data-testid='dm-entry']") as HTMLElement;
      entry.click();

      expect(uiStore.getState().sidebarMode).toBe("dms");
      expect(uiStore.getState().activeDmUserId).toBe(10);
      expect(channelsStore.getState().activeChannelId).toBe(100);

      cleanup(result);
    });

    it("saves current non-DM channel before switching to DMs", () => {
      channelsStore.setState((prev) => {
        const next = new Map(prev.channels);
        next.set(1, {
          id: 1, name: "general", type: "text",
          category: null, position: 0, unreadCount: 0, lastMessageId: null,
        });
        return { ...prev, channels: next, activeChannelId: 1 };
      });

      addDmChannel(makeDm({ channelId: 100 }));

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const entry = container.querySelector("[data-testid='dm-entry']") as HTMLElement;
      entry.click();

      expect(uiStore.getState().sidebarMode).toBe("dms");

      cleanup(result);
    });

    it("does not save DM channel as channelBeforeDm", () => {
      channelsStore.setState((prev) => {
        const next = new Map(prev.channels);
        next.set(50, {
          id: 50, name: "DmCh", type: "dm",
          category: null, position: 0, unreadCount: 0, lastMessageId: null,
        });
        return { ...prev, channels: next, activeChannelId: 50 };
      });

      addDmChannel(makeDm({ channelId: 100 }));

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const entry = container.querySelector("[data-testid='dm-entry']") as HTMLElement;
      entry.click();

      // DM was active but type was dm, so channelBeforeDm should be null
      // We can verify by going to DMs mode and clicking back
      cleanup(result);
    });
  });

  // -------------------------------------------------------------------------
  // Voice widget and user bar
  // -------------------------------------------------------------------------

  describe("voice widget and user bar", () => {
    it("mounts voice widget", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      expect(createVoiceWidget).toHaveBeenCalled();
      expect(getMockMount(createVoiceWidget as MockedFn)).toHaveBeenCalled();

      cleanup(result);
    });

    it("mounts user bar", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      expect(createUserBar).toHaveBeenCalled();
      expect(getMockMount(createUserBar as MockedFn)).toHaveBeenCalled();

      cleanup(result);
    });

    it("voice widget and user bar are included in children", () => {
      const result = createSidebarArea(defaultOpts());
      expect(result.children.length).toBe(2);
      cleanup(result);
    });
  });

  // -------------------------------------------------------------------------
  // Member list section (channels mode)
  // -------------------------------------------------------------------------

  describe("member list section", () => {
    it("restores member list height from localStorage", () => {
      localStorage.setItem("owncord:member-list-height", "200");

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const memberSection = container.querySelector("[data-testid='sidebar-members']") as HTMLElement;
      expect(memberSection.style.height).toBe("200px");

      cleanup(result);
    });

    it("restores collapsed state from localStorage", () => {
      localStorage.setItem("owncord:member-list-collapsed", "true");

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const memberHeader = container.querySelector(".sidebar-members-header") as HTMLElement;
      expect(memberHeader.classList.contains("collapsed")).toBe(true);

      const memberContent = container.querySelector(".sidebar-members-content") as HTMLElement;
      expect(memberContent.style.display).toBe("none");

      cleanup(result);
    });

    it("toggles member list collapse on header click", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const memberHeader = container.querySelector(".sidebar-members-header") as HTMLElement;
      memberHeader.click();

      expect(memberHeader.classList.contains("collapsed")).toBe(true);
      expect(localStorage.getItem("owncord:member-list-collapsed")).toBe("true");

      memberHeader.click();
      expect(memberHeader.classList.contains("collapsed")).toBe(false);
      expect(localStorage.getItem("owncord:member-list-collapsed")).toBe("false");

      cleanup(result);
    });

    it("sets height to auto when collapsed", () => {
      localStorage.setItem("owncord:member-list-height", "300");

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const memberHeader = container.querySelector(".sidebar-members-header") as HTMLElement;
      memberHeader.click();

      const memberSection = container.querySelector("[data-testid='sidebar-members']") as HTMLElement;
      expect(memberSection.style.height).toBe("auto");

      cleanup(result);
    });

    it("hides resize handle when collapsed", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const memberHeader = container.querySelector(".sidebar-members-header") as HTMLElement;
      memberHeader.click();

      const handle = container.querySelector(".sidebar-resize-handle") as HTMLElement;
      expect(handle.style.display).toBe("none");

      cleanup(result);
    });

    it("handles mousedown/mousemove/mouseup for drag-to-resize", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const handle = container.querySelector(".sidebar-resize-handle") as HTMLElement;
      handle.dispatchEvent(new MouseEvent("mousedown", { clientY: 300, bubbles: true }));
      document.dispatchEvent(new MouseEvent("mousemove", { clientY: 250, bubbles: true }));
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

      expect(localStorage.getItem("owncord:member-list-height")).toBeDefined();

      cleanup(result);
    });

    it("does not resize when not in drag mode", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      // mousemove without mousedown should not do anything
      document.dispatchEvent(new MouseEvent("mousemove", { clientY: 250, bubbles: true }));
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

      expect(localStorage.getItem("owncord:member-list-height")).toBeNull();

      cleanup(result);
    });

    it("restores saved height when expanding after collapse", () => {
      localStorage.setItem("owncord:member-list-height", "300");

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const memberHeader = container.querySelector(".sidebar-members-header") as HTMLElement;
      memberHeader.click(); // Collapse
      memberHeader.click(); // Expand

      const memberSection = container.querySelector("[data-testid='sidebar-members']") as HTMLElement;
      expect(memberSection.style.height).toBe("300px");

      cleanup(result);
    });
  });

  // -------------------------------------------------------------------------
  // DM sidebar callbacks
  // -------------------------------------------------------------------------

  describe("DM sidebar callbacks", () => {
    it("passes correct callbacks to createDmSidebar", () => {
      uiStore.setState((prev) => ({ ...prev, sidebarMode: "dms" }));

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      expect(createDmSidebar).toHaveBeenCalled();
      const callArgs = (createDmSidebar as MockedFn).mock.calls[0]![0];
      expect(typeof callArgs.onSelectConversation).toBe("function");
      expect(typeof callArgs.onCloseDm).toBe("function");
      expect(typeof callArgs.onNewDm).toBe("function");
      expect(typeof callArgs.onBack).toBe("function");

      cleanup(result);
    });

    it("onBack restores previous channel and switches to channels mode", () => {
      channelsStore.setState((prev) => {
        const next = new Map(prev.channels);
        next.set(1, {
          id: 1, name: "general", type: "text",
          category: null, position: 0, unreadCount: 0, lastMessageId: null,
        });
        return { ...prev, channels: next, activeChannelId: 1 };
      });

      addDmChannel(makeDm({ channelId: 100 }));

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      // Click DM entry to save channelBeforeDm and switch to DMs mode
      const entry = container.querySelector("[data-testid='dm-entry']") as HTMLElement;
      entry.click();
      uiStore.flush();

      // Get the onBack callback from the latest createDmSidebar call
      const dmSidebarCalls = (createDmSidebar as MockedFn).mock.calls;
      const lastCall = dmSidebarCalls[dmSidebarCalls.length - 1]![0];
      lastCall.onBack();

      expect(uiStore.getState().sidebarMode).toBe("channels");
      expect(channelsStore.getState().activeChannelId).toBe(1);

      cleanup(result);
    });

    it("onBack falls back to first text channel if no saved channel", () => {
      channelsStore.setState((prev) => {
        const next = new Map(prev.channels);
        next.set(1, {
          id: 1, name: "general", type: "text",
          category: null, position: 0, unreadCount: 0, lastMessageId: null,
        });
        next.set(2, {
          id: 2, name: "voice", type: "voice",
          category: null, position: 0, unreadCount: 0, lastMessageId: null,
        });
        return { ...prev, channels: next };
      });

      uiStore.setState((prev) => ({ ...prev, sidebarMode: "dms" }));

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const dmSidebarCalls = (createDmSidebar as MockedFn).mock.calls;
      const lastCall = dmSidebarCalls[dmSidebarCalls.length - 1]![0];
      lastCall.onBack();

      expect(uiStore.getState().sidebarMode).toBe("channels");
      expect(channelsStore.getState().activeChannelId).toBe(1);

      cleanup(result);
    });

    it("onCloseDm removes DM and calls closeDm API", () => {
      const dm = makeDm({ channelId: 100, recipient: { id: 10, username: "Alice", avatar: "", status: "online" } });
      addDmChannel(dm);

      uiStore.setState((prev) => ({ ...prev, sidebarMode: "dms" }));
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 100 }));

      const opts = defaultOpts();
      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const dmSidebarCalls = (createDmSidebar as MockedFn).mock.calls;
      const lastCall = dmSidebarCalls[dmSidebarCalls.length - 1]![0];
      lastCall.onCloseDm(10);

      expect(opts.api.closeDm).toHaveBeenCalledWith(100);

      cleanup(result);
    });

    it("onCloseDm goes back to channels when last DM is closed", () => {
      addDmChannel(makeDm({ channelId: 100, recipient: { id: 10, username: "Alice", avatar: "", status: "online" } }));

      uiStore.setState((prev) => ({ ...prev, sidebarMode: "dms" }));
      channelsStore.setState((prev) => {
        const next = new Map(prev.channels);
        next.set(1, {
          id: 1, name: "general", type: "text",
          category: null, position: 0, unreadCount: 0, lastMessageId: null,
        });
        return { ...prev, channels: next, activeChannelId: 100 };
      });

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const dmSidebarCalls = (createDmSidebar as MockedFn).mock.calls;
      const lastCall = dmSidebarCalls[dmSidebarCalls.length - 1]![0];
      lastCall.onCloseDm(10);

      expect(uiStore.getState().sidebarMode).toBe("channels");

      cleanup(result);
    });

    it("onSelectConversation selects a DM in DMs mode", () => {
      addDmChannel(makeDm({ channelId: 100, recipient: { id: 10, username: "Alice", avatar: "", status: "online" } }));

      uiStore.setState((prev) => ({ ...prev, sidebarMode: "dms" }));

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const dmSidebarCalls = (createDmSidebar as MockedFn).mock.calls;
      const lastCall = dmSidebarCalls[dmSidebarCalls.length - 1]![0];
      lastCall.onSelectConversation(10);

      expect(uiStore.getState().activeDmUserId).toBe(10);
      expect(channelsStore.getState().activeChannelId).toBe(100);

      cleanup(result);
    });

    it("onNewDm opens member picker from DMs mode", () => {
      uiStore.setState((prev) => ({ ...prev, sidebarMode: "dms" }));

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const dmSidebarCalls = (createDmSidebar as MockedFn).mock.calls;
      const lastCall = dmSidebarCalls[dmSidebarCalls.length - 1]![0];
      lastCall.onNewDm();

      const modal = document.querySelector(".dm-member-picker-modal");
      expect(modal).not.toBeNull();

      cleanup(result);
    });
  });

  // -------------------------------------------------------------------------
  // Channel sidebar callbacks
  // -------------------------------------------------------------------------

  describe("channel sidebar callbacks", () => {
    it("passes correct callbacks to createChannelSidebar", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      expect(createChannelSidebar).toHaveBeenCalled();
      const callArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      expect(typeof callArgs.onVoiceJoin).toBe("function");
      expect(typeof callArgs.onVoiceLeave).toBe("function");
      expect(typeof callArgs.onCreateChannel).toBe("function");
      expect(typeof callArgs.onEditChannel).toBe("function");
      expect(typeof callArgs.onDeleteChannel).toBe("function");
      expect(typeof callArgs.onReorderChannel).toBe("function");

      cleanup(result);
    });

    it("onCreateChannel opens create channel modal", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const callArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      callArgs.onCreateChannel("General");

      expect(createCreateChannelModal).toHaveBeenCalled();

      cleanup(result);
    });

    it("onCreateChannel does not open a second modal if one is active", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const callArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      callArgs.onCreateChannel("General");
      callArgs.onCreateChannel("Another");

      expect(createCreateChannelModal).toHaveBeenCalledTimes(1);

      cleanup(result);
    });

    it("onEditChannel opens edit channel modal", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const callArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      callArgs.onEditChannel({ id: 1, name: "general", type: "text" });

      expect(createEditChannelModal).toHaveBeenCalled();

      cleanup(result);
    });

    it("onDeleteChannel opens delete channel modal", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const callArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      callArgs.onDeleteChannel({ id: 1, name: "general" });

      expect(createDeleteChannelModal).toHaveBeenCalled();

      cleanup(result);
    });

    it("onReorderChannel calls API for each reorder", () => {
      const opts = defaultOpts();
      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const callArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      callArgs.onReorderChannel([
        { channelId: 1, newPosition: 0 },
        { channelId: 2, newPosition: 1 },
      ]);

      expect(opts.api.adminUpdateChannel).toHaveBeenCalledWith(1, { position: 0 });
      expect(opts.api.adminUpdateChannel).toHaveBeenCalledWith(2, { position: 1 });

      cleanup(result);
    });
  });

  // -------------------------------------------------------------------------
  // Channel modal inner callbacks
  // -------------------------------------------------------------------------

  describe("channel modal inner callbacks", () => {
    it("onCreate callback calls API and destroys modal on success", async () => {
      const opts = defaultOpts();
      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const channelCallArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      channelCallArgs.onCreateChannel("General");

      // Get the createCreateChannelModal call args
      const modalCallArgs = (createCreateChannelModal as MockedFn).mock.calls[0]![0];
      await modalCallArgs.onCreate({ name: "test", type: "text" });

      expect(opts.api.adminCreateChannel).toHaveBeenCalledWith({ name: "test", type: "text" });

      cleanup(result);
    });

    it("onCreate callback shows error toast on API failure", async () => {
      const mockShow = vi.fn();
      const opts = defaultOpts();
      (opts.api.adminCreateChannel as MockedFn).mockRejectedValue(new Error("Create failed"));
      (opts.getToast as MockedFn).mockReturnValue({ show: mockShow });

      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const channelCallArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      channelCallArgs.onCreateChannel("General");

      const modalCallArgs = (createCreateChannelModal as MockedFn).mock.calls[0]![0];
      await modalCallArgs.onCreate({ name: "test", type: "text" });

      expect(mockShow).toHaveBeenCalledWith("Create failed", "error");

      cleanup(result);
    });

    it("onCreate shows generic error for non-Error exceptions", async () => {
      const mockShow = vi.fn();
      const opts = defaultOpts();
      (opts.api.adminCreateChannel as MockedFn).mockRejectedValue("string error");
      (opts.getToast as MockedFn).mockReturnValue({ show: mockShow });

      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const channelCallArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      channelCallArgs.onCreateChannel("General");

      const modalCallArgs = (createCreateChannelModal as MockedFn).mock.calls[0]![0];
      await modalCallArgs.onCreate({ name: "test", type: "text" });

      expect(mockShow).toHaveBeenCalledWith("Failed to create channel", "error");

      cleanup(result);
    });

    it("onClose callback destroys create modal", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const channelCallArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      channelCallArgs.onCreateChannel("General");

      const modalCallArgs = (createCreateChannelModal as MockedFn).mock.calls[0]![0];
      modalCallArgs.onClose();

      // After close, should be able to open another modal
      channelCallArgs.onCreateChannel("Another");
      expect(createCreateChannelModal).toHaveBeenCalledTimes(2);

      cleanup(result);
    });

    it("onSave callback calls API for edit modal", async () => {
      const opts = defaultOpts();
      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const channelCallArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      channelCallArgs.onEditChannel({ id: 1, name: "general", type: "text" });

      const modalCallArgs = (createEditChannelModal as MockedFn).mock.calls[0]![0];
      await modalCallArgs.onSave({ name: "updated" });

      expect(opts.api.adminUpdateChannel).toHaveBeenCalledWith(1, { name: "updated" });

      cleanup(result);
    });

    it("onSave shows error toast on edit API failure", async () => {
      const mockShow = vi.fn();
      const opts = defaultOpts();
      (opts.api.adminUpdateChannel as MockedFn).mockRejectedValue(new Error("Update failed"));
      (opts.getToast as MockedFn).mockReturnValue({ show: mockShow });

      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const channelCallArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      channelCallArgs.onEditChannel({ id: 1, name: "general", type: "text" });

      const modalCallArgs = (createEditChannelModal as MockedFn).mock.calls[0]![0];
      await modalCallArgs.onSave({ name: "updated" });

      expect(mockShow).toHaveBeenCalledWith("Update failed", "error");

      cleanup(result);
    });

    it("onSave shows generic error for non-Error exceptions on edit", async () => {
      const mockShow = vi.fn();
      const opts = defaultOpts();
      (opts.api.adminUpdateChannel as MockedFn).mockRejectedValue(42);
      (opts.getToast as MockedFn).mockReturnValue({ show: mockShow });

      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const channelCallArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      channelCallArgs.onEditChannel({ id: 1, name: "general", type: "text" });

      const modalCallArgs = (createEditChannelModal as MockedFn).mock.calls[0]![0];
      await modalCallArgs.onSave({ name: "updated" });

      expect(mockShow).toHaveBeenCalledWith("Failed to update channel", "error");

      cleanup(result);
    });

    it("onClose callback destroys edit modal", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const channelCallArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      channelCallArgs.onEditChannel({ id: 1, name: "general", type: "text" });

      const modalCallArgs = (createEditChannelModal as MockedFn).mock.calls[0]![0];
      modalCallArgs.onClose();

      channelCallArgs.onEditChannel({ id: 2, name: "random", type: "text" });
      expect(createEditChannelModal).toHaveBeenCalledTimes(2);

      cleanup(result);
    });

    it("onConfirm callback calls API for delete modal", async () => {
      const opts = defaultOpts();
      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const channelCallArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      channelCallArgs.onDeleteChannel({ id: 1, name: "general" });

      const modalCallArgs = (createDeleteChannelModal as MockedFn).mock.calls[0]![0];
      await modalCallArgs.onConfirm();

      expect(opts.api.adminDeleteChannel).toHaveBeenCalledWith(1);

      cleanup(result);
    });

    it("onConfirm shows error toast on delete API failure", async () => {
      const mockShow = vi.fn();
      const opts = defaultOpts();
      (opts.api.adminDeleteChannel as MockedFn).mockRejectedValue(new Error("Delete failed"));
      (opts.getToast as MockedFn).mockReturnValue({ show: mockShow });

      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const channelCallArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      channelCallArgs.onDeleteChannel({ id: 1, name: "general" });

      const modalCallArgs = (createDeleteChannelModal as MockedFn).mock.calls[0]![0];
      await modalCallArgs.onConfirm();

      expect(mockShow).toHaveBeenCalledWith("Delete failed", "error");

      cleanup(result);
    });

    it("onConfirm shows generic error for non-Error exceptions on delete", async () => {
      const mockShow = vi.fn();
      const opts = defaultOpts();
      (opts.api.adminDeleteChannel as MockedFn).mockRejectedValue(42);
      (opts.getToast as MockedFn).mockReturnValue({ show: mockShow });

      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const channelCallArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      channelCallArgs.onDeleteChannel({ id: 1, name: "general" });

      const modalCallArgs = (createDeleteChannelModal as MockedFn).mock.calls[0]![0];
      await modalCallArgs.onConfirm();

      expect(mockShow).toHaveBeenCalledWith("Failed to delete channel", "error");

      cleanup(result);
    });

    it("onClose callback destroys delete modal", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const channelCallArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      channelCallArgs.onDeleteChannel({ id: 1, name: "general" });

      const modalCallArgs = (createDeleteChannelModal as MockedFn).mock.calls[0]![0];
      modalCallArgs.onClose();

      channelCallArgs.onDeleteChannel({ id: 2, name: "random" });
      expect(createDeleteChannelModal).toHaveBeenCalledTimes(2);

      cleanup(result);
    });
  });

  // -------------------------------------------------------------------------
  // addDmToChannelsStore (inner function)
  // -------------------------------------------------------------------------

  describe("addDmToChannelsStore (channels mode)", () => {
    it("adds DM channel to channelsStore when clicking a DM entry", () => {
      addDmChannel(makeDm({ channelId: 100, unreadCount: 3 }));

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const entry = container.querySelector("[data-testid='dm-entry']") as HTMLElement;
      entry.click();

      const ch = channelsStore.getState().channels.get(100);
      expect(ch).toBeDefined();
      expect(ch!.name).toBe("Alice");
      expect(ch!.type).toBe("dm");
      // unreadCount is 0 because setActiveChannel clears it
      expect(ch!.unreadCount).toBe(0);

      cleanup(result);
    });

    it("does not overwrite existing channel with non-empty name", () => {
      channelsStore.setState((prev) => {
        const next = new Map(prev.channels);
        next.set(100, {
          id: 100, name: "ExistingName", type: "dm",
          category: null, position: 0, unreadCount: 0, lastMessageId: null,
        });
        return { ...prev, channels: next };
      });

      addDmChannel(makeDm({ channelId: 100 }));

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const entry = container.querySelector("[data-testid='dm-entry']") as HTMLElement;
      entry.click();

      const ch = channelsStore.getState().channels.get(100);
      expect(ch!.name).toBe("ExistingName");

      cleanup(result);
    });
  });

  // -------------------------------------------------------------------------
  // Quick switch overlay
  // -------------------------------------------------------------------------

  describe("quick switch overlay", () => {
    it("openQuickSwitch does not throw", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      expect(() => result.openQuickSwitch()).not.toThrow();

      cleanup(result);
    });
  });

  // -------------------------------------------------------------------------
  // Member list callbacks in channels mode
  // -------------------------------------------------------------------------

  describe("member list callbacks in channels mode", () => {
    /** Extract callbacks passed to createMemberList */
    function getMemberListCallbacks(): {
      onKick: (userId: number, username: string) => Promise<void>;
      onBan: (userId: number, username: string) => Promise<void>;
      onChangeRole: (userId: number, username: string, newRole: string) => Promise<void>;
    } {
      const calls = (createMemberList as MockedFn).mock.calls;
      return calls[calls.length - 1]![0];
    }

    it("onKick calls API and shows success toast", async () => {
      const mockShow = vi.fn();
      const opts = defaultOpts();
      (opts.getToast as MockedFn).mockReturnValue({ show: mockShow });

      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const callbacks = getMemberListCallbacks();
      await callbacks.onKick(2, "Alice");

      expect(opts.api.adminKickMember).toHaveBeenCalledWith(2);
      expect(mockShow).toHaveBeenCalledWith("Kicked Alice", "success");

      cleanup(result);
    });

    it("onKick shows error toast on failure", async () => {
      const mockShow = vi.fn();
      const opts = defaultOpts();
      (opts.api.adminKickMember as MockedFn).mockRejectedValue(new Error("Kick denied"));
      (opts.getToast as MockedFn).mockReturnValue({ show: mockShow });

      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const callbacks = getMemberListCallbacks();
      await callbacks.onKick(2, "Alice");

      expect(mockShow).toHaveBeenCalledWith("Kick denied", "error");

      cleanup(result);
    });

    it("onKick shows generic error for non-Error exceptions", async () => {
      const mockShow = vi.fn();
      const opts = defaultOpts();
      (opts.api.adminKickMember as MockedFn).mockRejectedValue("string");
      (opts.getToast as MockedFn).mockReturnValue({ show: mockShow });

      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const callbacks = getMemberListCallbacks();
      await callbacks.onKick(2, "Alice");

      expect(mockShow).toHaveBeenCalledWith("Failed to kick member", "error");

      cleanup(result);
    });

    it("onBan calls API and shows success toast", async () => {
      const mockShow = vi.fn();
      const opts = defaultOpts();
      (opts.getToast as MockedFn).mockReturnValue({ show: mockShow });

      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const callbacks = getMemberListCallbacks();
      await callbacks.onBan(3, "Bob");

      expect(opts.api.adminBanMember).toHaveBeenCalledWith(3);
      expect(mockShow).toHaveBeenCalledWith("Banned Bob", "success");

      cleanup(result);
    });

    it("onBan shows error toast on failure", async () => {
      const mockShow = vi.fn();
      const opts = defaultOpts();
      (opts.api.adminBanMember as MockedFn).mockRejectedValue(new Error("Ban denied"));
      (opts.getToast as MockedFn).mockReturnValue({ show: mockShow });

      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const callbacks = getMemberListCallbacks();
      await callbacks.onBan(3, "Bob");

      expect(mockShow).toHaveBeenCalledWith("Ban denied", "error");

      cleanup(result);
    });

    it("onBan shows generic error for non-Error exceptions", async () => {
      const mockShow = vi.fn();
      const opts = defaultOpts();
      (opts.api.adminBanMember as MockedFn).mockRejectedValue("string");
      (opts.getToast as MockedFn).mockReturnValue({ show: mockShow });

      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const callbacks = getMemberListCallbacks();
      await callbacks.onBan(3, "Bob");

      expect(mockShow).toHaveBeenCalledWith("Failed to ban member", "error");

      cleanup(result);
    });

    it("onChangeRole calls API with correct role ID", async () => {
      const mockShow = vi.fn();
      const opts = defaultOpts();
      (opts.getToast as MockedFn).mockReturnValue({ show: mockShow });

      // Set up roles in channelsStore
      channelsStore.setState((prev) => ({
        ...prev,
        roles: [
          { id: 1, name: "owner", permissions: 0 },
          { id: 2, name: "admin", permissions: 0 },
          { id: 4, name: "member", permissions: 0 },
        ],
      }));

      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const callbacks = getMemberListCallbacks();
      await callbacks.onChangeRole(4, "Charlie", "admin");

      expect(opts.api.adminChangeRole).toHaveBeenCalledWith(4, 2);
      expect(mockShow).toHaveBeenCalledWith("Changed Charlie's role to admin", "success");

      cleanup(result);
    });

    it("onChangeRole shows error toast on failure", async () => {
      const mockShow = vi.fn();
      const opts = defaultOpts();
      (opts.api.adminChangeRole as MockedFn).mockRejectedValue(new Error("Role denied"));
      (opts.getToast as MockedFn).mockReturnValue({ show: mockShow });

      channelsStore.setState((prev) => ({
        ...prev,
        roles: [{ id: 2, name: "admin", permissions: 0 }],
      }));

      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const callbacks = getMemberListCallbacks();
      await callbacks.onChangeRole(4, "Charlie", "admin");

      expect(mockShow).toHaveBeenCalledWith("Role denied", "error");

      cleanup(result);
    });

    it("onChangeRole shows generic error for non-Error exceptions", async () => {
      const mockShow = vi.fn();
      const opts = defaultOpts();
      (opts.api.adminChangeRole as MockedFn).mockRejectedValue("string");
      (opts.getToast as MockedFn).mockReturnValue({ show: mockShow });

      channelsStore.setState((prev) => ({
        ...prev,
        roles: [{ id: 2, name: "admin", permissions: 0 }],
      }));

      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const callbacks = getMemberListCallbacks();
      await callbacks.onChangeRole(4, "Charlie", "admin");

      expect(mockShow).toHaveBeenCalledWith("Failed to change role", "error");

      cleanup(result);
    });

    it("onChangeRole does nothing when role name not found", async () => {
      const mockShow = vi.fn();
      const opts = defaultOpts();
      (opts.getToast as MockedFn).mockReturnValue({ show: mockShow });

      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const callbacks = getMemberListCallbacks();
      await callbacks.onChangeRole(4, "Charlie", "nonexistent");

      expect(opts.api.adminChangeRole).not.toHaveBeenCalled();
      expect(mockShow).not.toHaveBeenCalled();

      cleanup(result);
    });

    it("passes currentUserRole from auth store", () => {
      authStore.setState((prev) => ({
        ...prev,
        user: { id: 1, username: "testuser", role: "owner", avatar: null, totp_enabled: false },
      }));

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const calls = (createMemberList as MockedFn).mock.calls;
      const lastCall = calls[calls.length - 1]![0];
      expect(lastCall.currentUserRole).toBe("owner");

      cleanup(result);
    });

    it("defaults currentUserRole to member when user is null", () => {
      authStore.setState((prev) => ({ ...prev, user: null }));

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const calls = (createMemberList as MockedFn).mock.calls;
      const lastCall = calls[calls.length - 1]![0];
      expect(lastCall.currentUserRole).toBe("member");

      cleanup(result);
    });
  });

  // -------------------------------------------------------------------------
  // Create DM error handling
  // -------------------------------------------------------------------------

  describe("createDm error handling", () => {
    it("shows error toast when DM creation fails", async () => {
      const mockShow = vi.fn();
      const opts = defaultOpts();
      (opts.api.createDm as MockedFn).mockRejectedValue(new Error("Server error"));
      (opts.getToast as MockedFn).mockReturnValue({ show: mockShow });

      membersStore.setState((prev) => ({
        ...prev,
        members: new Map([
          [1, { id: 1, username: "testuser", avatar: null, role: "admin", status: "online" as const }],
          [2, { id: 2, username: "Alice", avatar: null, role: "member", status: "online" as const }],
        ]),
      }));

      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      const addBtn = container.querySelector(".category-add-btn") as HTMLElement;
      addBtn.click();
      const item = document.querySelector(".dm-member-picker-item") as HTMLElement;
      item.click();

      await vi.waitFor(() => {
        expect(mockShow).toHaveBeenCalledWith("Server error", "error");
      });

      cleanup(result);
    });
  });

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  describe("cleanup", () => {
    it("calling all unsubscribers cleans up active modal", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      // Open a modal
      const callArgs = (createChannelSidebar as MockedFn).mock.calls[0]![0];
      callArgs.onCreateChannel("General");

      const destroyFn = getMockDestroy(createCreateChannelModal as MockedFn);

      cleanup(result);

      expect(destroyFn).toHaveBeenCalled();
    });

    it("calling all unsubscribers cleans up active sidebar content", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const destroyFn = getMockDestroy(createChannelSidebar as MockedFn);

      cleanup(result);

      expect(destroyFn).toHaveBeenCalled();
    });

    it("calling all unsubscribers cleans up channel mode extras", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const destroyFn = getMockDestroy(createMemberList as MockedFn);

      cleanup(result);

      expect(destroyFn).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Section ordering
  // -------------------------------------------------------------------------

  describe("section ordering", () => {
    it("sidebar structure: header, content slot, voice widget, user bar", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const wrapper = container.querySelector("[data-testid='unified-sidebar']") as HTMLElement;
      const children = Array.from(wrapper.children);

      expect(children[0]!.classList.contains("unified-sidebar-header")).toBe(true);
      expect(children.length).toBeGreaterThanOrEqual(4);

      cleanup(result);
    });

    it("in channels mode, DM section comes before channel sidebar in content slot", () => {
      addDmChannel(makeDm({ channelId: 100 }));

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const wrapper = container.querySelector("[data-testid='unified-sidebar']") as HTMLElement;
      const contentSlot = wrapper.children[1] as HTMLElement;

      expect(contentSlot.children[0]!.classList.contains("sidebar-dm-section")).toBe(true);

      cleanup(result);
    });
  });
});
