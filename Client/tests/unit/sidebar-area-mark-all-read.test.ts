/**
 * "Mark All as Read" lives in the unified sidebar header, beside Invite.
 *
 * It used to sit in ChannelSidebar's own `.channel-sidebar-header`, which
 * app.css hides (`.sidebar-content-inner .channel-sidebar-header`) because the
 * unified header already shows the server name — so the control existed in the
 * DOM, and in jsdom (which ignores CSS), but never on screen.
 *
 * The real ChannelSidebar is mounted on purpose: the placement is a fact about
 * the composed DOM, and the CSS check below reads it from there.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cascadedDeclaration, keyword } from "../helpers/app-css";

vi.mock("@lib/livekitSession", () => ({
  rePinPeerIdentity: vi.fn(),
  leaveVoice: vi.fn(),
  getSessionDebugInfo: vi.fn().mockReturnValue({}),
}));
vi.mock("@lib/e2eeCrypto", () => ({
  importIdentityPublicKey: vi.fn(),
  computeKeyFingerprint: vi.fn(),
}));
vi.mock("@lib/profiles", () => ({
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
vi.mock("../../src/pages/main-page/OverlayManagers", () => ({
  createInviteManagerController: vi.fn().mockReturnValue({
    open: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn(),
  }),
}));

import { createSidebarArea, type SidebarAreaOptions } from "../../src/pages/main-page/SidebarArea";
import { channelsStore, setChannels } from "../../src/stores/channels.store";
import { dmStore } from "../../src/stores/dm.store";
import { authStore } from "../../src/stores/auth.store";
import { uiStore } from "../../src/stores/ui.store";
import { membersStore } from "../../src/stores/members.store";
import { setMarkReadSender } from "@lib/read-state";
import type { ReadyChannel } from "../../src/lib/types";

const CHANNELS: ReadyChannel[] = [
  {
    id: 1,
    name: "general",
    type: "text",
    category: "Text Channels",
    position: 0,
    unread_count: 3,
    mention_count: 1,
  },
  { id: 2, name: "random", type: "text", category: "Text Channels", position: 1, unread_count: 0 },
];

/** Whether the header button is displayed (SidebarArea toggles `display`, as for Audit Log). */
const shown = (el: HTMLElement): boolean => el.style.display !== "none";

function opts(): SidebarAreaOptions {
  return {
    ws: { send: vi.fn(), close: vi.fn(), on: vi.fn(), off: vi.fn() } as never,
    api: { getConfig: vi.fn().mockReturnValue({ host: "example.com" }) } as never,
    limiters: {
      voice: { tryConsume: vi.fn().mockReturnValue(true) },
      voiceVideo: { tryConsume: vi.fn().mockReturnValue(true) },
    } as never,
    presenceSender: { send: vi.fn(), rollbackTimedOut: vi.fn(), destroy: vi.fn() },
    getRoot: vi.fn().mockReturnValue(document.createElement("div")),
    getToast: vi.fn().mockReturnValue({ show: vi.fn() }),
  };
}

describe("SidebarArea — Mark All as Read", () => {
  let container: HTMLDivElement;
  let area: ReturnType<typeof createSidebarArea>;
  let sent: number[];

  beforeEach(() => {
    sent = [];
    setMarkReadSender((id) => sent.push(id));
    channelsStore.setState(() => ({ channels: new Map(), activeChannelId: null, roles: [] }));
    dmStore.setState(() => ({ channels: [] }));
    membersStore.setState(() => ({ members: new Map(), typingUsers: new Map() }));
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
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    for (const unsub of area.unsubscribers) unsub();
    container.remove();
    setMarkReadSender(null);
  });

  function mount(channels: ReadyChannel[]): void {
    setChannels(channels);
    area = createSidebarArea(opts());
    container.appendChild(area.sidebarWrapper);
  }

  function button(): HTMLElement {
    const el = area.sidebarWrapper.querySelector<HTMLElement>('[data-testid="mark-all-read"]');
    expect(el).not.toBeNull();
    return el!;
  }

  it("sits in the unified header's action row, not in the channel list's own header", () => {
    mount(CHANNELS);

    expect(
      area.sidebarWrapper.querySelector(
        '.unified-sidebar-header > .sidebar-header-actions > [data-testid="mark-all-read"]',
      ),
    ).not.toBeNull();
    expect(button().closest(".channel-sidebar")).toBeNull();
    expect(button().classList.contains("sidebar-header-action")).toBe(true);
  });

  it("is a named icon button with a tooltip and no visible text", () => {
    mount(CHANNELS);

    expect(button().tagName).toBe("BUTTON");
    expect(button().getAttribute("type")).toBe("button");
    expect(button().getAttribute("aria-label")).toBe("Mark All as Read");
    expect(button().getAttribute("title")).toBe("Mark All as Read");
    expect(button().textContent).toBe("");
    expect(button().querySelector("svg")).not.toBeNull();
  });

  it("hides the button while nothing is unread", () => {
    mount([CHANNELS[1]!]);

    expect(shown(button())).toBe(false);
  });

  it("shows the button once a channel goes unread", () => {
    mount(CHANNELS);

    expect(shown(button())).toBe(true);
  });

  it("shows the button when a channel becomes unread after mount", async () => {
    mount([CHANNELS[1]!]);
    expect(shown(button())).toBe(false);

    setChannels(CHANNELS);

    await vi.waitFor(() => {
      expect(shown(button())).toBe(true);
    });
  });

  it("shows the button for a DM-only unread, whose badge lives in dm.store", async () => {
    mount([CHANNELS[1]!]);
    expect(shown(button())).toBe(false);

    dmStore.setState(() => ({
      channels: [
        {
          channelId: 50,
          recipient: { id: 9, username: "alice", avatar: "", status: "online" },
          participants: [],
          name: "",
          isGroup: false,
          lastMessageId: null,
          lastMessage: "",
          lastMessageAt: "",
          unreadCount: 2,
          mentionCount: 0,
        },
      ],
    }));

    // Store notifications are batched on a microtask.
    await vi.waitFor(() => {
      expect(shown(button())).toBe(true);
    });
  });

  it("clears every badge and hides itself when clicked", async () => {
    mount(CHANNELS);

    button().click();

    expect(sent).toEqual([1]);
    expect(channelsStore.getState().channels.get(1)?.unreadCount).toBe(0);
    await vi.waitFor(() => {
      expect(shown(button())).toBe(false);
    });
  });

  it("stops following the stores once the sidebar area is torn down", async () => {
    mount([CHANNELS[1]!]);
    const btn = button();
    for (const unsub of area.unsubscribers) unsub();

    setChannels(CHANNELS);
    await Promise.resolve();

    expect(shown(btn)).toBe(false);
  });

  // jsdom applies no stylesheet, so this reads the rules instead: no rule that
  // scopes under `.sidebar-content-inner` (or targets any element the control
  // sits in) may `display: none` it. Rules scoped to `.sidebar-content-inner`
  // only apply when the control is actually inside it.
  it("is not hidden by any app.css rule that matches an element it sits in", () => {
    mount(CHANNELS);
    const control = button();
    const insideContentInner = control.closest(".sidebar-content-inner") !== null;

    const hiding: string[] = [];
    for (let el: Element | null = control; el !== null; el = el.parentElement) {
      for (const cls of el.classList) {
        const selectors = [`.${cls}`];
        if (insideContentInner) selectors.push(`.sidebar-content-inner .${cls}`);
        for (const selector of selectors) {
          if (keyword(cascadedDeclaration(selector, "display")) === "none") hiding.push(selector);
        }
      }
    }

    expect(hiding).toEqual([]);
  });
});
