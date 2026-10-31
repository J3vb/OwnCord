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
import * as mocks from "../helpers/sidebarAreaMocks";
import { lightSidebarAreaOpts, resetSidebarStoresAsMember } from "../helpers/sidebarAreaOpts";
import { cascadedDeclaration, keyword } from "../helpers/app-css";

vi.mock("@lib/voice/livekitSession", () => mocks.rePinSessionMock());
vi.mock("@lib/net/e2eeCrypto", () => mocks.e2eeCryptoMock());
vi.mock("@lib/presence/profiles", () => mocks.presenceProfilesMock());
vi.mock("@components/UserBar", () => mocks.userBarMock());
vi.mock("@components/VoiceWidget", () => mocks.voiceWidgetMock());
vi.mock("@components/MemberList", () => mocks.memberListMock());
vi.mock("@components/QuickSwitchOverlay", () => mocks.quickSwitchOverlayMock());
vi.mock("../../src/pages/main-page/OverlayManagers", () => mocks.inviteManagerMock());

import { createSidebarArea, type SidebarAreaOptions } from "../../src/pages/main-page/SidebarArea";
import { channelsStore, setChannels, setRoles } from "../../src/stores/channels.store";
import { dmStore } from "../../src/stores/dm.store";
import { setMarkReadSender } from "@lib/readState";
import { Permission, type ReadyChannel } from "../../src/lib/types";

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
  return lightSidebarAreaOpts("example.com");
}

describe("SidebarArea — Mark All as Read", () => {
  let container: HTMLDivElement;
  let area: ReturnType<typeof createSidebarArea>;
  let sent: number[];

  beforeEach(() => {
    sent = [];
    setMarkReadSender((id) => sent.push(id));
    resetSidebarStoresAsMember();
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
    expect(button().getAttribute("aria-label")).toBe("Mark Server as Read");
    expect(button().getAttribute("title")).toBe("Mark Server as Read");
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

  it("does not show the button for a DM-only unread: DMs are not part of the server", async () => {
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
    await Promise.resolve();
    await Promise.resolve();
    expect(shown(button())).toBe(false);
  });

  it("leaves DM unread, DM read state and the DM badge alone when clicked", async () => {
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
          mentionCount: 1,
        },
      ],
    }));
    mount(CHANNELS);

    button().click();

    expect(sent).toEqual([1]);
    expect(channelsStore.getState().channels.get(1)?.unreadCount).toBe(0);
    expect(dmStore.getState().channels[0]?.unreadCount).toBe(2);
    expect(dmStore.getState().channels[0]?.mentionCount).toBe(1);
    await vi.waitFor(() => {
      expect(shown(button())).toBe(false);
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

  it("moves focus to Invite before hiding the activated button", async () => {
    setRoles([{ id: 2, name: "Member", color: null, permissions: Permission.MANAGE_INVITES }]);
    channelsStore.flush();
    mount(CHANNELS);
    button().focus();
    expect(document.activeElement).toBe(button());

    button().click();

    await vi.waitFor(() => {
      expect(shown(button())).toBe(false);
    });
    const invite = area.sidebarWrapper.querySelector<HTMLElement>('[data-testid="invite-btn"]');
    expect(document.activeElement).toBe(invite);
  });

  it("moves focus to the channel list when no other header action is shown", async () => {
    // A plain member: Invite, Audit Log and Moderation are all hidden.
    mount(CHANNELS);
    const invite = area.sidebarWrapper.querySelector<HTMLElement>('[data-testid="invite-btn"]')!;
    expect(shown(invite)).toBe(false);
    button().focus();

    button().click();

    await vi.waitFor(() => {
      expect(shown(button())).toBe(false);
    });
    const row = area.sidebarWrapper.querySelector<HTMLElement>('[data-channel-id][tabindex="0"]');
    expect(row).not.toBeNull();
    expect(document.activeElement).toBe(row);
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
