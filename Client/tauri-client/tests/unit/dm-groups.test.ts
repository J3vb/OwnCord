import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDmSidebar } from "@components/DmSidebar";
import type { DmConversation } from "@components/DmSidebar";
import { createIncomingCallBanner } from "@components/IncomingCallBanner";
import { dmDisplayName } from "@stores/dm.store";
import type { DmChannel, DmUser } from "@stores/dm.store";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const user = (id: number, username: string, displayName = ""): DmUser => ({
  id,
  username,
  avatar: "",
  status: "online",
  displayName,
});

function makeDm(overrides: Partial<DmChannel> = {}): DmChannel {
  return {
    channelId: 1,
    recipient: user(2, "bob"),
    participants: [user(2, "bob")],
    name: "",
    isGroup: false,
    lastMessageId: null,
    lastMessage: "",
    lastMessageAt: "",
    unreadCount: 0,
    mentionCount: 0,
    ...overrides,
  };
}

const convo = (overrides: Partial<DmConversation> = {}): DmConversation => ({
  channelId: 1,
  userId: 2,
  username: "bob",
  avatar: null,
  status: "online",
  lastMessage: "",
  timestamp: "",
  unread: false,
  ...overrides,
});

// ---------------------------------------------------------------------------
// dmDisplayName
// ---------------------------------------------------------------------------

describe("dmDisplayName", () => {
  it("names a 1:1 DM by the other person", () => {
    expect(dmDisplayName(makeDm())).toBe("bob");
  });

  it("prefers a display name over the username", () => {
    expect(dmDisplayName(makeDm({ participants: [user(2, "bob", "Bobby")] }))).toBe("Bobby");
  });

  it("uses a group's name when it has one", () => {
    expect(
      dmDisplayName(
        makeDm({
          isGroup: true,
          name: "Lunch crew",
          participants: [user(2, "bob"), user(3, "cat")],
        }),
      ),
    ).toBe("Lunch crew");
  });

  it("joins the members of an unnamed group", () => {
    expect(
      dmDisplayName(makeDm({ isGroup: true, participants: [user(2, "bob"), user(3, "cat")] })),
    ).toBe("bob, cat");
  });

  // Without a cap the label grows without bound and pushes the badges out of
  // the row; three plus a count is the same shape Discord settles on.
  it("caps an unnamed group at three names plus a count", () => {
    const many = [user(2, "a"), user(3, "b"), user(4, "c"), user(5, "d"), user(6, "e")];
    expect(dmDisplayName(makeDm({ isGroup: true, participants: many }))).toBe("a, b, c and 2 more");
  });

  it("falls back to the recipient when the participant list is empty", () => {
    expect(dmDisplayName(makeDm({ participants: [] }))).toBe("bob");
  });

  // Regression (OC-0220): a group DM that has lost every other member still
  // has a live, is_group=1 channel row (LeaveGroupDM only deletes the row
  // when the LAST member leaves), but the server never populates `recipient`
  // for a channel with zero "other" participants — it stays the zero-valued
  // DMUser (username ""). Falling back to that empty username renders a
  // blank label everywhere dmDisplayName is used.
  it("never renders blank for a group that has lost every other member", () => {
    const name = dmDisplayName(
      makeDm({
        isGroup: true,
        participants: [],
        recipient: { id: 0, username: "", avatar: "", status: "" },
      }),
    );
    expect(name).not.toBe("");
  });
});

// ---------------------------------------------------------------------------
// DmSidebar — group rendering
// ---------------------------------------------------------------------------

describe("DmSidebar — group rows", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.querySelectorAll(".context-menu").forEach((el) => el.remove());
  });

  function mount(conversations: DmConversation[], opts: Record<string, unknown> = {}) {
    const sidebar = createDmSidebar({
      conversations,
      onSelectConversation: vi.fn(),
      onNewDm: vi.fn(),
      ...opts,
    });
    sidebar.mount(container);
    return sidebar;
  }

  it("draws stacked avatars for a group", () => {
    const sidebar = mount([
      convo({
        channelId: 7,
        isGroup: true,
        participants: [
          { id: 2, username: "bob", avatar: null },
          { id: 3, username: "cat", avatar: null },
        ],
      }),
    ]);

    const stack = container.querySelector('[data-testid="dm-avatar-stack-7"]');
    expect(stack).not.toBeNull();
    expect(stack!.querySelectorAll(".dm-avatar-face")).toHaveLength(2);
    // A group has no presence of its own, so no status dot is drawn.
    expect(stack!.querySelector(".dm-status")).toBeNull();

    sidebar.destroy?.();
  });

  it("shows only the first two faces for a larger group", () => {
    const sidebar = mount([
      convo({
        channelId: 7,
        isGroup: true,
        participants: [
          { id: 2, username: "a", avatar: null },
          { id: 3, username: "b", avatar: null },
          { id: 4, username: "c", avatar: null },
        ],
      }),
    ]);

    expect(
      container
        .querySelector('[data-testid="dm-avatar-stack-7"]')!
        .querySelectorAll(".dm-avatar-face"),
    ).toHaveLength(2);

    sidebar.destroy?.();
  });

  it("renders the participant count including the current user", () => {
    const sidebar = mount([
      convo({
        channelId: 7,
        isGroup: true,
        participants: [
          { id: 2, username: "bob", avatar: null },
          { id: 3, username: "cat", avatar: null },
        ],
      }),
    ]);

    expect(container.querySelector('[data-testid="dm-members-7"]')!.textContent).toBe("3");

    sidebar.destroy?.();
  });

  it("keeps a single avatar with a status dot for a 1:1 DM", () => {
    const sidebar = mount([convo({ channelId: 7 })]);
    expect(container.querySelector('[data-testid="dm-avatar-stack-7"]')).toBeNull();
    expect(container.querySelector(".dm-status")).not.toBeNull();
    expect(container.querySelector('[data-testid="dm-members-7"]')).toBeNull();
    sidebar.destroy?.();
  });

  it("selects by channel id, not by user id", () => {
    const onSelectConversation = vi.fn();
    const sidebar = mount([convo({ channelId: 77, userId: 2 })], { onSelectConversation });

    (container.querySelector(".dm-item") as HTMLElement).click();
    expect(onSelectConversation).toHaveBeenCalledWith(77);

    sidebar.destroy?.();
  });

  it("labels the close affordance as Leave for a group", () => {
    const sidebar = mount([convo({ channelId: 7, isGroup: true, participants: [] })]);
    expect(container.querySelector(".dm-close")!.getAttribute("title")).toBe("Leave group");
    sidebar.destroy?.();
  });
});

// ---------------------------------------------------------------------------
// DmSidebar — mute rendering
// ---------------------------------------------------------------------------

describe("DmSidebar — muted rows", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.querySelectorAll(".context-menu").forEach((el) => el.remove());
  });

  function mount(conversations: DmConversation[], opts: Record<string, unknown> = {}) {
    const sidebar = createDmSidebar({
      conversations,
      onSelectConversation: vi.fn(),
      onNewDm: vi.fn(),
      ...opts,
    });
    sidebar.mount(container);
    return sidebar;
  }

  it("dims the unread badge but keeps the count", () => {
    const sidebar = mount([convo({ channelId: 7, muted: true, unread: true, unreadCount: 4 })]);
    const badge = container.querySelector('[data-testid="dm-unread-7"]')!;
    expect(badge.textContent).toBe("4");
    expect(badge.classList.contains("muted")).toBe(true);
    expect(container.querySelector(".dm-item")!.classList.contains("muted")).toBe(true);
    sidebar.destroy?.();
  });

  // The load-bearing rule: a mute silences chatter, not things addressed to
  // the reader, so the mention badge is never dimmed.
  it("leaves the mention badge undimmed in a muted conversation", () => {
    const sidebar = mount([
      convo({ channelId: 7, muted: true, unread: true, unreadCount: 4, mentionCount: 2 }),
    ]);
    const badge = container.querySelector('[data-testid="dm-mentions-7"]')!;
    expect(badge.textContent).toBe("2");
    expect(badge.classList.contains("muted")).toBe(false);
    sidebar.destroy?.();
  });

  it("offers Mute in the context menu and reports the channel id", () => {
    const onToggleMute = vi.fn();
    const sidebar = mount([convo({ channelId: 7 })], { onToggleMute });

    const item = container.querySelector(".dm-item") as HTMLElement;
    item.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }));

    const entry = document.querySelector('[data-testid="dm-mute-7"]') as HTMLElement;
    expect(entry.textContent).toBe("Mute Conversation");
    entry.click();
    expect(onToggleMute).toHaveBeenCalledWith(7);

    sidebar.destroy?.();
  });

  it("says Unmute when the conversation is already muted", () => {
    const sidebar = mount([convo({ channelId: 7, muted: true })], { onToggleMute: vi.fn() });
    (container.querySelector(".dm-item") as HTMLElement).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }),
    );
    expect(document.querySelector('[data-testid="dm-mute-7"]')!.textContent).toBe(
      "Unmute Conversation",
    );
    sidebar.destroy?.();
  });

  it("offers Rename only for a group", () => {
    const sidebar = mount([convo({ channelId: 7 })], {
      onRenameGroup: vi.fn(),
      onToggleMute: vi.fn(),
    });
    (container.querySelector(".dm-item") as HTMLElement).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }),
    );
    expect(document.querySelector('[data-testid="dm-rename-7"]')).toBeNull();
    sidebar.destroy?.();
  });

  it("offers Rename and Leave Group for a group", () => {
    const onRenameGroup = vi.fn();
    const onCloseDm = vi.fn();
    const sidebar = mount([convo({ channelId: 7, isGroup: true, participants: [] })], {
      onRenameGroup,
      onCloseDm,
      onToggleMute: vi.fn(),
    });
    (container.querySelector(".dm-item") as HTMLElement).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }),
    );

    (document.querySelector('[data-testid="dm-rename-7"]') as HTMLElement).click();
    expect(onRenameGroup).toHaveBeenCalledWith(7);

    (container.querySelector(".dm-item") as HTMLElement).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }),
    );
    const leave = document.querySelector('[data-testid="dm-close-7"]') as HTMLElement;
    expect(leave.textContent).toBe("Leave Group");
    leave.click();
    expect(onCloseDm).toHaveBeenCalledWith(7);

    sidebar.destroy?.();
  });
});

// ---------------------------------------------------------------------------
// IncomingCallBanner
// ---------------------------------------------------------------------------

describe("IncomingCallBanner", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("stays hidden until a ring arrives", () => {
    const banner = createIncomingCallBanner({ onAccept: vi.fn(), onDecline: vi.fn() });
    banner.mount(container);
    const el = container.querySelector('[data-testid="incoming-call-banner"]') as HTMLElement;
    expect(el.style.display).toBe("none");
    banner.destroy?.();
  });

  it("shows the caller's name when ringing", () => {
    const banner = createIncomingCallBanner({ onAccept: vi.fn(), onDecline: vi.fn() });
    banner.mount(container);
    banner.setRing({ channelId: 3, fromUserId: 9, fromUsername: "alice" });

    const el = container.querySelector('[data-testid="incoming-call-banner"]') as HTMLElement;
    expect(el.style.display).toBe("");
    expect(container.querySelector('[data-testid="incoming-call-title"]')!.textContent).toBe(
      "alice is calling",
    );
    banner.destroy?.();
  });

  // The username is user-controlled; it must land as text, never as markup.
  it("renders a hostile username as text", () => {
    const banner = createIncomingCallBanner({ onAccept: vi.fn(), onDecline: vi.fn() });
    banner.mount(container);
    banner.setRing({
      channelId: 3,
      fromUserId: 9,
      fromUsername: "<img src=x onerror=alert(1)>",
    });

    const title = container.querySelector('[data-testid="incoming-call-title"]')!;
    expect(title.querySelector("img")).toBeNull();
    expect(title.textContent).toContain("<img src=x onerror=alert(1)>");
    banner.destroy?.();
  });

  it("hides again when the ring clears", () => {
    const banner = createIncomingCallBanner({ onAccept: vi.fn(), onDecline: vi.fn() });
    banner.mount(container);
    banner.setRing({ channelId: 3, fromUserId: 9, fromUsername: "alice" });
    banner.setRing(null);

    const el = container.querySelector('[data-testid="incoming-call-banner"]') as HTMLElement;
    expect(el.style.display).toBe("none");
    banner.destroy?.();
  });

  it("reports accept and decline", () => {
    const onAccept = vi.fn();
    const onDecline = vi.fn();
    const banner = createIncomingCallBanner({ onAccept, onDecline });
    banner.mount(container);
    banner.setRing({ channelId: 3, fromUserId: 9, fromUsername: "alice" });

    (container.querySelector('[data-testid="incoming-call-accept"]') as HTMLElement).click();
    expect(onAccept).toHaveBeenCalledOnce();
    (container.querySelector('[data-testid="incoming-call-decline"]') as HTMLElement).click();
    expect(onDecline).toHaveBeenCalledOnce();

    banner.destroy?.();
  });
});
