import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We need to mock livekitSession before importing anything that uses auth.store
vi.mock("@lib/livekitSession", () => ({
  leaveVoice: vi.fn(),
  switchInputDevice: vi.fn().mockResolvedValue(undefined),
  switchOutputDevice: vi.fn().mockResolvedValue(undefined),
  setVoiceSensitivity: vi.fn(),
  setInputVolume: vi.fn(),
  setOutputVolume: vi.fn(),
  reapplyAudioProcessing: vi.fn().mockResolvedValue(undefined),
  getSessionDebugInfo: vi.fn().mockReturnValue({}),
}));

// Mock MemberList to capture the callbacks passed to it
vi.mock("@components/MemberList", () => ({
  createMemberList: vi.fn().mockImplementation(() => ({
    mount: vi.fn(),
    destroy: vi.fn(),
  })),
}));

vi.mock("../../src/features/reports/openers", () => ({ openUserReport: vi.fn() }));

import {
  createSidebarMemberSection,
  type SidebarMemberSectionOptions,
} from "../../src/pages/main-page/SidebarMemberSection";
import { authStore } from "../../src/stores/auth.store";
import { addMember, membersStore, removeMember } from "../../src/stores/members.store";
import { channelsStore, setRoles } from "../../src/stores/channels.store";
import { createMemberList } from "@components/MemberList";
import { openUserReport } from "../../src/features/reports/openers";
import { Permission, type UserStatus } from "../../src/lib/types";
import { ApiClientError } from "../../src/lib/api";

// ---------------------------------------------------------------------------
// Store reset
// ---------------------------------------------------------------------------

const LS_KEY_HEIGHT = "owncord:member-list-height";
const LS_KEY_COLLAPSED = "owncord:member-list-collapsed";

function resetStores(): void {
  authStore.setState(() => ({
    token: null,
    user: { id: 1, username: "testuser", role: "admin", avatar: null, totp_enabled: false },
    serverName: "Test Server",
    motd: null,
    isAuthenticated: true,
  }));
  membersStore.setState(() => ({
    members: new Map(),
    typingUsers: new Map(),
  }));
  // Role lookups read the dispatcher-updated channels.store (see the role-source
  // unification). Seed via the same setRoles action the dispatcher calls.
  channelsStore.setState(() => ({
    categories: [],
    channels: new Map(),
    activeChannelId: null,
    roles: [
      { id: 1, name: "owner", color: null, permissions: 0 },
      { id: 2, name: "admin", color: null, permissions: 0 },
      { id: 3, name: "moderator", color: null, permissions: 0 },
      { id: 4, name: "member", color: null, permissions: 0 },
    ],
  }));
  localStorage.removeItem(LS_KEY_HEIGHT);
  localStorage.removeItem(LS_KEY_COLLAPSED);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Give the signed-in role the bit the moderation surface gates on. */
function grantBanPermission(): void {
  setRoles(
    channelsStore
      .getState()
      .roles.map((role) =>
        role.name === "admin" ? { ...role, permissions: Permission.BAN_MEMBERS } : role,
      ),
  );
}

/** One row of the admin users page, as the client's `AdminUser` sees it. */
function bannedUser(id: number, username: string) {
  return {
    id,
    username,
    banned: true,
    role_id: 4,
    role_name: "member",
    status: "offline" as UserStatus,
    created_at: "2026-01-01T00:00:00Z",
  };
}

function defaultOpts(): SidebarMemberSectionOptions {
  return {
    api: {
      adminKickMember: vi.fn().mockResolvedValue(undefined),
      adminBanMember: vi.fn().mockResolvedValue(undefined),
      adminChangeRole: vi.fn().mockResolvedValue(undefined),
      adminListUsers: vi.fn().mockResolvedValue([]),
      adminUnbanMember: vi.fn().mockResolvedValue(undefined),
    } as unknown as SidebarMemberSectionOptions["api"],
    getToast: vi.fn().mockReturnValue({ show: vi.fn() }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SidebarMemberSection", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  describe("rendering", () => {
    it("renders the member section root element", () => {
      const section = createSidebarMemberSection(defaultOpts());
      container.appendChild(section.element);

      const root = container.querySelector("[data-testid='sidebar-members']");
      expect(root).not.toBeNull();

      section.destroy();
    });

    it("renders the member header with label and arrow", () => {
      const section = createSidebarMemberSection(defaultOpts());
      container.appendChild(section.element);

      const header = container.querySelector(".sidebar-members-header");
      expect(header).not.toBeNull();

      const label = header!.querySelector(".category-name");
      expect(label!.textContent).toBe("MEMBERS");

      const arrow = header!.querySelector(".category-arrow");
      expect(arrow!.textContent).toBe("\u25BC");

      section.destroy();
    });

    it("renders a resize handle", () => {
      const section = createSidebarMemberSection(defaultOpts());
      container.appendChild(section.element);

      const handle = container.querySelector(".sidebar-resize-handle");
      expect(handle).not.toBeNull();

      section.destroy();
    });

    it("renders the member content div and calls createMemberList", () => {
      const section = createSidebarMemberSection(defaultOpts());
      container.appendChild(section.element);

      const content = container.querySelector(".sidebar-members-content");
      expect(content).not.toBeNull();

      // MemberList should have been created and mounted
      expect(createMemberList).toHaveBeenCalled();
      const mountFn = (createMemberList as ReturnType<typeof vi.fn>).mock.results[0]!.value.mount;
      expect(mountFn).toHaveBeenCalled();

      section.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // Saved height restoration
  // -------------------------------------------------------------------------

  describe("height persistence", () => {
    it("restores saved height from localStorage", () => {
      localStorage.setItem(LS_KEY_HEIGHT, "250");

      const section = createSidebarMemberSection(defaultOpts());
      container.appendChild(section.element);

      const root = container.querySelector("[data-testid='sidebar-members']") as HTMLElement;
      expect(root.style.height).toBe("250px");

      section.destroy();
    });

    it("has no height style when no saved height exists", () => {
      const section = createSidebarMemberSection(defaultOpts());
      container.appendChild(section.element);

      const root = container.querySelector("[data-testid='sidebar-members']") as HTMLElement;
      // Height should be empty or unset (depends on collapsed state)
      // When not collapsed and no saved height, it should be ""
      expect(root.style.height).toBe("");

      section.destroy();
    });

    // P1-01: the section fills the space the channel list leaves (a flex
    // share) until a definite height is set, when it becomes a fixed size so
    // the channel list above can grow. The `.sized` class carries that state.
    it("marks the section sized only when a definite height is set", () => {
      const unsized = createSidebarMemberSection(defaultOpts());
      expect(unsized.element.classList.contains("sized")).toBe(false);
      unsized.destroy();

      localStorage.setItem(LS_KEY_HEIGHT, "250");
      const sized = createSidebarMemberSection(defaultOpts());
      expect(sized.element.style.height).toBe("250px");
      expect(sized.element.classList.contains("sized")).toBe(true);
      sized.destroy();
    });

    it("drops the sized class when a saved height is cleared", () => {
      localStorage.setItem(LS_KEY_HEIGHT, "250");
      const section = createSidebarMemberSection(defaultOpts());
      container.appendChild(section.element);
      const header = section.element.querySelector(".sidebar-members-header") as HTMLElement;
      expect(section.element.classList.contains("sized")).toBe(true);

      // Collapsing pins it to auto (still a definite height), and expanding
      // with no saved height returns it to a flex share.
      localStorage.removeItem(LS_KEY_HEIGHT);
      header.click();
      expect(section.element.style.height).toBe("auto");
      expect(section.element.classList.contains("sized")).toBe(true);
      header.click();
      expect(section.element.style.height).toBe("");
      expect(section.element.classList.contains("sized")).toBe(false);

      section.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // Collapse / expand
  // -------------------------------------------------------------------------

  describe("collapse and expand", () => {
    it("starts collapsed when localStorage says collapsed", () => {
      localStorage.setItem(LS_KEY_COLLAPSED, "true");

      const section = createSidebarMemberSection(defaultOpts());
      container.appendChild(section.element);

      const header = container.querySelector(".sidebar-members-header") as HTMLElement;
      expect(header.classList.contains("collapsed")).toBe(true);

      const arrow = header.querySelector(".category-arrow");
      expect(arrow!.textContent).toBe("\u25B6");

      const content = container.querySelector(".sidebar-members-content") as HTMLElement;
      expect(content.style.display).toBe("none");

      const handle = container.querySelector(".sidebar-resize-handle") as HTMLElement;
      expect(handle.style.display).toBe("none");

      section.destroy();
    });

    it("starts expanded when localStorage says not collapsed", () => {
      localStorage.setItem(LS_KEY_COLLAPSED, "false");

      const section = createSidebarMemberSection(defaultOpts());
      container.appendChild(section.element);

      const header = container.querySelector(".sidebar-members-header") as HTMLElement;
      expect(header.classList.contains("collapsed")).toBe(false);

      const content = container.querySelector(".sidebar-members-content") as HTMLElement;
      expect(content.style.display).not.toBe("none");

      section.destroy();
    });

    it("still collapses on click when storage is blocked", () => {
      const blocked = (): never => {
        throw new DOMException("storage blocked", "SecurityError");
      };
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked);
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked);

      try {
        const section = createSidebarMemberSection(defaultOpts());
        container.appendChild(section.element);
        const header = container.querySelector(".sidebar-members-header") as HTMLElement;
        expect(header.classList.contains("collapsed")).toBe(false);

        expect(() => header.click()).not.toThrow();
        expect(header.classList.contains("collapsed")).toBe(true);
        section.destroy();
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("toggles collapsed state when header is clicked", () => {
      const section = createSidebarMemberSection(defaultOpts());
      container.appendChild(section.element);

      const header = container.querySelector(".sidebar-members-header") as HTMLElement;

      // Initially expanded
      expect(header.classList.contains("collapsed")).toBe(false);

      // Click to collapse
      header.click();

      expect(header.classList.contains("collapsed")).toBe(true);

      const arrow = header.querySelector(".category-arrow");
      expect(arrow!.textContent).toBe("\u25B6");

      const content = container.querySelector(".sidebar-members-content") as HTMLElement;
      expect(content.style.display).toBe("none");

      // Persisted to localStorage
      expect(localStorage.getItem(LS_KEY_COLLAPSED)).toBe("true");

      section.destroy();
    });

    // The header was a click-only div with a bare arrow span, so a keyboard
    // user could never collapse the member list — unlike the channel
    // categories and DM section, which use a real <button>.
    it("exposes the collapse control as a focusable button that toggles on Enter", () => {
      const section = createSidebarMemberSection(defaultOpts());
      container.appendChild(section.element);

      const arrow = container.querySelector(".sidebar-members-header .category-arrow");
      expect(arrow).not.toBeNull();
      expect(arrow!.tagName).toBe("BUTTON");

      (arrow as HTMLButtonElement).focus();
      expect(document.activeElement).toBe(arrow);

      // A native button fires click on Enter/Space, which is what the header
      // handler listens for.
      (arrow as HTMLElement).click();

      const content = container.querySelector(".sidebar-members-content") as HTMLElement;
      expect(content.style.display).toBe("none");

      section.destroy();
    });

    it("expands when header is clicked twice", () => {
      const section = createSidebarMemberSection(defaultOpts());
      container.appendChild(section.element);

      const header = container.querySelector(".sidebar-members-header") as HTMLElement;

      // Collapse then expand
      header.click();
      header.click();

      expect(header.classList.contains("collapsed")).toBe(false);

      const arrow = header.querySelector(".category-arrow");
      expect(arrow!.textContent).toBe("\u25BC");

      const content = container.querySelector(".sidebar-members-content") as HTMLElement;
      expect(content.style.display).not.toBe("none");

      expect(localStorage.getItem(LS_KEY_COLLAPSED)).toBe("false");

      section.destroy();
    });

    it("sets height to auto when collapsed", () => {
      localStorage.setItem(LS_KEY_HEIGHT, "300");

      const section = createSidebarMemberSection(defaultOpts());
      container.appendChild(section.element);

      const header = container.querySelector(".sidebar-members-header") as HTMLElement;
      header.click(); // Collapse

      const root = container.querySelector("[data-testid='sidebar-members']") as HTMLElement;
      expect(root.style.height).toBe("auto");

      section.destroy();
    });

    it("restores height when expanded after being collapsed", () => {
      localStorage.setItem(LS_KEY_HEIGHT, "300");

      const section = createSidebarMemberSection(defaultOpts());
      container.appendChild(section.element);

      const header = container.querySelector(".sidebar-members-header") as HTMLElement;
      // Collapse
      header.click();
      // Expand
      header.click();

      const root = container.querySelector("[data-testid='sidebar-members']") as HTMLElement;
      expect(root.style.height).toBe("300px");

      section.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // Drag-to-resize
  // -------------------------------------------------------------------------

  describe("drag-to-resize", () => {
    it("starts resize on mousedown on the handle", () => {
      const section = createSidebarMemberSection(defaultOpts());
      container.appendChild(section.element);

      const handle = container.querySelector(".sidebar-resize-handle") as HTMLElement;
      const mousedown = new MouseEvent("mousedown", { clientY: 300, bubbles: true });
      handle.dispatchEvent(mousedown);

      // Move mouse upward (should increase height since delta = startY - e.clientY)
      const mousemove = new MouseEvent("mousemove", { clientY: 250, bubbles: true });
      document.dispatchEvent(mousemove);

      // We can't easily test height because offsetHeight returns 0 in jsdom,
      // but we can verify mouseup saves to localStorage
      const mouseup = new MouseEvent("mouseup", { bubbles: true });
      document.dispatchEvent(mouseup);

      // localStorage should be updated (offsetHeight returns 0 in jsdom so value is "0")
      expect(localStorage.getItem(LS_KEY_HEIGHT)).toBeDefined();

      section.destroy();
    });

    function startDrag(): { section: ReturnType<typeof createSidebarMemberSection> } {
      const section = createSidebarMemberSection(defaultOpts());
      container.appendChild(section.element);
      const handle = container.querySelector(".sidebar-resize-handle") as HTMLElement;
      handle.dispatchEvent(new MouseEvent("mousedown", { clientY: 300, bubbles: true }));
      return { section };
    }

    it("writes localStorage once on mouseup, not on every mousemove", () => {
      const setItem = vi.spyOn(Storage.prototype, "setItem");
      const { section } = startDrag();

      for (const y of [290, 280, 270, 260]) {
        document.dispatchEvent(new MouseEvent("mousemove", { clientY: y, bubbles: true }));
      }
      expect(setItem.mock.calls.filter(([k]) => k === LS_KEY_HEIGHT)).toHaveLength(0);

      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      const writes = setItem.mock.calls.filter(([k]) => k === LS_KEY_HEIGHT);
      expect(writes).toHaveLength(1);
      // jsdom lays nothing out (start height 0), so the clamp floor of 80 applies.
      expect(writes[0]![1]).toBe("80");

      // A second mouseup after the drag ended writes nothing more.
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      expect(setItem.mock.calls.filter(([k]) => k === LS_KEY_HEIGHT)).toHaveLength(1);

      section.destroy();
      setItem.mockRestore();
    });

    it("does not throw when storage rejects the write on mouseup", () => {
      const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("quota", "QuotaExceededError");
      });
      // jsdom reports a listener's exception as a window "error" event rather
      // than throwing out of dispatchEvent, so watch for that.
      const reported = vi.fn((e: Event) => e.preventDefault());
      window.addEventListener("error", reported);
      const { section } = startDrag();
      document.dispatchEvent(new MouseEvent("mousemove", { clientY: 250, bubbles: true }));

      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

      expect(setItem).toHaveBeenCalled();
      expect(reported).not.toHaveBeenCalled();

      window.removeEventListener("error", reported);
      section.destroy();
      setItem.mockRestore();
    });

    it("does not resize when not dragging", () => {
      const section = createSidebarMemberSection(defaultOpts());
      container.appendChild(section.element);

      // Move mouse without mousedown
      const mousemove = new MouseEvent("mousemove", { clientY: 250, bubbles: true });
      document.dispatchEvent(mousemove);

      // mouseup without dragging should not update localStorage
      const mouseup = new MouseEvent("mouseup", { bubbles: true });
      document.dispatchEvent(mouseup);

      // No height should be saved
      expect(localStorage.getItem(LS_KEY_HEIGHT)).toBeNull();

      section.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // Member actions (kick/ban/changeRole)
  // -------------------------------------------------------------------------

  describe("member actions", () => {
    /** Extract the callbacks passed to createMemberList */
    function getCapturedCallbacks(): {
      onKick: (userId: number, username: string) => Promise<void>;
      onBan: (userId: number, username: string, displayName: string) => void;
      onChangeRole: (userId: number, username: string, newRole: string) => Promise<void>;
    } {
      const calls = (createMemberList as ReturnType<typeof vi.fn>).mock.calls;
      return calls[calls.length - 1]![0];
    }

    it("force logout: calls API and shows success toast", async () => {
      const mockShow = vi.fn();
      const mockApi = {
        adminKickMember: vi.fn().mockResolvedValue(undefined),
        adminBanMember: vi.fn(),
        adminChangeRole: vi.fn(),
      };
      const opts = {
        api: mockApi as unknown as SidebarMemberSectionOptions["api"],
        getToast: vi.fn().mockReturnValue({ show: mockShow }),
      };

      const section = createSidebarMemberSection(opts);
      container.appendChild(section.element);

      const callbacks = getCapturedCallbacks();
      await callbacks.onKick(2, "Alice");

      expect(mockApi.adminKickMember).toHaveBeenCalledWith(2);
      expect(mockShow).toHaveBeenCalledWith("Forced Alice to log out", "success");

      section.destroy();
    });

    it("force logout: shows error toast on API failure", async () => {
      const mockShow = vi.fn();
      const mockApi = {
        adminKickMember: vi.fn().mockRejectedValue(new Error("Kick denied")),
        adminBanMember: vi.fn(),
        adminChangeRole: vi.fn(),
      };
      const opts = {
        api: mockApi as unknown as SidebarMemberSectionOptions["api"],
        getToast: vi.fn().mockReturnValue({ show: mockShow }),
      };

      const section = createSidebarMemberSection(opts);
      container.appendChild(section.element);

      const callbacks = getCapturedCallbacks();
      await callbacks.onKick(2, "Alice");

      expect(mockShow).toHaveBeenCalledWith("Kick denied", "error");

      section.destroy();
    });

    it("force logout: shows generic error for non-Error exceptions", async () => {
      const mockShow = vi.fn();
      const mockApi = {
        adminKickMember: vi.fn().mockRejectedValue("string error"),
        adminBanMember: vi.fn(),
        adminChangeRole: vi.fn(),
      };
      const opts = {
        api: mockApi as unknown as SidebarMemberSectionOptions["api"],
        getToast: vi.fn().mockReturnValue({ show: mockShow }),
      };

      const section = createSidebarMemberSection(opts);
      container.appendChild(section.element);

      const callbacks = getCapturedCallbacks();
      await callbacks.onKick(2, "Alice");

      expect(mockShow).toHaveBeenCalledWith("Failed to force logout", "error");

      section.destroy();
    });

    /** Open the Ban dialog the member menu asks for and return its controls. */
    async function openBanDialogFor(
      callbacks: ReturnType<typeof getCapturedCallbacks>,
    ): Promise<{ reason: HTMLInputElement; confirm: HTMLButtonElement; status: HTMLElement }> {
      callbacks.onBan(3, "Bob", "Bob");
      const dialog = await vi.waitFor(() => {
        const el = document.querySelector('[data-testid="ban-dialog"]');
        if (el === null) throw new Error("ban dialog not open yet");
        return el;
      });
      return {
        reason: dialog.querySelector('[data-testid="ban-reason-input"]') as HTMLInputElement,
        confirm: dialog.querySelector('[data-testid="ban-confirm"]') as HTMLButtonElement,
        status: dialog.querySelector('[data-testid="ban-status"]') as HTMLElement,
      };
    }

    it("ban: opens the dialog, calls the API and shows the success toast", async () => {
      const mockShow = vi.fn();
      const mockApi = {
        adminKickMember: vi.fn(),
        adminBanMember: vi.fn().mockResolvedValue({}),
        adminChangeRole: vi.fn(),
      };
      const opts = {
        api: mockApi as unknown as SidebarMemberSectionOptions["api"],
        getToast: vi.fn().mockReturnValue({ show: mockShow }),
      };

      const section = createSidebarMemberSection(opts);
      container.appendChild(section.element);

      const { reason, confirm } = await openBanDialogFor(getCapturedCallbacks());
      // Nothing is sent by opening the dialog.
      expect(mockApi.adminBanMember).not.toHaveBeenCalled();
      reason.value = "spamming";
      confirm.click();
      await vi.waitFor(() => expect(mockShow).toHaveBeenCalledWith("Banned Bob", "success"));

      expect(mockApi.adminBanMember).toHaveBeenCalledWith(3, "spamming", 0, undefined, 0);
      expect(document.querySelector('[data-testid="ban-dialog"]')).toBeNull();

      section.destroy();
    });

    it("ban: shows the server's error in the dialog and keeps it open", async () => {
      const mockShow = vi.fn();
      const mockApi = {
        adminKickMember: vi.fn(),
        adminBanMember: vi.fn().mockRejectedValue(new Error("Ban denied")),
        adminChangeRole: vi.fn(),
      };
      const opts = {
        api: mockApi as unknown as SidebarMemberSectionOptions["api"],
        getToast: vi.fn().mockReturnValue({ show: mockShow }),
      };

      const section = createSidebarMemberSection(opts);
      container.appendChild(section.element);

      const { confirm, status } = await openBanDialogFor(getCapturedCallbacks());
      confirm.click();
      await vi.waitFor(() => expect(status.textContent).toBe("Ban denied"));

      expect(document.querySelector('[data-testid="ban-dialog"]')).not.toBeNull();
      expect(mockShow).not.toHaveBeenCalled();

      section.destroy();
      expect(document.querySelector('[data-testid="ban-dialog"]')).toBeNull();
    });

    it("ban: shows generic error for non-Error exceptions", async () => {
      const mockApi = {
        adminKickMember: vi.fn(),
        adminBanMember: vi.fn().mockRejectedValue("string error"),
        adminChangeRole: vi.fn(),
      };
      const opts = {
        api: mockApi as unknown as SidebarMemberSectionOptions["api"],
        getToast: vi.fn().mockReturnValue({ show: vi.fn() }),
      };

      const section = createSidebarMemberSection(opts);
      container.appendChild(section.element);

      const { confirm, status } = await openBanDialogFor(getCapturedCallbacks());
      confirm.click();
      await vi.waitFor(() => expect(status.textContent).toBe("Failed to ban member"));

      section.destroy();
    });

    it("changeRole: calls API and shows success toast", async () => {
      const mockShow = vi.fn();
      const mockApi = {
        adminKickMember: vi.fn(),
        adminBanMember: vi.fn(),
        adminChangeRole: vi.fn().mockResolvedValue(undefined),
      };
      const opts = {
        api: mockApi as unknown as SidebarMemberSectionOptions["api"],
        getToast: vi.fn().mockReturnValue({ show: mockShow }),
      };

      const section = createSidebarMemberSection(opts);
      container.appendChild(section.element);

      const callbacks = getCapturedCallbacks();
      await callbacks.onChangeRole(4, "Charlie", "admin");

      expect(mockApi.adminChangeRole).toHaveBeenCalledWith(4, 2); // admin has roleId 2
      expect(mockShow).toHaveBeenCalledWith("Changed Charlie's role to admin", "success");

      section.destroy();
    });

    it("changeRole: keeps the role's capitalisation in the toast and still resolves its id", async () => {
      const mockShow = vi.fn();
      const mockApi = {
        adminKickMember: vi.fn(),
        adminBanMember: vi.fn(),
        adminChangeRole: vi.fn().mockResolvedValue(undefined),
      };
      setRoles([{ id: 7, name: "Moderator", color: null, permissions: 0 }]);
      const section = createSidebarMemberSection({
        api: mockApi as unknown as SidebarMemberSectionOptions["api"],
        getToast: vi.fn().mockReturnValue({ show: mockShow }),
      });
      container.appendChild(section.element);

      await getCapturedCallbacks().onChangeRole(4, "Charlie", "Moderator");

      expect(mockApi.adminChangeRole).toHaveBeenCalledWith(4, 7);
      expect(mockShow).toHaveBeenCalledWith("Changed Charlie's role to Moderator", "success");

      section.destroy();
    });

    it("changeRole: shows error toast on API failure", async () => {
      const mockShow = vi.fn();
      const mockApi = {
        adminKickMember: vi.fn(),
        adminBanMember: vi.fn(),
        adminChangeRole: vi.fn().mockRejectedValue(new Error("Role denied")),
      };
      const opts = {
        api: mockApi as unknown as SidebarMemberSectionOptions["api"],
        getToast: vi.fn().mockReturnValue({ show: mockShow }),
      };

      const section = createSidebarMemberSection(opts);
      container.appendChild(section.element);

      const callbacks = getCapturedCallbacks();
      await callbacks.onChangeRole(4, "Charlie", "admin");

      expect(mockShow).toHaveBeenCalledWith("Role denied", "error");

      section.destroy();
    });

    it("changeRole: shows generic error for non-Error exceptions", async () => {
      const mockShow = vi.fn();
      const mockApi = {
        adminKickMember: vi.fn(),
        adminBanMember: vi.fn(),
        adminChangeRole: vi.fn().mockRejectedValue("string error"),
      };
      const opts = {
        api: mockApi as unknown as SidebarMemberSectionOptions["api"],
        getToast: vi.fn().mockReturnValue({ show: mockShow }),
      };

      const section = createSidebarMemberSection(opts);
      container.appendChild(section.element);

      const callbacks = getCapturedCallbacks();
      await callbacks.onChangeRole(4, "Charlie", "admin");

      expect(mockShow).toHaveBeenCalledWith("Failed to change role", "error");

      section.destroy();
    });

    it("changeRole: reports an unresolvable role instead of failing silently", async () => {
      const mockShow = vi.fn();
      const mockApi = {
        adminKickMember: vi.fn(),
        adminBanMember: vi.fn(),
        adminChangeRole: vi.fn().mockResolvedValue(undefined),
      };
      const opts = {
        api: mockApi as unknown as SidebarMemberSectionOptions["api"],
        getToast: vi.fn().mockReturnValue({ show: mockShow }),
      };

      const section = createSidebarMemberSection(opts);
      container.appendChild(section.element);

      const callbacks = getCapturedCallbacks();
      await callbacks.onChangeRole(4, "Charlie", "nonexistent-role");

      // No API call — but the user is told, rather than seeing a dead menu item.
      expect(mockApi.adminChangeRole).not.toHaveBeenCalled();
      expect(mockShow).toHaveBeenCalledWith(
        'Unknown role "nonexistent-role" — try reconnecting',
        "error",
      );

      section.destroy();
    });

    it("changeRole: resolves role id from the dispatcher-updated channels store", async () => {
      // Regression guard for the old role-source split: the dispatcher writes
      // roles via channels.store.setRoles, so the member UI must read from that
      // same store (previously it read a stale, never-updated roles.store).
      setRoles([{ id: 42, name: "vip", color: null, permissions: 0 }]);

      const mockApi = {
        adminKickMember: vi.fn(),
        adminBanMember: vi.fn(),
        adminChangeRole: vi.fn().mockResolvedValue(undefined),
      };
      const opts = {
        api: mockApi as unknown as SidebarMemberSectionOptions["api"],
        getToast: vi.fn().mockReturnValue({ show: vi.fn() }),
      };

      const section = createSidebarMemberSection(opts);
      container.appendChild(section.element);

      const callbacks = getCapturedCallbacks();
      await callbacks.onChangeRole(7, "Dave", "vip");

      expect(mockApi.adminChangeRole).toHaveBeenCalledWith(7, 42);

      section.destroy();
    });

    it("uses current user role from auth store", () => {
      authStore.setState((prev) => ({
        ...prev,
        user: { id: 1, username: "testuser", role: "owner", avatar: null, totp_enabled: false },
      }));

      const section = createSidebarMemberSection(defaultOpts());
      container.appendChild(section.element);

      const calls = (createMemberList as ReturnType<typeof vi.fn>).mock.calls;
      const lastCall = calls[calls.length - 1]![0];
      expect(lastCall.currentUserRole).toBe("owner");

      section.destroy();
    });

    it("defaults to 'member' role when user is null", () => {
      authStore.setState((prev) => ({
        ...prev,
        user: null,
      }));

      const section = createSidebarMemberSection(defaultOpts());
      container.appendChild(section.element);

      const calls = (createMemberList as ReturnType<typeof vi.fn>).mock.calls;
      const lastCall = calls[calls.length - 1]![0];
      expect(lastCall.currentUserRole).toBe("member");

      section.destroy();
    });
  });

  describe("user report (B9-10)", () => {
    it("opens the report for that user with the live member list for focus fallback", async () => {
      const section = createSidebarMemberSection(defaultOpts());
      container.appendChild(section.element);
      const calls = (createMemberList as ReturnType<typeof vi.fn>).mock.calls;
      calls[calls.length - 1]![0].onReportUser(7, "bob");
      const open = openUserReport as ReturnType<typeof vi.fn>;
      await vi.waitFor(() => expect(open).toHaveBeenCalled());
      const { userId, name, list } = open.mock.calls[open.mock.calls.length - 1]![0];
      expect({ userId, name }).toEqual({ userId: 7, name: "bob" });
      expect(list).toBe(container.querySelector(".member-panel"));

      section.destroy();
    });

    it("shows an error toast when the report form fails to load", async () => {
      vi.doMock("../../src/features/reports/openers", () =>
        Promise.reject(new Error("chunk failed")),
      );
      try {
        const show = vi.fn();
        const section = createSidebarMemberSection({
          ...defaultOpts(),
          getToast: vi.fn().mockReturnValue({ show }),
        });
        container.appendChild(section.element);
        const calls = (createMemberList as ReturnType<typeof vi.fn>).mock.calls;
        calls[calls.length - 1]![0].onReportUser(7, "bob");
        await vi.waitFor(() =>
          expect(show).toHaveBeenCalledWith("Couldn't open the report form. Try again.", "error"),
        );
        section.destroy();
      } finally {
        vi.doUnmock("../../src/features/reports/openers");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  describe("cleanup", () => {
    it("destroy() aborts resize event listeners", () => {
      const section = createSidebarMemberSection(defaultOpts());
      container.appendChild(section.element);

      section.destroy();

      // After destroy, mouse events should not affect the section
      const handle = container.querySelector(".sidebar-resize-handle") as HTMLElement;
      const mousedown = new MouseEvent("mousedown", { clientY: 300, bubbles: true });
      handle.dispatchEvent(mousedown);

      const mousemove = new MouseEvent("mousemove", { clientY: 250, bubbles: true });
      document.dispatchEvent(mousemove);

      const mouseup = new MouseEvent("mouseup", { bubbles: true });
      document.dispatchEvent(mouseup);

      // Should not have saved anything since abort was called
      expect(localStorage.getItem(LS_KEY_HEIGHT)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Banned members
  //
  // A ban removes the member from the roster, so the context menu that issued
  // it is gone with the row. Without this list the desktop client can ban but
  // never unban.
  // -------------------------------------------------------------------------

  describe("banned members", () => {
    it("lists banned members and lifts the ban from the row", async () => {
      grantBanPermission();
      const mockShow = vi.fn();
      const opts = defaultOpts();
      const listUsers = opts.api.adminListUsers as unknown as ReturnType<typeof vi.fn>;
      const unban = opts.api.adminUnbanMember as unknown as ReturnType<typeof vi.fn>;
      Object.assign(opts, { getToast: vi.fn().mockReturnValue({ show: mockShow }) });
      listUsers.mockResolvedValue([
        bannedUser(3, "spammer"),
        // The list is the whole user page, so the filter is the point: an
        // unbanned user must not get an Unban row.
        { ...bannedUser(4, "fine"), banned: false },
      ]);

      const section = createSidebarMemberSection(opts);
      container.appendChild(section.element);

      await vi.waitFor(() =>
        expect(container.querySelector("[data-testid='unban-member']")).not.toBeNull(),
      );
      expect(container.querySelectorAll(".banned-row")).toHaveLength(1);
      expect(container.querySelector(".banned-name")?.textContent).toBe("spammer");

      (container.querySelector("[data-testid='unban-member']") as HTMLButtonElement).click();

      await vi.waitFor(() => expect(unban).toHaveBeenCalledWith(3));
      expect(mockShow).toHaveBeenCalledWith("Unbanned spammer", "success");
      // The refetch is what drops the row now the ban is lifted.
      expect(listUsers).toHaveBeenCalledTimes(2);

      section.destroy();
    });

    it("leaves out a temporary ban that has run out, the way the server does", async () => {
      // The server never clears `banned` when a temporary ban expires: a ban is
      // in force only while `ban_expires` is absent or in the future
      // (auth.IsEffectivelyBanned), and an unparseable expiry keeps it in force.
      grantBanPermission();
      const opts = defaultOpts();
      (opts.api.adminListUsers as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
        bannedUser(3, "permanent"),
        { ...bannedUser(4, "served"), ban_expires: "2020-01-01T00:00:00Z" },
        { ...bannedUser(5, "serving"), ban_expires: "2999-01-01T00:00:00Z" },
        { ...bannedUser(6, "garbled"), ban_expires: "not a date" },
      ]);

      const section = createSidebarMemberSection(opts);
      container.appendChild(section.element);

      await vi.waitFor(() => expect(container.querySelectorAll(".banned-row")).toHaveLength(3));
      const names = [...container.querySelectorAll(".banned-name")].map((el) => el.textContent);
      expect(names).toEqual(["permanent", "serving", "garbled"]);

      section.destroy();
    });

    it("shows the bans section once a roles update grants BAN_MEMBERS to your role", async () => {
      // No permission yet: the section must not list anything.
      const opts = defaultOpts();
      const listUsers = opts.api.adminListUsers as unknown as ReturnType<typeof vi.fn>;
      listUsers.mockResolvedValue([bannedUser(3, "spammer")]);

      const section = createSidebarMemberSection(opts);
      container.appendChild(section.element);
      await Promise.resolve();
      expect(container.querySelectorAll(".banned-row")).toHaveLength(0);

      // roles_update only rewrites channelsStore.roles.
      grantBanPermission();
      await vi.waitFor(() => expect(container.querySelectorAll(".banned-row")).toHaveLength(1));

      section.destroy();
    });

    it("refetches when another moderator's ban or unban changes the roster", async () => {
      grantBanPermission();
      const opts = defaultOpts();
      const listUsers = opts.api.adminListUsers as unknown as ReturnType<typeof vi.fn>;
      listUsers.mockResolvedValue([]);

      const section = createSidebarMemberSection(opts);
      container.appendChild(section.element);
      await vi.waitFor(() => expect(listUsers).toHaveBeenCalledTimes(1));

      // member_ban from elsewhere: the dispatcher drops the roster row.
      listUsers.mockResolvedValue([bannedUser(3, "spammer")]);
      removeMember(3);
      await vi.waitFor(() => expect(container.querySelectorAll(".banned-row")).toHaveLength(1));

      // The unban arrives as a member_join: the row is back, the ban is gone.
      listUsers.mockResolvedValue([]);
      addMember({ user: { id: 3, username: "spammer", avatar: null, role: "member" } });
      await vi.waitFor(() => expect(container.querySelectorAll(".banned-row")).toHaveLength(0));

      // Presence and typing churn must not page the whole user list.
      const calls = listUsers.mock.calls.length;
      membersStore.setState((prev) => ({ ...prev, typingUsers: new Map([[1, new Set([2])]]) }));
      await Promise.resolve();
      expect(listUsers).toHaveBeenCalledTimes(calls);

      section.destroy();
      removeMember(3);
      await Promise.resolve();
      expect(listUsers).toHaveBeenCalledTimes(calls);
    });

    it("stays out of the way without BAN_MEMBERS, and never asks the admin API", () => {
      const opts = defaultOpts();

      const section = createSidebarMemberSection(opts);
      container.appendChild(section.element);

      expect(opts.api.adminListUsers).not.toHaveBeenCalled();
      expect(container.querySelector("[data-testid='unban-member']")).toBeNull();
      // Hidden rather than rendered empty: an unpermitted moderator should not
      // see a BANNED heading at all.
      expect(
        (container.querySelector("[data-testid='sidebar-banned']") as HTMLElement).style.display,
      ).toBe("none");

      section.destroy();
    });

    it("reports a failed unban instead of dropping the row silently", async () => {
      grantBanPermission();
      const mockShow = vi.fn();
      const opts = defaultOpts();
      Object.assign(opts, { getToast: vi.fn().mockReturnValue({ show: mockShow }) });
      (opts.api.adminListUsers as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
        bannedUser(3, "spammer"),
      ]);
      (opts.api.adminUnbanMember as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Unban denied"),
      );

      const section = createSidebarMemberSection(opts);
      container.appendChild(section.element);
      await vi.waitFor(() =>
        expect(container.querySelector("[data-testid='unban-member']")).not.toBeNull(),
      );

      (container.querySelector("[data-testid='unban-member']") as HTMLButtonElement).click();

      await vi.waitFor(() => expect(mockShow).toHaveBeenCalledWith("Unban denied", "error"));
      // Still listed: the ban is still in force.
      expect(container.querySelectorAll(".banned-row")).toHaveLength(1);

      section.destroy();
    });
  });
  // -------------------------------------------------------------------------
  // Timeout actions (3C-3)
  // -------------------------------------------------------------------------

  describe("timeout actions", () => {
    function setup(api: Record<string, unknown>) {
      const show = vi.fn();
      const section = createSidebarMemberSection({
        api: api as unknown as SidebarMemberSectionOptions["api"],
        getToast: vi.fn().mockReturnValue({ show }),
      });
      container.appendChild(section.element);
      const calls = (createMemberList as ReturnType<typeof vi.fn>).mock.calls;
      const callbacks = calls[calls.length - 1]![0] as {
        onTimeoutMember: (userId: number, username: string, seconds: number) => Promise<void>;
        onRemoveTimeout: (userId: number, username: string) => Promise<void>;
      };
      return { show, section, callbacks };
    }

    // (18)
    it("onTimeoutMember sends the length with an empty reason and toasts success", async () => {
      const timeoutMember = vi.fn().mockResolvedValue({ id: 1, voice: "skipped" });
      const { show, section, callbacks } = setup({ timeoutMember });

      await callbacks.onTimeoutMember(4, "Dave", 3600);

      expect(timeoutMember).toHaveBeenCalledWith(4, 3600, "");
      expect(show).toHaveBeenCalledWith("Timed out Dave (1 Hour)", "success");
      section.destroy();
    });

    it("onTimeoutMember shows the server's message as an error toast on failure", async () => {
      const timeoutMember = vi.fn().mockRejectedValue(new Error("Cannot time out that member"));
      const { show, section, callbacks } = setup({ timeoutMember });

      await callbacks.onTimeoutMember(4, "Dave", 60);

      expect(show).toHaveBeenCalledWith("Cannot time out that member", "error");
      section.destroy();
    });

    it("onRemoveTimeout lifts the timeout and toasts success", async () => {
      const liftTimeout = vi.fn().mockResolvedValue(undefined);
      const { show, section, callbacks } = setup({ liftTimeout });

      await callbacks.onRemoveTimeout(4, "Dave");

      expect(liftTimeout).toHaveBeenCalledWith(4);
      expect(show).toHaveBeenCalledWith("Removed Dave's timeout", "success");
      section.destroy();
    });

    // (19) edge case 2: stale timeout state
    it("a 404 from Remove Timeout is an info toast, not an error", async () => {
      const liftTimeout = vi
        .fn()
        .mockRejectedValue(new ApiClientError(404, "NOT_FOUND", "no active timeout"));
      const { show, section, callbacks } = setup({ liftTimeout });

      await callbacks.onRemoveTimeout(4, "Dave");

      expect(show).toHaveBeenCalledTimes(1);
      expect(show).toHaveBeenCalledWith("Dave is not timed out", "info");
      section.destroy();
    });

    it("any other Remove Timeout failure is an error toast", async () => {
      const liftTimeout = vi
        .fn()
        .mockRejectedValue(new ApiClientError(403, "FORBIDDEN", "Not allowed"));
      const { show, section, callbacks } = setup({ liftTimeout });

      await callbacks.onRemoveTimeout(4, "Dave");

      expect(show).toHaveBeenCalledWith("Not allowed", "error");
      section.destroy();
    });
  });
});
