import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/sidebarAreaMocks";
import { byName } from "../../helpers/tableCases";
import type { ApiClient } from "@lib/api";
import {
  createSidebarArea,
  type SidebarAreaOptions,
} from "../../../src/pages/main-page/SidebarArea";
import {
  createContentNavigator,
  type ContentNavigator,
} from "../../../src/features/navigation/contentView";
import { channelsStore, setActiveChannel, setRoles } from "../../../src/stores/channels.store";
import { dmStore, addDmChannel } from "../../../src/stores/dm.store";
import { uiStore, setSidebarMode } from "../../../src/stores/ui.store";
import { authStore, type AuthState } from "../../../src/stores/auth.store";
import { Permission } from "../../../src/lib/types";
import { createChannelSidebar } from "@components/ChannelSidebar";
import { createMemberList } from "@components/MemberList";
import { createCreateChannelModal } from "@components/CreateChannelModal";
import "../../../src/pages/main-page/MemberPickerModal";
import { openBanDialogFor } from "../../helpers/banDialog";
import {
  MockedFn,
  getMockDestroy,
  resetStores,
  resetMocks,
  makeDm,
  defaultOpts,
  cleanup,
  mountArea,
  firstCallArg,
  optsWithToast,
  lastCallArg,
  makeChannel,
  seedChannels,
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

const { mockOpenUrl } = mocks;

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

  const mountWithStartCall = () => {
    const onStartCall = vi.fn();
    const opts = defaultOpts();
    const result = mountArea(container, { ...opts, onStartCall });
    return { onStartCall, opts, result };
  };

  const signedIn = { token: "tok", isAuthenticated: true } as const;

  /** Give the current user a single role holding `permissions`. */
  function signInWithRole(
    roleName: string,
    permissions: number,
    session: Partial<AuthState> = {},
  ): void {
    setRoles([{ id: 9, name: roleName, color: null, permissions }]);
    authStore.setState((prev) => ({
      ...prev,
      ...session,
      user: { id: 9, username: "U", avatar: null, role: roleName },
    }));
  }

  // -------------------------------------------------------------------------
  // Member list callbacks in channels mode
  // -------------------------------------------------------------------------

  describe("member list callbacks in channels mode", () => {
    /** Extract callbacks passed to createMemberList */
    function getMemberListCallbacks(): {
      onKick: (userId: number, username: string) => Promise<void>;
      onBan: (userId: number, username: string, displayName: string) => void;
      onChangeRole: (userId: number, username: string, newRole: string) => Promise<void>;
    } {
      return lastCallArg(createMemberList as MockedFn);
    }

    it("onKick (Force Logout) calls API and shows success toast", async () => {
      const { opts, toast } = optsWithToast();

      const result = mountArea(container, opts);

      const callbacks = getMemberListCallbacks();
      await callbacks.onKick(2, "Alice");

      expect(opts.api.adminKickMember).toHaveBeenCalledWith(2);
      expect(toast.show).toHaveBeenCalledWith("Forced Alice to log out", "success");

      cleanup(result);
    });

    it.each(
      byName([
        {
          name: "onKick shows error toast on failure",
          reason: new Error("Kick denied"),
          message: "Kick denied",
        },
        {
          name: "onKick shows generic error for non-Error exceptions",
          reason: "string",
          message: "Failed to force logout",
        },
      ]),
    )("%s", async (_name, { reason, message }) => {
      const { opts, toast } = optsWithToast();
      (opts.api.adminKickMember as MockedFn).mockRejectedValue(reason);

      const result = mountArea(container, opts);

      await getMemberListCallbacks().onKick(2, "Alice");

      expect(toast.show).toHaveBeenCalledWith(message, "error");

      cleanup(result);
    });

    it("onBan opens the dialog, calls the API and shows the success toast", async () => {
      const { opts, toast } = optsWithToast();

      const result = mountArea(container, opts);

      const { reason, confirm } = await openBanDialogFor(getMemberListCallbacks());
      reason.value = "spamming";
      confirm.click();
      await vi.waitFor(() => expect(toast.show).toHaveBeenCalledWith("Banned Bob", "success"));

      expect(opts.api.adminBanMember).toHaveBeenCalledWith(3, "spamming", 0, undefined, 0);

      cleanup(result);
    });

    it.each(
      byName([
        {
          name: "onBan shows the error in the dialog on failure",
          reason: new Error("Ban denied"),
          message: "Ban denied",
        },
        {
          name: "onBan shows generic error for non-Error exceptions",
          reason: "string",
          message: "Failed to ban member",
        },
      ]),
    )("%s", async (_name, { reason, message }) => {
      const { opts } = optsWithToast();
      (opts.api.adminBanMember as MockedFn).mockRejectedValue(reason);

      const result = mountArea(container, opts);

      const { confirm, status } = await openBanDialogFor(getMemberListCallbacks());
      confirm.click();
      await vi.waitFor(() => expect(status.textContent).toBe(message));

      cleanup(result);
      document.querySelector('[data-testid="ban-dialog"]')?.remove();
    });

    it("onChangeRole calls API with correct role ID", async () => {
      const { opts, toast } = optsWithToast();

      // Set up roles in channelsStore
      channelsStore.setState((prev) => ({
        ...prev,
        roles: [
          { id: 1, name: "owner", color: null, permissions: 0 },
          { id: 2, name: "admin", color: null, permissions: 0 },
          { id: 4, name: "member", color: null, permissions: 0 },
        ],
      }));

      const result = mountArea(container, opts);

      const callbacks = getMemberListCallbacks();
      await callbacks.onChangeRole(4, "Charlie", "admin");

      expect(opts.api.adminChangeRole).toHaveBeenCalledWith(4, 2);
      expect(toast.show).toHaveBeenCalledWith("Changed Charlie's role to admin", "success");

      cleanup(result);
    });

    it.each(
      byName([
        {
          name: "onChangeRole shows error toast on failure",
          reason: new Error("Role denied"),
          message: "Role denied",
        },
        {
          name: "onChangeRole shows generic error for non-Error exceptions",
          reason: "string",
          message: "Failed to change role",
        },
      ]),
    )("%s", async (_name, { reason, message }) => {
      const { opts, toast } = optsWithToast();
      (opts.api.adminChangeRole as MockedFn).mockRejectedValue(reason);

      channelsStore.setState((prev) => ({
        ...prev,
        roles: [{ id: 2, name: "admin", color: null, permissions: 0 }],
      }));

      const result = mountArea(container, opts);

      await getMemberListCallbacks().onChangeRole(4, "Charlie", "admin");

      expect(toast.show).toHaveBeenCalledWith(message, "error");

      cleanup(result);
    });

    it("onChangeRole reports an unresolvable role instead of failing silently", async () => {
      const { opts, toast } = optsWithToast();

      const result = mountArea(container, opts);

      const callbacks = getMemberListCallbacks();
      await callbacks.onChangeRole(4, "Charlie", "nonexistent");

      expect(opts.api.adminChangeRole).not.toHaveBeenCalled();
      expect(toast.show).toHaveBeenCalledWith(
        'Unknown role "nonexistent" — try reconnecting',
        "error",
      );

      cleanup(result);
    });

    it("passes currentUserRole from auth store", () => {
      authStore.setState((prev) => ({
        ...prev,
        user: { id: 1, username: "testuser", role: "owner", avatar: null, totp_enabled: false },
      }));

      const result = mountArea(container);

      const lastCall = lastCallArg(createMemberList as MockedFn);
      expect(lastCall.currentUserRole).toBe("owner");

      cleanup(result);
    });

    it("defaults currentUserRole to member when user is null", () => {
      authStore.setState((prev) => ({ ...prev, user: null }));

      const result = mountArea(container);

      const lastCall = lastCallArg(createMemberList as MockedFn);
      expect(lastCall.currentUserRole).toBe("member");

      cleanup(result);
    });

    it("starts a call in the existing 1:1 DM", () => {
      addDmChannel(makeDm({ channelId: 100 }));
      const { onStartCall, opts, result } = mountWithStartCall();

      const lastCall = lastCallArg(createMemberList as MockedFn);
      lastCall.onCallUser(10);

      // The known DM is selected (no REST create) and the call starts in it.
      expect(opts.api.createDm).not.toHaveBeenCalled();
      expect(onStartCall).toHaveBeenCalledTimes(1);
      expect(channelsStore.getState().activeChannelId).toBe(100);

      cleanup(result);
    });

    it("creates the 1:1 DM first, then starts the call in it", async () => {
      const { onStartCall, opts, result } = mountWithStartCall();

      const lastCall = lastCallArg(createMemberList as MockedFn);
      // The default api stub resolves a DM with channel_id 200.
      lastCall.onCallUser(20);

      await vi.waitFor(() => expect(onStartCall).toHaveBeenCalledTimes(1));
      expect(opts.api.createDm).toHaveBeenCalledWith(20);
      expect(channelsStore.getState().activeChannelId).toBe(200);

      cleanup(result);
    });
  });

  describe("buildMemberPanel", () => {
    it("Call opens an existing DM and starts the call", () => {
      addDmChannel(makeDm({ channelId: 100 }));
      const { onStartCall, opts, result } = mountWithStartCall();

      const panel = result.buildMemberPanel();
      lastCallArg(createMemberList as MockedFn).onCallUser(10);

      expect(opts.api.createDm).not.toHaveBeenCalled();
      expect(onStartCall).toHaveBeenCalledTimes(1);
      expect(channelsStore.getState().activeChannelId).toBe(100);

      panel.destroy();
      cleanup(result);
    });
  });

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  describe("cleanup", () => {
    it("calling all unsubscribers cleans up active modal", async () => {
      const result = mountArea(container);

      // Open a modal
      const callArgs = firstCallArg(createChannelSidebar as MockedFn);
      callArgs.onCreateChannel("General");
      await vi.dynamicImportSettled();

      const destroyFn = getMockDestroy(createCreateChannelModal as MockedFn);

      cleanup(result);

      expect(destroyFn).toHaveBeenCalled();
    });

    it("calling all unsubscribers cleans up active sidebar content", () => {
      const result = mountArea(container);

      const destroyFn = getMockDestroy(createChannelSidebar as MockedFn);

      cleanup(result);

      expect(destroyFn).toHaveBeenCalled();
    });

    it("calling all unsubscribers cleans up channel mode extras", () => {
      const result = mountArea(container);

      const destroyFn = getMockDestroy(createMemberList as MockedFn);

      cleanup(result);

      expect(destroyFn).toHaveBeenCalled();
    });
  });
  // -------------------------------------------------------------------------
  // Audit log entry point
  // -------------------------------------------------------------------------
  //
  // The log itself stays in the admin panel; the desktop client only owes its
  // moderators a way in. The entry is gated on VIEW_AUDIT_LOG, and the gate has
  // to survive `ready` landing after the header is built.

  describe("audit log entry point", () => {
    const auditBtn = (result: ReturnType<typeof createSidebarArea>): HTMLElement | null =>
      result.sidebarWrapper.querySelector("[data-testid='audit-log-btn']");

    it.each(
      byName([
        {
          name: "is shown to a role holding VIEW_AUDIT_LOG",
          role: "Moderator",
          permissions: Permission.VIEW_AUDIT_LOG,
          shown: true,
        },
        {
          name: "is hidden from a role without the bit",
          role: "Member",
          permissions: Permission.SEND_MESSAGES,
          shown: false,
        },
      ]),
    )("%s", (_name, { role, permissions, shown }) => {
      signInWithRole(role, permissions, signedIn);
      const result = createSidebarArea(defaultOpts());
      expect(auditBtn(result)?.style.display === "none").toBe(!shown);
      cleanup(result);
    });

    // `ready` can land after the header is built, and a moderator whose role
    // only becomes known then would otherwise never see the entry.
    it("appears when the role list arrives after mount", () => {
      authStore.setState((prev) => ({
        ...prev,
        token: "tok",
        user: { id: 9, username: "U", avatar: null, role: "Moderator" },
        isAuthenticated: true,
      }));
      setRoles([]);
      const result = createSidebarArea(defaultOpts());
      expect(auditBtn(result)?.style.display).toBe("none");

      setRoles([{ id: 9, name: "Moderator", color: null, permissions: Permission.VIEW_AUDIT_LOG }]);
      // Store notifications are batched on a microtask.
      channelsStore.flush();

      expect(auditBtn(result)?.style.display).not.toBe("none");
      cleanup(result);
    });

    it("opens the admin panel's audit section in the browser", async () => {
      mockOpenUrl.mockClear();
      signInWithRole("Owner", Permission.ADMINISTRATOR, signedIn);
      const result = createSidebarArea(defaultOpts());

      auditBtn(result)?.click();

      await vi.waitFor(() => {
        expect(mockOpenUrl).toHaveBeenCalledWith("https://localhost:8080/admin#audit");
      });
      cleanup(result);
    });

    it("toasts instead of opening a bogus URL with no host", async () => {
      mockOpenUrl.mockClear();
      signInWithRole("Owner", Permission.ADMINISTRATOR, signedIn);
      const opts = defaultOpts();
      (opts.api.getConfig as ReturnType<typeof vi.fn>).mockReturnValue({ host: "" });
      const show = vi.fn();
      (opts.getToast as ReturnType<typeof vi.fn>).mockReturnValue({ show });
      const result = createSidebarArea(opts);

      auditBtn(result)?.click();

      expect(mockOpenUrl).not.toHaveBeenCalled();
      expect(show).toHaveBeenCalledWith("Not connected to a server", "error");
      cleanup(result);
    });
  });

  // -------------------------------------------------------------------------
  // Invite entry point
  // -------------------------------------------------------------------------
  //
  // The invite routes are MANAGE_INVITES-only on the server, so the button is
  // hidden from roles without the bit instead of failing on click.

  describe("invite entry point", () => {
    const inviteBtn = (result: ReturnType<typeof createSidebarArea>): HTMLElement | null =>
      result.sidebarWrapper.querySelector("[data-testid='invite-btn']");

    it.each(
      byName([
        {
          name: "is shown to a role holding MANAGE_INVITES",
          role: "Inviter",
          permissions: Permission.MANAGE_INVITES,
          shown: true,
        },
        {
          name: "is shown to ADMINISTRATOR",
          role: "Owner",
          permissions: Permission.ADMINISTRATOR,
          shown: true,
        },
        {
          name: "is hidden from a role without the bit",
          role: "Member",
          permissions: Permission.SEND_MESSAGES,
          shown: false,
        },
      ]),
    )("%s", (_name, { role, permissions, shown }) => {
      signInWithRole(role, permissions, signedIn);
      const result = createSidebarArea(defaultOpts());
      expect(inviteBtn(result)?.style.display === "none").toBe(!shown);
      cleanup(result);
    });

    it("follows a role list that arrives or changes after mount", () => {
      authStore.setState((prev) => ({
        ...prev,
        token: "tok",
        user: { id: 9, username: "U", avatar: null, role: "Member" },
        isAuthenticated: true,
      }));
      setRoles([]);
      const result = createSidebarArea(defaultOpts());
      expect(inviteBtn(result)?.style.display).toBe("none");

      setRoles([{ id: 9, name: "Member", color: null, permissions: Permission.MANAGE_INVITES }]);
      channelsStore.flush();
      expect(inviteBtn(result)?.style.display).not.toBe("none");

      setRoles([{ id: 9, name: "Member", color: null, permissions: Permission.SEND_MESSAGES }]);
      channelsStore.flush();
      expect(inviteBtn(result)?.style.display).toBe("none");
      cleanup(result);
    });
  });

  // -------------------------------------------------------------------------
  // B9-4 navigation entries (Q2)
  // -------------------------------------------------------------------------
  //
  // Each destination's entry appears only once its feature ships (an entry in
  // `destinations`), and the Moderation entry only with MODERATE_MEMBERS.

  describe("navigation entries", () => {
    let host: HTMLDivElement;
    let pending: number;
    let pendingListeners: Array<() => void>;

    const inert = (): HTMLElement => document.createElement("div");

    function destinations(): NonNullable<SidebarAreaOptions["destinations"]> {
      return {
        requests: {
          build: inert,
          pending: {
            get: () => pending,
            subscribe: (fn) => {
              pendingListeners.push(fn);
              return () => {
                pendingListeners = pendingListeners.filter((l) => l !== fn);
              };
            },
          },
        },
        moderation: { build: inert },
      };
    }

    function setPending(n: number): void {
      pending = n;
      for (const fn of pendingListeners) fn();
    }

    function mount(extra: Partial<SidebarAreaOptions> = {}): ReturnType<typeof createSidebarArea> {
      const result = createSidebarArea({ ...defaultOpts(), ...extra });
      host.appendChild(result.sidebarWrapper);
      return result;
    }

    const q = (result: ReturnType<typeof createSidebarArea>, id: string): HTMLElement | null =>
      result.sidebarWrapper.querySelector(`[data-testid='${id}']`);

    beforeEach(() => {
      resetStores();
      resetMocks();
      pending = 0;
      pendingListeners = [];
      host = document.createElement("div");
      document.body.appendChild(host);
    });

    afterEach(() => {
      host.remove();
    });

    it("shows no entry for a destination this build does not ship", () => {
      signInWithRole("Owner", Permission.ADMINISTRATOR);
      const result = mount();
      expect(q(result, "moderation-btn")).toBeNull();
      expect(q(result, "dm-requests-badge")).toBeNull();

      setSidebarMode("dms");
      uiStore.flush();
      expect(q(result, "dm-requests-entry")).toBeNull();
      cleanup(result);
    });

    describe("Moderation", () => {
      it("sits beside Audit Log for a role holding MODERATE_MEMBERS", () => {
        signInWithRole("Moderator", Permission.MODERATE_MEMBERS | Permission.VIEW_AUDIT_LOG);
        const result = mount({ destinations: destinations() });
        const btn = q(result, "moderation-btn");
        expect(btn?.style.display).not.toBe("none");
        expect(btn?.getAttribute("aria-label")).toBe("Moderation");
        expect(btn?.tagName).toBe("BUTTON");
        expect(btn?.previousElementSibling).toBe(q(result, "audit-log-btn"));
        cleanup(result);
      });

      it("is hidden without the bit, and follows a role list that arrives or changes later", () => {
        signInWithRole("Member", Permission.SEND_MESSAGES);
        const result = mount({ destinations: destinations() });
        expect(q(result, "moderation-btn")?.style.display).toBe("none");

        setRoles([
          { id: 9, name: "Member", color: null, permissions: Permission.MODERATE_MEMBERS },
        ]);
        channelsStore.flush();
        expect(q(result, "moderation-btn")?.style.display).not.toBe("none");

        setRoles([{ id: 9, name: "Member", color: null, permissions: Permission.SEND_MESSAGES }]);
        channelsStore.flush();
        expect(q(result, "moderation-btn")?.style.display).toBe("none");
        cleanup(result);
      });

      it("opens the content view with itself as the opener, and marks itself current", () => {
        signInWithRole("Moderator", Permission.MODERATE_MEMBERS);
        const onOpenView = vi.fn();
        const result = mount({ destinations: destinations(), onOpenView });
        const btn = q(result, "moderation-btn")!;

        btn.click();
        expect(onOpenView).toHaveBeenCalledWith("moderation", btn);

        uiStore.setState((prev) => ({ ...prev, activeView: "moderation" }));
        uiStore.flush();
        expect(btn.getAttribute("aria-current")).toBe("page");
        uiStore.setState((prev) => ({ ...prev, activeView: null }));
        uiStore.flush();
        expect(btn.hasAttribute("aria-current")).toBe(false);
        cleanup(result);
      });
    });

    describe("Message Requests", () => {
      it("heads DM mode with the pending count, live", () => {
        pending = 2;
        const result = mount({ destinations: destinations() });
        setSidebarMode("dms");
        uiStore.flush();

        const entry = q(result, "dm-requests-entry");
        expect(entry?.tagName).toBe("BUTTON");
        expect(entry?.textContent).toBe("Message Requests (2)");
        // The top of DM mode: its section is the first thing in the content slot.
        const section = entry?.parentElement;
        expect(section?.parentElement?.firstElementChild).toBe(section);

        setPending(0);
        expect(entry?.textContent).toBe("Message Requests");
        setPending(1);
        expect(entry?.textContent).toBe("Message Requests (1)");
        cleanup(result);
      });

      it("opens the content view with itself as the opener", () => {
        const onOpenView = vi.fn();
        const result = mount({ destinations: destinations(), onOpenView });
        setSidebarMode("dms");
        uiStore.flush();
        const entry = q(result, "dm-requests-entry")!;
        entry.click();
        expect(onOpenView).toHaveBeenCalledWith("requests", entry);
        cleanup(result);
      });

      it("keeps its element (and focus) when the DM list redraws", () => {
        const result = mount({ destinations: destinations() });
        setSidebarMode("dms");
        uiStore.flush();
        const entry = q(result, "dm-requests-entry")!;
        entry.focus();

        addDmChannel(makeDm({ channelId: 100 }));
        dmStore.flush();

        expect(q(result, "dm-requests-entry")).toBe(entry);
        expect(document.activeElement).toBe(entry);
        cleanup(result);
      });

      it("leaves with DM mode and stops listening to the count", () => {
        const result = mount({ destinations: destinations() });
        setSidebarMode("dms");
        uiStore.flush();
        const inDmMode = [...pendingListeners];
        setSidebarMode("channels");
        uiStore.flush();
        expect(q(result, "dm-requests-entry")).toBeNull();
        expect(pendingListeners.some((l) => inDmMode.includes(l))).toBe(false);
        cleanup(result);
      });

      it("badges the DM header apart from unread, and never adds to it", () => {
        addDmChannel(makeDm({ channelId: 100, unreadCount: 3 }));
        pending = 2;
        const result = mount({ destinations: destinations() });

        const badge = q(result, "dm-requests-badge");
        expect(badge?.style.display).not.toBe("none");
        expect(badge?.querySelector("[aria-hidden='true']")?.textContent).toBe("2");
        expect(badge?.querySelector(".sr-only")?.textContent).toBe("2 pending message requests");
        const unread = result.sidebarWrapper.querySelector(".dm-header-unread-badge");
        expect(unread?.textContent).toBe("3");

        setPending(1);
        expect(badge?.querySelector(".sr-only")?.textContent).toBe("1 pending message request");
        expect(unread?.textContent).toBe("3");
        setPending(0);
        expect(badge?.style.display).toBe("none");
        cleanup(result);
      });

      it("lists pending requests as a row that opens the inbox, for a user with no DMs", () => {
        pending = 2;
        const onOpenView = vi.fn();
        const result = mount({ destinations: destinations(), onOpenView });
        expect(result.sidebarWrapper.querySelectorAll("[data-testid='dm-entry']")).toHaveLength(0);

        const row = q(result, "dm-section-requests-entry");
        expect(row?.tagName).toBe("BUTTON");
        expect(row?.style.display).not.toBe("none");
        expect(row?.textContent).toBe("Message Requests (2)");
        row?.click();
        expect(onOpenView).toHaveBeenCalledWith("requests", row);

        setPending(1);
        expect(row?.textContent).toBe("Message Requests (1)");
        setPending(0);
        expect(row?.style.display).toBe("none");
        cleanup(result);
      });

      it("hides the requests row while the DM section is collapsed", () => {
        pending = 1;
        const result = mount({ destinations: destinations() });
        const row = q(result, "dm-section-requests-entry");
        const header = result.sidebarWrapper.querySelector<HTMLElement>(
          ".sidebar-dm-section .category",
        );
        header?.click();
        expect(row?.style.display).toBe("none");
        setPending(2);
        expect(row?.style.display).toBe("none");
        header?.click();
        expect(row?.style.display).not.toBe("none");
        expect(row?.textContent).toBe("Message Requests (2)");
        cleanup(result);
      });

      it("opens DM mode from the badge for a user with no DMs", () => {
        pending = 1;
        const result = mount({ destinations: destinations() });
        expect(result.sidebarWrapper.querySelectorAll("[data-testid='dm-entry']")).toHaveLength(0);

        const badge = q(result, "dm-requests-badge");
        expect(badge?.tagName).toBe("BUTTON");
        badge?.focus();
        expect(document.activeElement).toBe(badge);
        badge?.click();
        uiStore.flush();

        expect(uiStore.getState().sidebarMode).toBe("dms");
        const entry = q(result, "dm-requests-entry");
        expect(entry?.textContent).toBe("Message Requests (1)");
        // The badge left with channel mode; focus lands on the entry, not <body>.
        expect(document.activeElement).toBe(entry);
        cleanup(result);
      });
    });

    describe("the back path", () => {
      function seed(): void {
        seedChannels([
          makeChannel({ id: 1, name: "general", position: 0 }),
          makeChannel({ id: 2, name: "random", position: 1 }),
          makeChannel({ id: 100, name: "alice", type: "dm", position: 0 }),
        ]);
      }

      it("returns to the remembered channel and leaves DM mode", () => {
        seed();
        setActiveChannel(2);
        const result = mount();
        result.rememberChannel();
        setSidebarMode("dms");
        setActiveChannel(null);

        result.returnToChannel();

        expect(uiStore.getState().sidebarMode).toBe("channels");
        expect(channelsStore.getState().activeChannelId).toBe(2);
        cleanup(result);
      });

      it("skips a remembered channel that has since been deleted", () => {
        seed();
        setActiveChannel(2);
        const result = mount();
        result.rememberChannel();
        setActiveChannel(null);
        channelsStore.setState((prev) => {
          const channels = new Map(prev.channels);
          channels.delete(2);
          return { ...prev, channels };
        });

        result.returnToChannel();

        expect(channelsStore.getState().activeChannelId).toBe(1);
        cleanup(result);
      });

      it("never remembers a DM as the channel to go back to", () => {
        seed();
        setActiveChannel(100);
        const result = mount();
        result.rememberChannel();
        setActiveChannel(null);

        result.returnToChannel();

        // No channel remembered: the first text channel, as the DM back arrow does.
        expect(channelsStore.getState().activeChannelId).toBe(1);
        cleanup(result);
      });

      /** A content navigator wired to the sidebar the way MainPage wires it. */
      function navigatorFor(
        result: ReturnType<typeof createSidebarArea>,
        fallback: HTMLElement,
      ): ContentNavigator {
        const chatArea = document.createElement("div");
        const nav = createContentNavigator({
          destinations: destinations(),
          api: {} as ApiClient,
          chatArea,
          rememberChannel: result.rememberChannel,
          forgetChannel: result.forgetChannel,
          returnToChannel: result.returnToChannel,
          fallbackFocus: () => fallback.focus(),
        });
        host.append(chatArea, nav.element, fallback);
        return nav;
      }

      it("closing a Requests view focuses the fallback once DM mode takes the entry away", async () => {
        seed();
        setActiveChannel(2);
        const fallback = document.createElement("button");
        let nav: ContentNavigator | null = null;
        const result = mount({
          destinations: destinations(),
          onOpenView: (id, opener) => nav?.open(id, opener),
        });
        nav = navigatorFor(result, fallback);
        setSidebarMode("dms");
        uiStore.flush();
        q(result, "dm-requests-entry")!.click();
        channelsStore.flush();
        uiStore.flush();
        expect(uiStore.getState().activeView).toBe("requests");

        nav.close();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(channelsStore.getState().activeChannelId).toBe(2);
        expect(q(result, "dm-requests-entry")).toBeNull();
        expect(document.activeElement).toBe(fallback);
        nav.destroy();
        cleanup(result);
      });

      it("choosing another channel over a view does not leave the view's return channel", () => {
        seed();
        setActiveChannel(1);
        const result = mount({ destinations: destinations() });
        const nav = navigatorFor(result, document.createElement("button"));
        nav.open("requests", null);
        channelsStore.flush();

        setActiveChannel(2);
        channelsStore.flush();
        expect(uiStore.getState().activeView).toBeNull();

        // "View all messages" enters DM mode bare; Back then stays on channel 2.
        setSidebarMode("dms");
        result.returnToChannel();
        expect(channelsStore.getState().activeChannelId).toBe(2);
        nav.destroy();
        cleanup(result);
      });
    });
  });
});
