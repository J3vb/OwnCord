import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/sidebarAreaMocks";
import { cascadedDeclaration, keyword } from "../../helpers/app-css";
import {
  createSidebarArea,
  type SidebarAreaOptions,
} from "../../../src/pages/main-page/SidebarArea";
import { setRoles } from "../../../src/stores/channels.store";
import { dmStore, addDmChannel } from "../../../src/stores/dm.store";
import { uiStore, setSidebarMode } from "../../../src/stores/ui.store";
import { authStore } from "../../../src/stores/auth.store";
import { Permission } from "../../../src/lib/types";
import { membersStore } from "../../../src/stores/members.store";
import { leaveVoiceChannel } from "../../../src/stores/voice.store";
import { createChannelSidebar } from "@components/ChannelSidebar";
import { createMemberList } from "@components/MemberList";
import { createUserBar } from "@components/UserBar";
import { createVoiceWidget } from "@components/VoiceWidget";
import "../../../src/pages/main-page/MemberPickerModal";
import {
  MockedFn,
  getMockMount,
  getMockDestroy,
  resetStores,
  resetMocks,
  enterVoiceAndAwaitWidget,
  makeDm,
  defaultOpts,
  cleanup,
} from "../../helpers/sidebarAreaHarness";

vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());
vi.mock("@lib/logger", () => mocks.loggerMock());
vi.mock("@lib/ui/toast", () => mocks.uiToastMock());
vi.mock("@lib/presence/profiles", () => mocks.presenceProfilesMock());
vi.mock("@components/ChannelSidebar", () => mocks.channelSidebarMock());
vi.mock("@components/DmSidebar", () => mocks.dmSidebarMock());
vi.mock("@components/MemberList", () => mocks.memberListMock());
vi.mock("@components/UserBar", () => mocks.userBarMock());
vi.mock("@components/VoiceWidget", () => mocks.voiceWidgetMock());
vi.mock("@components/QuickSwitchOverlay", () => mocks.quickSwitchOverlayMock());
vi.mock("@components/CreateChannelModal", () => mocks.createChannelModalMock());
vi.mock("@tauri-apps/api/core", () => mocks.apiCoreMock());
vi.mock("@components/EditChannelModal", () => mocks.editChannelModalMock());
vi.mock("@components/DeleteChannelModal", () => mocks.deleteChannelModalMock());
vi.mock("../../../src/pages/main-page/VoiceCallbacks", () => mocks.pageVoiceCallbacksMock());
vi.mock("../../../src/pages/main-page/OverlayManagers", () => mocks.pageOverlayManagersMock());

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

    it("returns children array with mounted components", async () => {
      const result = createSidebarArea(defaultOpts());
      await enterVoiceAndAwaitWidget();
      // The lazy voice widget is torn down by an unsubscriber, not `children`
      // (the page copies `children` before it loads).
      expect(result.children.length).toBeGreaterThanOrEqual(1);
      cleanup(result);
      leaveVoiceChannel();
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
          [
            1,
            { id: 1, username: "User1", avatar: null, role: "member", status: "online" as const },
          ],
          [
            2,
            { id: 2, username: "User2", avatar: null, role: "member", status: "offline" as const },
          ],
          [
            3,
            { id: 3, username: "User3", avatar: null, role: "member", status: "online" as const },
          ],
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
          [
            1,
            { id: 1, username: "User1", avatar: null, role: "member", status: "online" as const },
          ],
          [
            2,
            { id: 2, username: "User2", avatar: null, role: "member", status: "online" as const },
          ],
          [
            3,
            { id: 3, username: "User3", avatar: null, role: "member", status: "online" as const },
          ],
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
      expect(inviteBtn!.getAttribute("aria-label")).toBe("Invite");

      cleanup(result);
    });
  });

  // -------------------------------------------------------------------------
  // Server header actions
  // -------------------------------------------------------------------------
  //
  // Invite, Audit Log and Moderation are one row of quiet icon buttons in a
  // single group. The permission-gated ones hide inside it, so the row keeps
  // one edge whether it holds one action or three.

  describe("server header actions", () => {
    const destinations = (): NonNullable<SidebarAreaOptions["destinations"]> => ({
      moderation: { build: () => document.createElement("div") },
    });

    function signInAs(permissions: number): void {
      setRoles([{ id: 9, name: "R", color: null, permissions }]);
      authStore.setState((prev) => ({
        ...prev,
        user: { id: 9, username: "U", avatar: null, role: "R" },
      }));
    }

    function mount(): ReturnType<typeof createSidebarArea> {
      const result = createSidebarArea({ ...defaultOpts(), destinations: destinations() });
      container.appendChild(result.sidebarWrapper);
      return result;
    }

    function visibleActions(result: ReturnType<typeof createSidebarArea>): HTMLButtonElement[] {
      const group = result.sidebarWrapper.querySelector(
        ".unified-sidebar-header > .sidebar-header-actions",
      );
      expect(group).not.toBeNull();
      return [...group!.querySelectorAll<HTMLButtonElement>(":scope > button")].filter(
        (b) => b.style.display !== "none",
      );
    }

    const testIds = (buttons: HTMLButtonElement[]): Array<string | null> =>
      buttons.map((b) => b.getAttribute("data-testid"));

    it("shows a plain member no actions (Invite needs MANAGE_INVITES)", () => {
      signInAs(Permission.SEND_MESSAGES);
      const result = mount();
      expect(testIds(visibleActions(result))).toEqual([]);
      cleanup(result);
    });

    it("shows Invite alone for MANAGE_INVITES", () => {
      signInAs(Permission.MANAGE_INVITES);
      const result = mount();
      expect(testIds(visibleActions(result))).toEqual(["invite-btn"]);
      cleanup(result);
    });

    it("adds Audit Log for VIEW_AUDIT_LOG alone", () => {
      signInAs(Permission.MANAGE_INVITES | Permission.VIEW_AUDIT_LOG);
      const result = mount();
      expect(testIds(visibleActions(result))).toEqual(["invite-btn", "audit-log-btn"]);
      cleanup(result);
    });

    it("adds Moderation for MODERATE_MEMBERS alone", () => {
      signInAs(Permission.MANAGE_INVITES | Permission.MODERATE_MEMBERS);
      const result = mount();
      expect(testIds(visibleActions(result))).toEqual(["invite-btn", "moderation-btn"]);
      cleanup(result);
    });

    it("shows all three, in order, for an owner", () => {
      signInAs(Permission.ADMINISTRATOR);
      const result = mount();
      expect(testIds(visibleActions(result))).toEqual([
        "invite-btn",
        "audit-log-btn",
        "moderation-btn",
      ]);
      cleanup(result);
    });

    it("names each icon button and gives it a tooltip, with no visible text", () => {
      signInAs(Permission.ADMINISTRATOR);
      const result = mount();
      const names = visibleActions(result).map((b) => {
        expect(b.getAttribute("type")).toBe("button");
        expect(b.textContent).toBe("");
        expect(b.getAttribute("title")).toBeTruthy();
        const icon = b.querySelector("svg");
        expect(icon?.getAttribute("aria-hidden")).toBe("true");
        return b.getAttribute("aria-label");
      });
      expect(names).toEqual(["Invite", "Audit Log", "Moderation"]);
      cleanup(result);
    });

    it("keeps every action a focusable native button", () => {
      signInAs(Permission.ADMINISTRATOR);
      const result = mount();
      for (const b of visibleActions(result)) {
        expect(b.tagName).toBe("BUTTON");
        expect(b.tabIndex).toBe(0);
        b.focus();
        expect(document.activeElement).toBe(b);
      }
      cleanup(result);
    });

    it("keeps the group on one row, on the header's trailing edge", () => {
      expect(keyword(cascadedDeclaration(".sidebar-header-actions", "flex-wrap"))).toBe("nowrap");
      expect(cascadedDeclaration(".sidebar-header-actions", "margin-left")?.value).toMatchObject({
        value: { type: "auto" },
      });
    });
  });

  // -------------------------------------------------------------------------
  // Collapsed category persistence (OC-0085)
  // -------------------------------------------------------------------------

  describe("collapsed category persistence", () => {
    afterEach(() => {
      localStorage.removeItem("owncord:collapsed:server-a.example.com");
      localStorage.removeItem("owncord:collapsed:OwnCord Server");
    });

    it("scopes collapsed categories to the connected host, not the server display name", () => {
      // Two servers left at the operator default name collide on one
      // localStorage entry if persistence is keyed by display name instead
      // of host — same reason setChannelMutesHost and
      // setAudioVolumeHost are host-scoped.
      authStore.setState((prev) => ({ ...prev, serverName: "OwnCord Server" }));
      localStorage.setItem("owncord:collapsed:server-a.example.com", JSON.stringify(["General"]));
      localStorage.setItem("owncord:collapsed:OwnCord Server", JSON.stringify(["Text Channels"]));

      const opts = defaultOpts();
      (opts.api as unknown as { getConfig: () => { host: string } }).getConfig = () => ({
        host: "server-a.example.com",
      });

      const result = createSidebarArea(opts);

      expect(uiStore.getState().collapsedCategories.has("General")).toBe(true);
      expect(uiStore.getState().collapsedCategories.has("Text Channels")).toBe(false);

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

    it("right layout mounts no sidebar member section", () => {
      localStorage.setItem("owncord:settings:memberListLayout", '"right"');
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      expect(container.querySelector("[data-testid='sidebar-members']")).toBeNull();
      expect(createMemberList).not.toHaveBeenCalled();
      expect(container.querySelector(".sidebar-content-inner")).not.toBeNull();

      cleanup(result);
    });

    it("syncMemberSection adds and removes the section without remounting the channel list", () => {
      localStorage.setItem("owncord:settings:memberListLayout", '"right"');
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);
      const inner = container.querySelector(".sidebar-content-inner");
      expect(inner).not.toBeNull();
      expect(createChannelSidebar).toHaveBeenCalledTimes(1);

      // right -> left: the section appears under the channel list.
      localStorage.setItem("owncord:settings:memberListLayout", '"left"');
      result.syncMemberSection();
      result.syncMemberSection(); // idempotent
      expect(container.querySelectorAll("[data-testid='sidebar-members']").length).toBe(1);
      expect(container.querySelector(".sidebar-content-inner")).toBe(inner);
      expect(createMemberList).toHaveBeenCalledTimes(1);

      // left -> right: the section goes and its list is destroyed.
      const memberDestroy = getMockDestroy(createMemberList as MockedFn);
      localStorage.setItem("owncord:settings:memberListLayout", '"right"');
      result.syncMemberSection();
      expect(container.querySelector("[data-testid='sidebar-members']")).toBeNull();
      expect(memberDestroy).toHaveBeenCalled();
      expect(container.querySelector(".sidebar-content-inner")).toBe(inner);
      expect(createChannelSidebar).toHaveBeenCalledTimes(1);

      cleanup(result);
    });

    it("syncMemberSection builds nothing in DMs mode, in either layout", () => {
      uiStore.setState((prev) => ({ ...prev, sidebarMode: "dms" }));
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      localStorage.setItem("owncord:settings:memberListLayout", '"left"');
      result.syncMemberSection();
      expect(container.querySelector("[data-testid='sidebar-members']")).toBeNull();
      expect(createMemberList).not.toHaveBeenCalled();

      cleanup(result);
    });

    it("returning to channels mode follows the stored layout", () => {
      localStorage.setItem("owncord:settings:memberListLayout", '"right"');
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      setSidebarMode("dms");
      uiStore.flush();
      setSidebarMode("channels");
      uiStore.flush();
      expect(container.querySelector("[data-testid='sidebar-members']")).toBeNull();

      localStorage.setItem("owncord:settings:memberListLayout", '"left"');
      setSidebarMode("dms");
      uiStore.flush();
      setSidebarMode("channels");
      uiStore.flush();
      expect(container.querySelectorAll("[data-testid='sidebar-members']").length).toBe(1);

      cleanup(result);
    });

    it("renders DM list with up to 3 entries", () => {
      for (let i = 0; i < 5; i++) {
        addDmChannel(
          makeDm({
            channelId: 100 + i,
            recipient: { id: 10 + i, username: `User${i}`, avatar: "", status: "online" },
          }),
        );
      }

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const entries = container.querySelectorAll("[data-testid='dm-entry']");
      expect(entries.length).toBe(3);

      cleanup(result);
    });

    it("shows View All button when more than 3 DMs exist", () => {
      for (let i = 0; i < 5; i++) {
        addDmChannel(
          makeDm({
            channelId: 100 + i,
            recipient: { id: 10 + i, username: `User${i}`, avatar: "", status: "online" },
          }),
        );
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
        addDmChannel(
          makeDm({
            channelId: 100 + i,
            recipient: { id: 10 + i, username: `User${i}`, avatar: "", status: "online" },
          }),
        );
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
      addDmChannel(
        makeDm({
          channelId: 101,
          recipient: { id: 11, username: "Bob", avatar: "", status: "online" },
          unreadCount: 2,
        }),
      );

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

    it("add DM button opens member picker", async () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const addBtn = container.querySelector(".category-add-btn") as HTMLElement;
      addBtn.click();
      await vi.dynamicImportSettled();

      const modal = document.querySelector(".dm-member-picker-modal");
      expect(modal).not.toBeNull();

      cleanup(result);
    });

    it("status dots use correct colors for different statuses", () => {
      addDmChannel(
        makeDm({
          channelId: 100,
          recipient: { id: 10, username: "Alice", avatar: "", status: "idle" },
        }),
      );
      addDmChannel(
        makeDm({
          channelId: 101,
          recipient: { id: 11, username: "Bob", avatar: "", status: "dnd" },
        }),
      );
      addDmChannel(
        makeDm({
          channelId: 102,
          recipient: { id: 12, username: "Charlie", avatar: "", status: "offline" },
        }),
      );

      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      const entries = container.querySelectorAll("[data-testid='dm-entry']");
      // Entries are rendered from store (last added first)
      const dots = Array.from(entries).map(
        (e) => (e.querySelector("span") as HTMLElement).style.background,
      );

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
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      // The channel sidebar mounts into the inner slot, whose stylesheet hides
      // its header (jsdom applies no CSS, so the rule is asserted directly).
      const inner = container.querySelector(".sidebar-content > .sidebar-content-inner");
      expect(getMockMount(createChannelSidebar as MockedFn)).toHaveBeenCalledWith(inner);
      expect(
        keyword(cascadedDeclaration(".sidebar-content-inner .channel-sidebar-header", "display")),
      ).toBe("none");

      cleanup(result);
    });

    it("keeps the channel list a floor the member section yields to (B9 Q1 reflow)", () => {
      expect(cascadedDeclaration(".sidebar-content-inner", "min-height")).toBeDefined();
      expect(cascadedDeclaration(".sidebar-members-section", "flex")?.value).toMatchObject({
        value: {
          grow: 1,
          shrink: 1,
          basis: { type: "length-percentage", value: { type: "dimension", value: { value: 0 } } },
        },
      });
    });

    it("sizes the member section to a definite height once one is saved", () => {
      // The channel slot shrink-wraps its rows instead of collapsing to the
      // floor, and the member section fills the rest (P1-01).
      expect(cascadedDeclaration(".sidebar-content-inner", "flex")?.value).toMatchObject({
        value: { grow: 0, shrink: 1, basis: { type: "auto" } },
      });
      // A saved/dragged/collapsed height switches it back to a definite size,
      // so the channel list above can grow to the rest.
      expect(cascadedDeclaration(".sidebar-members-section.sized", "flex")?.value).toMatchObject({
        value: { grow: 0, shrink: 1, basis: { type: "auto" } },
      });
      // And with the section pinned, the channel slot takes the rest back so
      // no gap opens below the member section.
      expect(
        cascadedDeclaration(
          ".sidebar-content:has(.sidebar-members-section.sized) .sidebar-content-inner",
          "flex",
        )?.value,
      ).toMatchObject({
        value: {
          grow: 1,
          shrink: 1,
          basis: { type: "length-percentage", value: { type: "dimension", value: { value: 0 } } },
        },
      });
    });
  });

  // -------------------------------------------------------------------------
  // Voice widget and user bar
  // -------------------------------------------------------------------------

  describe("voice widget and user bar", () => {
    it("mounts voice widget", async () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);
      await enterVoiceAndAwaitWidget();

      expect(createVoiceWidget).toHaveBeenCalled();
      expect(getMockMount(createVoiceWidget as MockedFn)).toHaveBeenCalled();

      cleanup(result);
      leaveVoiceChannel();
    });

    it("mounts user bar", () => {
      const result = createSidebarArea(defaultOpts());
      container.appendChild(result.sidebarWrapper);

      expect(createUserBar).toHaveBeenCalled();
      expect(getMockMount(createUserBar as MockedFn)).toHaveBeenCalled();

      cleanup(result);
    });

    it("passes the ws client to the user bar (presence picker send path)", () => {
      const opts = defaultOpts();
      const result = createSidebarArea(opts);
      container.appendChild(result.sidebarWrapper);

      // Without ws, the status picker is permanently disabled and
      // presence_update can never be sent — this pins the fix.
      expect(createUserBar).toHaveBeenCalledWith(expect.objectContaining({ ws: opts.ws }));

      cleanup(result);
    });

    it("the user bar is in children and the voice widget is destroyed by the unsubscribers", async () => {
      const result = createSidebarArea(defaultOpts());
      await enterVoiceAndAwaitWidget();
      expect(result.children.length).toBe(1);
      const widget = (createVoiceWidget as MockedFn).mock.results.at(-1)!.value as {
        destroy: ReturnType<typeof vi.fn>;
      };
      for (const unsub of result.unsubscribers) unsub();
      expect(widget.destroy).toHaveBeenCalledOnce();
      cleanup(result);
      leaveVoiceChannel();
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

      const memberSection = container.querySelector(
        "[data-testid='sidebar-members']",
      ) as HTMLElement;
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

      const memberSection = container.querySelector(
        "[data-testid='sidebar-members']",
      ) as HTMLElement;
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

      const memberSection = container.querySelector(
        "[data-testid='sidebar-members']",
      ) as HTMLElement;
      expect(memberSection.style.height).toBe("300px");

      cleanup(result);
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
