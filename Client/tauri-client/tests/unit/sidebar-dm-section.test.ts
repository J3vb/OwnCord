import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createSidebarDmSection,
  type SidebarDmSectionOptions,
} from "../../src/pages/main-page/SidebarDmSection";
import { dmStore, addDmChannel } from "../../src/stores/dm.store";
import { uiStore } from "../../src/stores/ui.store";
import type { DmChannel } from "../../src/stores/dm.store";

// ---------------------------------------------------------------------------
// Store reset
// ---------------------------------------------------------------------------

function resetStores(): void {
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

function defaultOpts(overrides: Partial<SidebarDmSectionOptions> = {}): SidebarDmSectionOptions {
  return {
    onSelectDm: vi.fn(),
    onNewDm: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SidebarDmSection", () => {
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
    it("renders the DM section root element", () => {
      const section = createSidebarDmSection(defaultOpts());
      container.appendChild(section.element);

      expect(container.querySelector(".sidebar-dm-section")).not.toBeNull();
      section.destroy();
    });

    it("renders the DM header with label and arrow", () => {
      const section = createSidebarDmSection(defaultOpts());
      container.appendChild(section.element);

      const header = container.querySelector(".category");
      expect(header).not.toBeNull();

      const label = container.querySelector(".category-name");
      expect(label!.textContent).toBe("DIRECT MESSAGES");

      const arrow = container.querySelector(".category-arrow");
      expect(arrow!.textContent).toBe("\u25BC");

      section.destroy();
    });

    it("renders the + (add DM) button", () => {
      const section = createSidebarDmSection(defaultOpts());
      container.appendChild(section.element);

      const addBtn = container.querySelector(".category-add-btn");
      expect(addBtn).not.toBeNull();
      expect(addBtn!.textContent).toBe("+");
      expect(addBtn!.getAttribute("title")).toBe("New DM");

      section.destroy();
    });

    it("renders the unread badge element (hidden when 0)", () => {
      const section = createSidebarDmSection(defaultOpts());
      container.appendChild(section.element);

      const badge = container.querySelector(".dm-header-unread-badge") as HTMLElement;
      expect(badge).not.toBeNull();
      expect(badge.style.display).toBe("none");

      section.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // DM list items
  // -------------------------------------------------------------------------

  describe("DM list items", () => {
    it("renders DM entries from store", () => {
      addDmChannel(makeDm({ channelId: 100, recipient: { id: 10, username: "Alice", avatar: "", status: "online" } }));
      addDmChannel(makeDm({ channelId: 101, recipient: { id: 11, username: "Bob", avatar: "", status: "idle" } }));

      const section = createSidebarDmSection(defaultOpts());
      container.appendChild(section.element);

      const entries = container.querySelectorAll("[data-testid='dm-entry']");
      expect(entries.length).toBe(2);

      section.destroy();
    });

    it("displays up to 3 DM entries (truncates if more)", () => {
      for (let i = 0; i < 5; i++) {
        addDmChannel(makeDm({
          channelId: 100 + i,
          recipient: { id: 10 + i, username: `User${i}`, avatar: "", status: "online" },
        }));
      }

      const section = createSidebarDmSection(defaultOpts());
      container.appendChild(section.element);

      const entries = container.querySelectorAll("[data-testid='dm-entry']");
      expect(entries.length).toBe(3);

      section.destroy();
    });

    it("displays the recipient username in each entry", () => {
      addDmChannel(makeDm({ channelId: 100, recipient: { id: 10, username: "Alice", avatar: "", status: "online" } }));

      const section = createSidebarDmSection(defaultOpts());
      container.appendChild(section.element);

      const name = container.querySelector(".ch-name");
      expect(name!.textContent).toBe("Alice");

      section.destroy();
    });

    it("shows unread badge on DM entries with unread messages", () => {
      addDmChannel(makeDm({ channelId: 100, unreadCount: 5 }));

      const section = createSidebarDmSection(defaultOpts());
      container.appendChild(section.element);

      const badge = container.querySelector(".dm-unread-badge");
      expect(badge).not.toBeNull();
      expect(badge!.textContent).toBe("5");

      section.destroy();
    });

    it("does not show unread badge when unreadCount is 0", () => {
      addDmChannel(makeDm({ channelId: 100, unreadCount: 0 }));

      const section = createSidebarDmSection(defaultOpts());
      container.appendChild(section.element);

      const badge = container.querySelector(".dm-unread-badge");
      expect(badge).toBeNull();

      section.destroy();
    });

    it("calls onSelectDm when a DM entry is clicked", () => {
      const dm = makeDm({ channelId: 100 });
      addDmChannel(dm);

      const onSelectDm = vi.fn();
      const section = createSidebarDmSection(defaultOpts({ onSelectDm }));
      container.appendChild(section.element);

      const entry = container.querySelector("[data-testid='dm-entry']") as HTMLElement;
      entry.click();

      expect(onSelectDm).toHaveBeenCalledOnce();
      // Called with the DM channel object from the store
      expect(onSelectDm.mock.calls[0]![0].channelId).toBe(100);

      section.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // Status colors
  // -------------------------------------------------------------------------

  describe("status dot colors", () => {
    it("shows green dot for online status", () => {
      addDmChannel(makeDm({ recipient: { id: 10, username: "Alice", avatar: "", status: "online" } }));
      const section = createSidebarDmSection(defaultOpts());
      container.appendChild(section.element);

      const entry = container.querySelector("[data-testid='dm-entry']");
      const dot = entry!.querySelector("span") as HTMLElement;
      expect(dot.style.background).toBe("var(--green)");

      section.destroy();
    });

    it("shows yellow dot for idle status", () => {
      addDmChannel(makeDm({ recipient: { id: 10, username: "Alice", avatar: "", status: "idle" } }));
      const section = createSidebarDmSection(defaultOpts());
      container.appendChild(section.element);

      const entry = container.querySelector("[data-testid='dm-entry']");
      const dot = entry!.querySelector("span") as HTMLElement;
      expect(dot.style.background).toBe("var(--yellow)");

      section.destroy();
    });

    it("shows red dot for dnd status", () => {
      addDmChannel(makeDm({ recipient: { id: 10, username: "Alice", avatar: "", status: "dnd" } }));
      const section = createSidebarDmSection(defaultOpts());
      container.appendChild(section.element);

      const entry = container.querySelector("[data-testid='dm-entry']");
      const dot = entry!.querySelector("span") as HTMLElement;
      expect(dot.style.background).toBe("var(--red)");

      section.destroy();
    });

    it("shows text-micro dot for offline status", () => {
      addDmChannel(makeDm({ recipient: { id: 10, username: "Alice", avatar: "", status: "offline" } }));
      const section = createSidebarDmSection(defaultOpts());
      container.appendChild(section.element);

      const entry = container.querySelector("[data-testid='dm-entry']");
      const dot = entry!.querySelector("span") as HTMLElement;
      expect(dot.style.background).toBe("var(--text-micro)");

      section.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // Total unread badge
  // -------------------------------------------------------------------------

  describe("total unread badge", () => {
    it("shows total unread count in header badge when there are unreads", () => {
      addDmChannel(makeDm({ channelId: 100, unreadCount: 3 }));
      addDmChannel(makeDm({ channelId: 101, recipient: { id: 11, username: "Bob", avatar: "", status: "online" }, unreadCount: 2 }));

      const section = createSidebarDmSection(defaultOpts());
      container.appendChild(section.element);

      const badge = container.querySelector(".dm-header-unread-badge") as HTMLElement;
      expect(badge.textContent).toBe("5");
      expect(badge.style.display).not.toBe("none");

      section.destroy();
    });

    it("hides total unread badge when all channels have 0 unreads", () => {
      addDmChannel(makeDm({ channelId: 100, unreadCount: 0 }));

      const section = createSidebarDmSection(defaultOpts());
      container.appendChild(section.element);

      const badge = container.querySelector(".dm-header-unread-badge") as HTMLElement;
      expect(badge.style.display).toBe("none");

      section.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // View All button
  // -------------------------------------------------------------------------

  describe("View All button", () => {
    it("is hidden when 3 or fewer DMs exist", () => {
      addDmChannel(makeDm({ channelId: 100 }));
      addDmChannel(makeDm({ channelId: 101, recipient: { id: 11, username: "Bob", avatar: "", status: "online" } }));

      const section = createSidebarDmSection(defaultOpts());
      container.appendChild(section.element);

      const viewAll = container.querySelector(".sidebar-dm-view-all") as HTMLElement;
      expect(viewAll.style.display).toBe("none");

      section.destroy();
    });

    it("is visible when more than 3 DMs exist and shows count", () => {
      for (let i = 0; i < 5; i++) {
        addDmChannel(makeDm({
          channelId: 100 + i,
          recipient: { id: 10 + i, username: `User${i}`, avatar: "", status: "online" },
        }));
      }

      const section = createSidebarDmSection(defaultOpts());
      container.appendChild(section.element);

      const viewAll = container.querySelector(".sidebar-dm-view-all") as HTMLElement;
      expect(viewAll.style.display).not.toBe("none");
      expect(viewAll.textContent).toContain("5");

      section.destroy();
    });

    it("switches sidebar mode to dms when clicked", () => {
      for (let i = 0; i < 5; i++) {
        addDmChannel(makeDm({
          channelId: 100 + i,
          recipient: { id: 10 + i, username: `User${i}`, avatar: "", status: "online" },
        }));
      }

      const section = createSidebarDmSection(defaultOpts());
      container.appendChild(section.element);

      const viewAll = container.querySelector(".sidebar-dm-view-all") as HTMLElement;
      viewAll.click();

      expect(uiStore.getState().sidebarMode).toBe("dms");

      section.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // Collapse toggle
  // -------------------------------------------------------------------------

  describe("collapse toggle", () => {
    it("collapses the DM list when header is clicked", () => {
      addDmChannel(makeDm({ channelId: 100 }));

      const section = createSidebarDmSection(defaultOpts());
      container.appendChild(section.element);

      const header = container.querySelector(".category") as HTMLElement;
      header.click();

      // Arrow should change to right-pointing
      const arrow = container.querySelector(".category-arrow");
      expect(arrow!.textContent).toBe("\u25B6");

      // DM list should be hidden
      const dmList = container.querySelector(".sidebar-dm-list") as HTMLElement;
      expect(dmList.style.display).toBe("none");

      // Header should have collapsed class
      expect(header.classList.contains("collapsed")).toBe(true);

      section.destroy();
    });

    it("expands the DM list when header is clicked again", () => {
      addDmChannel(makeDm({ channelId: 100 }));

      const section = createSidebarDmSection(defaultOpts());
      container.appendChild(section.element);

      const header = container.querySelector(".category") as HTMLElement;

      // Collapse
      header.click();
      // Expand
      header.click();

      const arrow = container.querySelector(".category-arrow");
      expect(arrow!.textContent).toBe("\u25BC");

      const dmList = container.querySelector(".sidebar-dm-list") as HTMLElement;
      expect(dmList.style.display).not.toBe("none");

      expect(header.classList.contains("collapsed")).toBe(false);

      section.destroy();
    });

    it("hides View All button when collapsed even if more than 3 DMs", () => {
      for (let i = 0; i < 5; i++) {
        addDmChannel(makeDm({
          channelId: 100 + i,
          recipient: { id: 10 + i, username: `User${i}`, avatar: "", status: "online" },
        }));
      }

      const section = createSidebarDmSection(defaultOpts());
      container.appendChild(section.element);

      const header = container.querySelector(".category") as HTMLElement;
      header.click();

      const viewAll = container.querySelector(".sidebar-dm-view-all") as HTMLElement;
      expect(viewAll.style.display).toBe("none");

      section.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // Add DM button
  // -------------------------------------------------------------------------

  describe("add DM button", () => {
    it("calls onNewDm when add button is clicked", () => {
      const onNewDm = vi.fn();
      const section = createSidebarDmSection(defaultOpts({ onNewDm }));
      container.appendChild(section.element);

      const addBtn = container.querySelector(".category-add-btn") as HTMLElement;
      addBtn.click();

      expect(onNewDm).toHaveBeenCalledOnce();

      section.destroy();
    });

    it("stops click propagation so header click handler is not triggered", () => {
      const onNewDm = vi.fn();
      const section = createSidebarDmSection(defaultOpts({ onNewDm }));
      container.appendChild(section.element);

      // The add button is inside the header. Clicking it should not collapse.
      const addBtn = container.querySelector(".category-add-btn") as HTMLElement;
      addBtn.click();

      // Arrow should remain down (not collapsed)
      const arrow = container.querySelector(".category-arrow");
      expect(arrow!.textContent).toBe("\u25BC");

      section.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // Store subscription / update
  // -------------------------------------------------------------------------

  describe("store subscription", () => {
    it("re-renders when DM store changes", () => {
      const section = createSidebarDmSection(defaultOpts());
      container.appendChild(section.element);

      // Initially no DM entries
      expect(container.querySelectorAll("[data-testid='dm-entry']").length).toBe(0);

      // Add a DM channel
      addDmChannel(makeDm({ channelId: 100 }));
      dmStore.flush();

      // Should now have 1 entry
      expect(container.querySelectorAll("[data-testid='dm-entry']").length).toBe(1);

      section.destroy();
    });

    it("update() manually triggers a re-render", () => {
      const section = createSidebarDmSection(defaultOpts());
      container.appendChild(section.element);

      // Add a DM directly to store without flushing
      dmStore.setState((prev) => ({
        channels: [...prev.channels, makeDm({ channelId: 100 })],
      }));

      // Manual update
      section.update();

      expect(container.querySelectorAll("[data-testid='dm-entry']").length).toBe(1);

      section.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  describe("cleanup", () => {
    it("destroy() unsubscribes from store", () => {
      const section = createSidebarDmSection(defaultOpts());
      container.appendChild(section.element);

      section.destroy();

      // After destroy, adding DMs should not trigger re-renders
      addDmChannel(makeDm({ channelId: 100 }));
      dmStore.flush();

      // The section element is still in the DOM (we just unsubscribed)
      // but no new entries should have been rendered
      expect(container.querySelectorAll("[data-testid='dm-entry']").length).toBe(0);
    });
  });
});
