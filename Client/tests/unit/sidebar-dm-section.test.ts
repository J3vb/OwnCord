import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createSidebarDmSection,
  type SidebarDmSectionOptions,
} from "../../src/pages/main-page/SidebarDmSection";
import {
  dmStore,
  addDmChannel,
  updateDmParticipant,
  updateDmLastMessagePreview,
} from "../../src/stores/dm.store";
import { uiStore } from "../../src/stores/ui.store";
import {
  dmRecipient,
  makeDm,
  openContextMenuOn,
  resetDmAndUiState,
  seedUserDms,
} from "../helpers/dmHarness";
import { muteChannel, invalidateMuteCache } from "../../src/lib/prefs/channelMutes";
import { resetVoiceStore, setVoiceStates } from "../../src/stores/voice.store";
import { setConnectionStatus } from "../../src/stores/ui.store";

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

  function mount(overrides: Partial<SidebarDmSectionOptions> = {}) {
    const section = createSidebarDmSection(defaultOpts(overrides));
    container.appendChild(section.element);
    return section;
  }

  beforeEach(() => {
    resetDmAndUiState();
    localStorage.clear();
    invalidateMuteCache();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  describe("rendering", () => {
    it("renders the DM section root element", () => {
      const section = mount();

      expect(container.querySelector(".sidebar-dm-section")).not.toBeNull();
      section.destroy();
    });

    it("renders the DM header with label and arrow", () => {
      const section = mount();

      const header = container.querySelector(".category");
      expect(header).not.toBeNull();

      const label = container.querySelector(".category-name");
      expect(label!.textContent).toBe("DIRECT MESSAGES");

      const arrow = container.querySelector(".category-arrow");
      expect(arrow!.textContent).toBe("\u25BC");

      section.destroy();
    });

    it("renders the + (add DM) button", () => {
      const section = mount();

      const addBtn = container.querySelector(".category-add-btn");
      expect(addBtn).not.toBeNull();
      expect(addBtn!.textContent).toBe("+");
      expect(addBtn!.getAttribute("title")).toBe("New DM");

      section.destroy();
    });

    it("renders the unread badge element (hidden when 0)", () => {
      const section = mount();

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
      addDmChannel(
        makeDm({
          channelId: 100,
          recipient: dmRecipient(10, "Alice"),
        }),
      );
      addDmChannel(
        makeDm({
          channelId: 101,
          recipient: dmRecipient(11, "Bob", "idle"),
        }),
      );

      const section = mount();

      const entries = container.querySelectorAll("[data-testid='dm-entry']");
      expect(entries.length).toBe(2);

      section.destroy();
    });

    // B9-21: the preview list is keyed — a changed row is rebuilt but the
    // list element and its keyboard wiring survive, and unrelated rows keep
    // their node identity.
    it("keeps unrelated rows' nodes across a presence-only change", () => {
      addDmChannel(
        makeDm({
          channelId: 100,
          recipient: dmRecipient(10, "Alice"),
        }),
      );
      addDmChannel(
        makeDm({
          channelId: 101,
          recipient: dmRecipient(11, "Bob"),
        }),
      );
      const section = mount();

      const rowOf = (id: number): HTMLElement =>
        container.querySelector<HTMLElement>(`[data-testid='dm-entry'][data-channel-id='${id}']`)!;
      const changed = rowOf(100);
      const untouched = rowOf(101);

      updateDmParticipant(10, { status: "offline" });
      dmStore.flush();

      // The changed row is rebuilt; the unrelated row keeps its node.
      expect(rowOf(100)).not.toBe(changed);
      expect(rowOf(101)).toBe(untouched);
      expect(container.querySelectorAll("[data-testid='dm-entry'][tabindex='0']").length).toBe(1);

      section.destroy();
    });

    it("exposes one Tab stop and arrow-navigates the preview list", () => {
      addDmChannel(makeDm({ channelId: 100 }));
      addDmChannel(
        makeDm({
          channelId: 101,
          recipient: dmRecipient(11, "Bob"),
        }),
      );
      const section = mount();

      const entries = container.querySelectorAll("[data-testid='dm-entry']");
      expect(container.querySelectorAll("[data-testid='dm-entry'][tabindex='0']").length).toBe(1);

      const first = entries[0] as HTMLElement;
      first.focus();
      first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      expect(document.activeElement).toBe(entries[1]);

      section.destroy();
    });

    it("displays up to 3 DM entries (truncates if more)", () => {
      seedUserDms(5);

      const section = mount();

      const entries = container.querySelectorAll("[data-testid='dm-entry']");
      expect(entries.length).toBe(3);

      section.destroy();
    });

    it("displays the recipient username in each entry", () => {
      addDmChannel(
        makeDm({
          channelId: 100,
          recipient: dmRecipient(10, "Alice"),
        }),
      );

      const section = mount();

      const name = container.querySelector(".ch-name");
      expect(name!.textContent).toBe("Alice");

      section.destroy();
    });

    it("shows the last-message preview and a time, matching the full DM sidebar", () => {
      addDmChannel(
        makeDm({
          channelId: 100,
          lastMessage: "see you at 6",
          lastMessageAt: "2020-06-15T12:00:00Z",
        }),
      );

      const section = mount();

      const entry = container.querySelector("[data-testid='dm-entry']")!;
      expect(entry.querySelector(".dm-preview")?.textContent).toBe("see you at 6");
      expect(entry.querySelector(".dm-preview-time")?.textContent).toBe("Jun 15, 2020");

      section.destroy();
    });

    it("flattens markdown and hides an unclicked spoiler in the preview", () => {
      addDmChannel(
        makeDm({
          channelId: 100,
          lastMessageId: 5,
          lastMessage: "**hi** ||the butler did it||",
          lastMessageAt: "2020-06-15T12:00:00Z",
        }),
      );

      const section = mount();

      expect(container.querySelector(".dm-preview")?.textContent).toBe("hi Spoiler");

      section.destroy();
    });

    it("keys 'No messages yet' on a never-messaged DM, not on empty content", () => {
      addDmChannel(makeDm({ channelId: 100 }));
      addDmChannel(
        makeDm({
          channelId: 101,
          lastMessageId: 5,
          lastMessage: "",
          lastMessageAt: "2020-06-15T12:00:00Z",
        }),
      );

      const section = mount();

      const preview = (id: number) =>
        container.querySelector(`[data-channel-id='${id}'] .dm-preview`)?.textContent;
      expect(preview(100)).toBe("No messages yet");
      // An attachment-only last message has no words, but the DM was messaged.
      expect(preview(101)).toBe("");

      section.destroy();
    });

    it("rolls a row's time from a clock time to a date at midnight", () => {
      vi.useFakeTimers({ now: new Date(2026, 8, 29, 23, 58) });
      addDmChannel(
        makeDm({
          channelId: 100,
          lastMessageId: 5,
          lastMessage: "late",
          lastMessageAt: new Date(2026, 8, 29, 23, 50).toISOString(),
        }),
      );

      const section = mount();
      const time = () => container.querySelector(".dm-preview-time")?.textContent;
      expect(time()).toBe("11:50 PM");

      vi.advanceTimersByTime(3 * 60 * 1000);

      expect(time()).toBe("Sep 29");

      section.destroy();
    });

    it("rebuilds a preview row when only its last message changes", () => {
      addDmChannel(makeDm({ channelId: 100, lastMessage: "old" }));

      const section = mount();
      const entry = container.querySelector("[data-testid='dm-entry']") as HTMLElement;

      updateDmLastMessagePreview(100, 900, "brand new", "2020-06-15T12:00:00Z");
      dmStore.flush();

      expect(container.querySelector("[data-testid='dm-entry']")).not.toBe(entry);
      expect(container.querySelector(".dm-preview")?.textContent).toBe("brand new");

      section.destroy();
    });

    it("shows unread badge on DM entries with unread messages", () => {
      addDmChannel(makeDm({ channelId: 100, unreadCount: 5 }));

      const section = mount();

      const badge = container.querySelector<HTMLElement>(".dm-unread-badge");
      expect(badge).not.toBeNull();
      expect(badge!.textContent).toBe("5");
      // White text needs --danger-fill (4.5:1), not --red (3.77:1).
      expect(badge!.style.background).toBe("var(--danger-fill)");
      expect(badge!.style.color).toBe("var(--on-fill)");

      section.destroy();
    });

    it("caps the unread badge at 99+", () => {
      addDmChannel(makeDm({ channelId: 100, unreadCount: 137 }));

      const section = mount();

      expect(container.querySelector(".dm-unread-badge")?.textContent).toBe("99+");
      // The mention badge counts mentions, not unreads, and stays uncapped.
      expect(container.querySelector(".dm-mention-badge")).toBeNull();

      section.destroy();
    });

    it("shows 99 without the plus at the cap, and 100 as 99+", () => {
      addDmChannel(makeDm({ channelId: 100, unreadCount: 99 }));
      addDmChannel(
        makeDm({
          channelId: 101,
          recipient: dmRecipient(11, "Bob"),
          unreadCount: 100,
        }),
      );

      const section = mount();

      const rows = Array.from(container.querySelectorAll("[data-testid='dm-entry']"));
      const badgeFor = (channelId: number): string | undefined =>
        rows
          .find((r) => r.getAttribute("data-channel-id") === String(channelId))
          ?.querySelector(".dm-unread-badge")?.textContent ?? undefined;
      expect(badgeFor(100)).toBe("99");
      expect(badgeFor(101)).toBe("99+");

      section.destroy();
    });

    it("does not show unread badge when unreadCount is 0", () => {
      addDmChannel(makeDm({ channelId: 100, unreadCount: 0 }));

      const section = mount();

      const badge = container.querySelector(".dm-unread-badge");
      expect(badge).toBeNull();

      section.destroy();
    });

    it("passes onSelectDm the current DM, not the one the reused row was built from", () => {
      addDmChannel(makeDm({ channelId: 100 }));

      const onSelectDm = vi.fn();
      const section = mount({ onSelectDm });
      const entry = container.querySelector("[data-testid='dm-entry']") as HTMLElement;

      // The recipient's avatar is not drawn in the row, so the node is reused.
      addDmChannel(
        makeDm({
          channelId: 100,
          recipient: { id: 10, username: "Alice", avatar: "/new.png", status: "online" },
        }),
      );
      dmStore.flush();
      expect(container.querySelector("[data-testid='dm-entry']")).toBe(entry);
      entry.click();

      expect(onSelectDm.mock.calls[0]![0].recipient.avatar).toBe("/new.png");

      section.destroy();
    });

    it("calls onSelectDm when a DM entry is clicked", () => {
      const dm = makeDm({ channelId: 100 });
      addDmChannel(dm);

      const onSelectDm = vi.fn();
      const section = mount({ onSelectDm });

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
    it.each([
      ["shows green dot for online status", "online", "var(--green)"],
      ["shows yellow dot for idle status", "idle", "var(--yellow)"],
      ["shows red dot for dnd status", "dnd", "var(--red)"],
      ["shows text-micro dot for offline status", "offline", "var(--text-micro)"],
    ] as const)("%s", (_name, status, color) => {
      addDmChannel(makeDm({ recipient: dmRecipient(10, "Alice", status) }));
      const section = mount();

      const entry = container.querySelector("[data-testid='dm-entry']");
      const dot = entry!.querySelector("span") as HTMLElement;
      expect(dot.style.background).toBe(color);

      section.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // Total unread badge
  // -------------------------------------------------------------------------

  describe("total unread badge", () => {
    it("shows total unread count in header badge when there are unreads", () => {
      addDmChannel(makeDm({ channelId: 100, unreadCount: 3 }));
      addDmChannel(
        makeDm({
          channelId: 101,
          recipient: dmRecipient(11, "Bob"),
          unreadCount: 2,
        }),
      );

      const section = mount();

      const badge = container.querySelector(".dm-header-unread-badge") as HTMLElement;
      expect(badge.textContent).toBe("5");
      expect(badge.style.display).not.toBe("none");

      section.destroy();
    });

    it("hides total unread badge when all channels have 0 unreads", () => {
      addDmChannel(makeDm({ channelId: 100, unreadCount: 0 }));

      const section = mount();

      const badge = container.querySelector(".dm-header-unread-badge") as HTMLElement;
      expect(badge.style.display).toBe("none");

      section.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // Mention badge (OC-0189)
  // -------------------------------------------------------------------------

  describe("mention badge", () => {
    it("shows a mention badge instead of the unread badge when mentionCount > 0", () => {
      addDmChannel(makeDm({ channelId: 100, unreadCount: 5, mentionCount: 2 }));

      const section = mount();

      const mentionBadge = container.querySelector<HTMLElement>(".dm-mention-badge");
      expect(mentionBadge).not.toBeNull();
      expect(mentionBadge!.textContent).toBe("2");
      expect(mentionBadge!.style.background).toBe("var(--danger-fill)");
      expect(mentionBadge!.style.color).toBe("var(--on-fill)");

      // The plain unread badge must not also render alongside it.
      const unreadBadge = container.querySelector(".dm-unread-badge");
      expect(unreadBadge).toBeNull();

      section.destroy();
    });

    it("still shows the mention badge on a muted DM (a mute must never hide a mention)", () => {
      addDmChannel(makeDm({ channelId: 100, unreadCount: 5, mentionCount: 2 }));
      muteChannel(100);

      const section = mount();

      const mentionBadge = container.querySelector(".dm-mention-badge");
      expect(mentionBadge).not.toBeNull();
      expect(mentionBadge!.textContent).toBe("2");

      section.destroy();
    });

    it("counts a muted DM's mentions (not its raw unreads) toward the header badge", () => {
      // Muted DM with a mention: the header must still surface the mention.
      addDmChannel(makeDm({ channelId: 100, unreadCount: 5, mentionCount: 2 }));
      muteChannel(100);
      // Muted DM with no mention: contributes nothing, same as before.
      addDmChannel(
        makeDm({
          channelId: 101,
          recipient: dmRecipient(11, "Bob"),
          unreadCount: 3,
          mentionCount: 0,
        }),
      );
      muteChannel(101);

      const section = mount();

      const badge = container.querySelector(".dm-header-unread-badge") as HTMLElement;
      expect(badge.textContent).toBe("2");
      expect(badge.style.display).not.toBe("none");

      section.destroy();
    });
  });

  // -------------------------------------------------------------------------
  // View All button
  // -------------------------------------------------------------------------

  describe("View All button", () => {
    it("is hidden when 3 or fewer DMs exist", () => {
      addDmChannel(makeDm({ channelId: 100 }));
      addDmChannel(
        makeDm({
          channelId: 101,
          recipient: dmRecipient(11, "Bob"),
        }),
      );

      const section = mount();

      const viewAll = container.querySelector(".sidebar-dm-view-all") as HTMLElement;
      expect(viewAll.style.display).toBe("none");

      section.destroy();
    });

    it("is visible when more than 3 DMs exist and shows count", () => {
      seedUserDms(5);

      const section = mount();

      const viewAll = container.querySelector(".sidebar-dm-view-all") as HTMLElement;
      expect(viewAll.style.display).not.toBe("none");
      expect(viewAll.textContent).toContain("5");

      section.destroy();
    });

    it("switches sidebar mode to dms when clicked", () => {
      seedUserDms(5);

      const section = mount();

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

      const section = mount();

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

      const section = mount();

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

    it("exposes the collapse control as a button whose expanded state follows the list", () => {
      addDmChannel(makeDm({ channelId: 100 }));

      const section = mount();

      const arrow = container.querySelector<HTMLButtonElement>("button.category-arrow")!;
      const dmList = container.querySelector(".sidebar-dm-list") as HTMLElement;
      expect(arrow.getAttribute("aria-expanded")).toBe("true");
      expect(arrow.getAttribute("aria-labelledby")).toBe("sidebar-dm-heading");

      // A button's keyboard activation (Enter/Space) is its click.
      arrow.click();
      expect(arrow.getAttribute("aria-expanded")).toBe("false");
      expect(dmList.style.display).toBe("none");

      arrow.click();
      expect(arrow.getAttribute("aria-expanded")).toBe("true");
      expect(dmList.style.display).not.toBe("none");

      section.destroy();
    });

    it("hides View All button when collapsed even if more than 3 DMs", () => {
      seedUserDms(5);

      const section = mount();

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
      const section = mount({ onNewDm });

      const addBtn = container.querySelector(".category-add-btn") as HTMLElement;
      addBtn.click();

      expect(onNewDm).toHaveBeenCalledOnce();

      section.destroy();
    });

    it("stops click propagation so header click handler is not triggered", () => {
      const onNewDm = vi.fn();
      const section = mount({ onNewDm });

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
      const section = mount();

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
      const section = mount();

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
      const section = mount();

      section.destroy();

      // After destroy, adding DMs should not trigger re-renders
      addDmChannel(makeDm({ channelId: 100 }));
      dmStore.flush();

      // The section element is still in the DOM (we just unsubscribed)
      // but no new entries should have been rendered
      expect(container.querySelectorAll("[data-testid='dm-entry']").length).toBe(0);
    });
  });
  describe("in-call glyph and row menu", () => {
    afterEach(() => {
      resetVoiceStore();
      document.querySelectorAll(".context-menu").forEach((m) => m.remove());
    });

    const joinCall = (channelId: number, userId: number): void =>
      setVoiceStates([{ channel_id: channelId, user_id: userId, muted: false, deafened: false }]);

    it("shows the phone glyph while someone is in that DM's room, and drops it after", async () => {
      addDmChannel(makeDm({ channelId: 100 }));
      addDmChannel(
        makeDm({
          channelId: 101,
          recipient: dmRecipient(11, "Bob"),
        }),
      );
      const section = mount();
      expect(container.querySelector("[data-testid='dm-in-call-100']")).toBeNull();

      joinCall(100, 10);
      await vi.waitFor(() =>
        expect(container.querySelector("[data-testid='dm-in-call-100']")).not.toBeNull(),
      );
      const glyph = container.querySelector("[data-testid='dm-in-call-100']");
      expect(glyph?.getAttribute("aria-label")).toBe("Call in progress");
      expect(container.querySelector("[data-testid='dm-in-call-101']")).toBeNull();

      resetVoiceStore();
      await vi.waitFor(() =>
        expect(container.querySelector("[data-testid='dm-in-call-100']")).toBeNull(),
      );
      section.destroy();
    });

    it("opens the shared DM menu on right-click and runs its actions", () => {
      setConnectionStatus("connected");
      addDmChannel(makeDm({ channelId: 100, unreadCount: 2 }));
      const menu = {
        onMarkRead: vi.fn(),
        onOpenProfile: vi.fn(),
        onCall: vi.fn(),
        onToggleBlock: vi.fn(),
        onToggleMute: vi.fn(),
        onCloseDm: vi.fn(),
      };
      const section = mount({ menu });

      openContextMenuOn(container.querySelector("[data-testid='dm-entry']"));
      const labels = [...document.querySelectorAll(".dm-context-menu .context-menu-item")].map(
        (el) => el.textContent,
      );
      expect(labels).toEqual([
        "Mark As Read",
        "Profile",
        "Call",
        "Mute Conversation",
        "Block",
        "Close DM",
      ]);
      document.querySelector<HTMLElement>("[data-testid='dm-profile-100']")?.click();
      expect(menu.onOpenProfile).toHaveBeenCalledWith(100);
      section.destroy();
    });

    it("leave-group from the compact row menu confirms first, and the confirm closes when the row leaves the list", () => {
      setConnectionStatus("connected");
      addDmChannel(
        makeDm({
          channelId: 100,
          isGroup: true,
          name: "Crew",
          participants: [dmRecipient(10, "Alice")],
        }),
      );
      const onCloseDm = vi.fn();
      const section = mount({ menu: { onCloseDm } });

      openContextMenuOn(container.querySelector("[data-testid='dm-entry']"));
      document.querySelector<HTMLElement>("[data-testid='dm-close-100']")?.click();
      expect(onCloseDm).not.toHaveBeenCalled();
      expect(document.querySelector("[data-testid='dm-leave-modal']")).not.toBeNull();

      dmStore.setState(() => ({ channels: [] }));
      dmStore.flush();
      expect(document.querySelector("[data-testid='dm-leave-modal']")).toBeNull();
      section.destroy();
    });

    it("has no menu when none is wired", () => {
      addDmChannel(makeDm({ channelId: 100 }));
      const section = mount();
      openContextMenuOn(container.querySelector("[data-testid='dm-entry']"));
      expect(document.querySelector(".dm-context-menu")).toBeNull();
      section.destroy();
    });
  });
});
