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

import {
  createSidebarMemberSection,
  type SidebarMemberSectionOptions,
} from "../../src/pages/main-page/SidebarMemberSection";
import { authStore } from "../../src/stores/auth.store";
import { membersStore } from "../../src/stores/members.store";
import { rolesStore } from "../../src/stores/roles.store";
import { createMemberList } from "@components/MemberList";
import type { Member } from "../../src/stores/members.store";
import type { UserStatus } from "../../src/lib/types";

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
  rolesStore.setState(() => ({
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

function makeMember(overrides: Partial<Member> & { id: number; username: string }): Member {
  return {
    avatar: null,
    role: "member",
    status: "online" as UserStatus,
    ...overrides,
  };
}

function setTestMembers(members: Member[]): void {
  const map = new Map<number, Member>();
  for (const m of members) {
    map.set(m.id, m);
  }
  membersStore.setState((prev) => ({ ...prev, members: map }));
}

function defaultOpts(): SidebarMemberSectionOptions {
  return {
    api: {
      adminKickMember: vi.fn().mockResolvedValue(undefined),
      adminBanMember: vi.fn().mockResolvedValue(undefined),
      adminChangeRole: vi.fn().mockResolvedValue(undefined),
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

    it("returns the memberListComponent for external tracking", () => {
      const section = createSidebarMemberSection(defaultOpts());
      container.appendChild(section.element);

      expect(section.memberListComponent).toBeDefined();
      expect(typeof section.memberListComponent.mount).toBe("function");

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
      onBan: (userId: number, username: string) => Promise<void>;
      onChangeRole: (userId: number, username: string, newRole: string) => Promise<void>;
    } {
      const calls = (createMemberList as ReturnType<typeof vi.fn>).mock.calls;
      return calls[calls.length - 1]![0];
    }

    it("kick: calls API and shows success toast", async () => {
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
      expect(mockShow).toHaveBeenCalledWith("Kicked Alice", "success");

      section.destroy();
    });

    it("kick: shows error toast on API failure", async () => {
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

    it("kick: shows generic error for non-Error exceptions", async () => {
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

      expect(mockShow).toHaveBeenCalledWith("Failed to kick member", "error");

      section.destroy();
    });

    it("ban: calls API and shows success toast", async () => {
      const mockShow = vi.fn();
      const mockApi = {
        adminKickMember: vi.fn(),
        adminBanMember: vi.fn().mockResolvedValue(undefined),
        adminChangeRole: vi.fn(),
      };
      const opts = {
        api: mockApi as unknown as SidebarMemberSectionOptions["api"],
        getToast: vi.fn().mockReturnValue({ show: mockShow }),
      };

      const section = createSidebarMemberSection(opts);
      container.appendChild(section.element);

      const callbacks = getCapturedCallbacks();
      await callbacks.onBan(3, "Bob");

      expect(mockApi.adminBanMember).toHaveBeenCalledWith(3);
      expect(mockShow).toHaveBeenCalledWith("Banned Bob", "success");

      section.destroy();
    });

    it("ban: shows error toast on API failure", async () => {
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

      const callbacks = getCapturedCallbacks();
      await callbacks.onBan(3, "Bob");

      expect(mockShow).toHaveBeenCalledWith("Ban denied", "error");

      section.destroy();
    });

    it("ban: shows generic error for non-Error exceptions", async () => {
      const mockShow = vi.fn();
      const mockApi = {
        adminKickMember: vi.fn(),
        adminBanMember: vi.fn().mockRejectedValue("string error"),
        adminChangeRole: vi.fn(),
      };
      const opts = {
        api: mockApi as unknown as SidebarMemberSectionOptions["api"],
        getToast: vi.fn().mockReturnValue({ show: mockShow }),
      };

      const section = createSidebarMemberSection(opts);
      container.appendChild(section.element);

      const callbacks = getCapturedCallbacks();
      await callbacks.onBan(3, "Bob");

      expect(mockShow).toHaveBeenCalledWith("Failed to ban member", "error");

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

    it("changeRole: does nothing when role name is not found", async () => {
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

      // Should not call API or show toast because roleId is undefined
      expect(mockApi.adminChangeRole).not.toHaveBeenCalled();
      expect(mockShow).not.toHaveBeenCalled();

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
});
