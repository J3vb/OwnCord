import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as voiceSession from "../helpers/voiceSessionMock";

vi.mock("@lib/voice/livekitSession", () =>
  voiceSession.withOverrides({
    rePinPeerIdentity: vi.fn(),
  }),
);
vi.mock("@lib/net/e2eeCrypto", () => ({
  importIdentityPublicKey: vi.fn(),
  computeKeyFingerprint: vi.fn(),
}));
vi.mock("@lib/presence/profiles", () => ({
  createProfileManager: vi.fn().mockReturnValue({
    loadProfiles: vi.fn().mockResolvedValue(undefined),
    getAll: vi.fn().mockReturnValue([]),
    store: { getState: () => ({ profiles: [], healthStatuses: new Map() }) },
  }),
  createTauriBackend: vi.fn().mockReturnValue({}),
}));
vi.mock("@components/UserBar", () => ({
  createUserBar: vi.fn().mockReturnValue({ mount: vi.fn(), destroy: vi.fn() }),
}));
vi.mock("@components/VoiceWidget", () => ({
  createVoiceWidget: vi.fn().mockReturnValue({ mount: vi.fn(), destroy: vi.fn() }),
}));
vi.mock("@components/MemberList", () => ({
  createMemberList: vi.fn().mockReturnValue({ mount: vi.fn(), destroy: vi.fn() }),
}));
vi.mock("@components/QuickSwitchOverlay", () => ({
  createQuickSwitchOverlay: vi.fn().mockReturnValue({ mount: vi.fn(), destroy: vi.fn() }),
}));
const { inviteOpen, openAdminPanel, createModal } = vi.hoisted(() => ({
  inviteOpen: vi.fn().mockResolvedValue(undefined),
  openAdminPanel: vi.fn().mockResolvedValue(undefined),
  createModal: vi.fn(),
}));
vi.mock("../../src/pages/main-page/OverlayManagers", () => ({
  createInviteManagerController: vi.fn().mockReturnValue({ open: inviteOpen, cleanup: vi.fn() }),
}));
vi.mock("@lib/adminPanel", () => ({ openAdminPanel }));
vi.mock("@components/CreateChannelModal", () => ({
  createCreateChannelModal: createModal,
}));

import { createSidebarArea, type SidebarAreaOptions } from "../../src/pages/main-page/SidebarArea";
import { channelsStore, setChannels } from "../../src/stores/channels.store";
import { dmStore } from "../../src/stores/dm.store";
import { authStore } from "../../src/stores/auth.store";
import { uiStore, closeSettings } from "../../src/stores/ui.store";
import { setMarkReadSender } from "@lib/readState";
import { isHideMutedChannels, setHideMutedChannels } from "@lib/prefs/hideMutedChannels";
import { Permission, type ReadyChannel } from "../../src/lib/types";
import { resetMembersState } from "../helpers/storeResets";

const UNREAD: ReadyChannel[] = [
  {
    id: 1,
    name: "general",
    type: "text",
    category: "Text Channels",
    position: 0,
    unread_count: 3,
    mention_count: 0,
  },
];
const READ: ReadyChannel[] = [{ ...UNREAD[0]!, unread_count: 0 }];

function opts(): SidebarAreaOptions {
  return {
    ws: { send: vi.fn(), close: vi.fn(), on: vi.fn(), off: vi.fn() } as never,
    api: { getConfig: vi.fn().mockReturnValue({ host: "example.com" }) } as never,
    limiters: {
      voice: { tryConsume: vi.fn().mockReturnValue(true) },
      voiceVideo: { tryConsume: vi.fn().mockReturnValue(true) },
    } as never,
    presenceSender: { send: vi.fn(), rollbackRefused: vi.fn(), destroy: vi.fn() },
    getRoot: vi.fn().mockReturnValue(document.createElement("div")),
    getToast: vi.fn().mockReturnValue({ show: vi.fn() }),
  };
}

/** The signed-in user's role holds exactly `perms`. */
function grant(perms: number): void {
  channelsStore.setState((prev) => ({
    ...prev,
    roles: [{ id: 5, name: "member", color: null, permissions: perms }],
  }));
}

describe("SidebarArea - server name menu", () => {
  let container: HTMLDivElement;
  let area: ReturnType<typeof createSidebarArea>;
  let sent: number[];

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sent = [];
    setMarkReadSender((id) => sent.push(id));
    channelsStore.setState(() => ({
      channels: new Map(),
      activeChannelId: null,
      roles: [],
      categories: [],
    }));
    dmStore.setState(() => ({ channels: [] }));
    resetMembersState();
    uiStore.setState((prev) => ({
      ...prev,
      collapsedCategories: new Set(),
      sidebarMode: "channels" as const,
    }));
    authStore.setState(() => ({
      token: "tok",
      user: { id: 2, username: "Member", avatar: null, role: "member" },
      serverName: "Test Server",
      motd: null,
      isAuthenticated: true,
    }));
    grant(Permission.SEND_MESSAGES);
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    for (const unsub of area.unsubscribers) unsub();
    document.querySelectorAll(".server-menu").forEach((el) => el.remove());
    container.remove();
    setMarkReadSender(null);
    closeSettings();
    localStorage.clear();
  });

  function mount(channels: ReadyChannel[] = READ): void {
    setChannels(channels);
    area = createSidebarArea(opts());
    container.appendChild(area.sidebarWrapper);
  }
  const nameBtn = (): HTMLButtonElement =>
    area.sidebarWrapper.querySelector<HTMLButtonElement>('button[data-testid="server-name"]')!;
  const menu = (): HTMLElement | null => document.querySelector<HTMLElement>(".server-menu");
  const labels = (): string[] =>
    Array.from(
      document.querySelectorAll(
        ".server-menu [role='menuitem'], .server-menu [role='menuitemcheckbox']",
      ),
    ).map((el) => el.textContent ?? "");
  const pressEscape = (): void => {
    menu()!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  };
  const open = (): void => {
    nameBtn().click();
  };
  const item = (testId: string): HTMLElement =>
    document.querySelector<HTMLElement>(`.server-menu [data-testid="${testId}"]`)!;

  it("renders the server name as a menu button with a chevron", () => {
    mount();

    expect(nameBtn().tagName).toBe("BUTTON");
    expect(nameBtn().classList.contains("server-name")).toBe(true);
    expect(nameBtn().getAttribute("type")).toBe("button");
    expect(nameBtn().getAttribute("aria-haspopup")).toBe("menu");
    expect(nameBtn().getAttribute("aria-expanded")).toBe("false");
    expect(nameBtn().textContent).toBe("Test Server");
    expect(nameBtn().querySelector("svg.server-name-chevron")).not.toBeNull();
  });

  it("keeps the chevron when the name changes", () => {
    mount();

    authStore.setState((prev) => ({ ...prev, serverName: "Renamed" }));
    authStore.flush();

    expect(nameBtn().textContent).toBe("Renamed");
    expect(nameBtn().querySelector("svg.server-name-chevron")).not.toBeNull();
  });

  it("opens below the button, sets aria-expanded and focuses the first item", async () => {
    mount();

    open();

    expect(menu()).not.toBeNull();
    expect(menu()!.getAttribute("role")).toBe("menu");
    expect(nameBtn().getAttribute("aria-expanded")).toBe("true");
    await Promise.resolve();
    expect(document.activeElement).toBe(item("server-menu-notifications"));
  });

  it("Escape closes it and returns focus to the button", async () => {
    mount();
    open();
    await Promise.resolve();

    pressEscape();

    expect(menu()).toBeNull();
    expect(nameBtn().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(nameBtn());
  });

  it("a second press on the button closes it instead of reopening", async () => {
    mount();
    open();
    await new Promise((r) => setTimeout(r, 5));

    nameBtn().dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    nameBtn().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));

    expect(menu()).toBeNull();
    expect(nameBtn().getAttribute("aria-expanded")).toBe("false");
  });

  it("a keyboard click after a press dragged off the button still opens it", async () => {
    mount();
    open();
    await new Promise((r) => setTimeout(r, 5));

    // The press closes the menu; the pointer leaves, so no click follows.
    nameBtn().dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(menu()).toBeNull();

    nameBtn().click();

    expect(menu()).not.toBeNull();
    expect(nameBtn().getAttribute("aria-expanded")).toBe("true");
  });

  it("reopening from the keyboard while open leaves the button expanded", async () => {
    mount();
    open();
    await new Promise((r) => setTimeout(r, 5));

    nameBtn().click();

    expect(document.querySelectorAll(".server-menu")).toHaveLength(1);
    expect(nameBtn().getAttribute("aria-expanded")).toBe("true");
  });

  it("an outside press closes it", async () => {
    mount();
    open();
    await new Promise((r) => setTimeout(r, 5));

    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    expect(menu()).toBeNull();
    expect(nameBtn().getAttribute("aria-expanded")).toBe("false");
  });

  it("offers only Notification Settings to a plain member with nothing unread", () => {
    mount(READ);

    open();

    expect(labels()).toEqual(["Notification Settings", "Hide Muted Channels"]);
    expect(document.querySelector(".server-menu [role='separator']")).toBeNull();
  });

  it("offers every row, in order with the separator, to an administrator", () => {
    grant(Permission.ADMINISTRATOR);
    mount(UNREAD);

    open();

    expect(labels()).toEqual([
      "Invite People",
      "Mark as Read",
      "Notification Settings",
      "Hide Muted Channels",
      "Create Channel",
      "Create Category",
      "Server Settings",
    ]);
    const sep = document.querySelector(".server-menu [role='separator']")!;
    expect(sep.previousElementSibling).toBe(item("server-menu-hide-muted"));
    expect(sep.nextElementSibling).toBe(item("server-menu-create-channel"));
  });

  it("gates each row on the same bit as the header control", () => {
    mount(READ);
    const cases: Array<[number, string[]]> = [
      [
        Permission.MANAGE_INVITES,
        ["Invite People", "Notification Settings", "Hide Muted Channels"],
      ],
      [
        Permission.MANAGE_CHANNELS,
        ["Notification Settings", "Hide Muted Channels", "Create Channel", "Create Category"],
      ],
      [
        Permission.VIEW_AUDIT_LOG,
        ["Notification Settings", "Hide Muted Channels", "Server Settings"],
      ],
    ];
    for (const [perm, expected] of cases) {
      grant(perm);
      open();
      expect(labels()).toEqual(expected);
      pressEscape();
      expect(menu()).toBeNull();
    }
  });

  it("re-reads permissions each time it opens (a role change between two opens)", async () => {
    mount(READ);
    open();
    expect(labels()).toEqual(["Notification Settings", "Hide Muted Channels"]);
    pressEscape();

    // A reconnect's `ready` delivers new role bits while the sidebar stays mounted.
    grant(Permission.MANAGE_INVITES | Permission.MANAGE_CHANNELS);
    open();
    expect(labels()).toEqual([
      "Invite People",
      "Notification Settings",
      "Hide Muted Channels",
      "Create Channel",
      "Create Category",
    ]);
    pressEscape();

    grant(Permission.SEND_MESSAGES);
    open();
    expect(labels()).toEqual(["Notification Settings", "Hide Muted Channels"]);
  });

  it("re-reads the unread state each time it opens", () => {
    mount(READ);
    open();
    expect(labels()).not.toContain("Mark as Read");
    document.querySelectorAll(".server-menu").forEach((el) => el.remove());
    nameBtn().setAttribute("aria-expanded", "false");

    setChannels(UNREAD);
    open();

    expect(labels()).toContain("Mark as Read");
  });

  it("Invite People opens the invite manager", () => {
    grant(Permission.MANAGE_INVITES);
    mount();
    open();

    item("server-menu-invite").click();

    expect(inviteOpen).toHaveBeenCalledOnce();
    expect(menu()).toBeNull();
  });

  it("Mark as Read marks the server's unread channels, not DMs", () => {
    mount(UNREAD);
    open();

    item("server-menu-mark-read").click();

    expect(sent).toEqual([1]);
  });

  it("Notification Settings opens Settings on the Notifications tab", () => {
    mount();
    open();

    item("server-menu-notifications").click();

    expect(uiStore.getState().settingsOpen).toBe(true);
    expect(uiStore.getState().settingsTab).toBe("Notifications");
  });

  it("Create Channel opens the create modal for no category", async () => {
    grant(Permission.MANAGE_CHANNELS);
    createModal.mockReturnValue({ mount: vi.fn(), destroy: vi.fn() });
    mount();
    open();

    item("server-menu-create-channel").click();
    await vi.dynamicImportSettled();

    expect(createModal).toHaveBeenCalledOnce();
    expect(createModal.mock.calls[0]![0]).toMatchObject({ category: { id: 0, name: "" } });
    expect(createModal.mock.results[0]!.value.mount).toHaveBeenCalledWith(document.body);
  });

  it("Create Category opens the category name dialog", async () => {
    grant(Permission.MANAGE_CHANNELS);
    mount();
    open();

    item("server-menu-create-category").click();
    await vi.dynamicImportSettled();

    expect(document.querySelector("[data-testid='create-category-modal']")).not.toBeNull();
    expect(document.querySelector("[data-testid='category-name-input']")).not.toBeNull();
    document.querySelectorAll("[data-testid='create-category-modal']").forEach((el) => el.remove());
  });

  it("Server Settings opens the admin panel with no section", () => {
    grant(Permission.VIEW_AUDIT_LOG);
    mount();
    open();

    item("server-menu-server-settings").click();

    expect(openAdminPanel).toHaveBeenCalledWith("example.com", undefined);
  });

  it("Hide Muted Channels is a checkbox row, unchecked until the preference is on", () => {
    mount();
    open();

    const row = item("server-menu-hide-muted");
    expect(row.getAttribute("role")).toBe("menuitemcheckbox");
    expect(row.getAttribute("aria-checked")).toBe("false");
  });

  it("Hide Muted Channels shows checked when the preference is already on", () => {
    setHideMutedChannels(true);
    mount();
    open();

    expect(item("server-menu-hide-muted").getAttribute("aria-checked")).toBe("true");
  });

  it("clicking Hide Muted Channels toggles the preference and closes the menu", () => {
    mount();
    open();

    item("server-menu-hide-muted").click();

    expect(isHideMutedChannels()).toBe(true);
    expect(menu()).toBeNull();

    // Reopened, it reads the saved value; a second click turns it back off.
    open();
    expect(item("server-menu-hide-muted").getAttribute("aria-checked")).toBe("true");
    item("server-menu-hide-muted").click();
    expect(isHideMutedChannels()).toBe(false);
  });

  it("leaves the existing header buttons in place", () => {
    grant(Permission.ADMINISTRATOR);
    mount(UNREAD);

    for (const id of ["mark-all-read", "invite-btn", "audit-log-btn"]) {
      expect(
        area.sidebarWrapper.querySelector(`.sidebar-header-actions [data-testid="${id}"]`),
      ).not.toBeNull();
    }
  });
});
