import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDmSidebar } from "../../src/components/DmSidebar";
import type { DmConversation } from "../../src/components/DmSidebar";

const makeConvo = (overrides: Partial<DmConversation> = {}): DmConversation => ({
  userId: 1,
  username: "Alice",
  avatar: null,
  status: "online",
  lastMessage: "Hello!",
  timestamp: "2025-01-01T00:00:00Z",
  unread: false,
  ...overrides,
});

describe("DmSidebar", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders the sidebar with search input", () => {
    const sidebar = createDmSidebar({
      conversations: [],
      onSelectConversation: vi.fn(),
      onNewDm: vi.fn(),
    });
    sidebar.mount(container);

    const searchInput = container.querySelector(".dm-search");
    expect(searchInput).not.toBeNull();
    expect((searchInput as HTMLInputElement).placeholder).toBe("Find a conversation");

    sidebar.destroy?.();
  });

  it("renders Friends nav item", () => {
    const sidebar = createDmSidebar({
      conversations: [],
      onSelectConversation: vi.fn(),
      onNewDm: vi.fn(),
    });
    sidebar.mount(container);

    const friendsNav = container.querySelector(".dm-nav-item");
    expect(friendsNav).not.toBeNull();
    expect(friendsNav!.textContent).toBe("Friends");

    sidebar.destroy?.();
  });

  it("marks Friends nav as active when friendsActive is true", () => {
    const sidebar = createDmSidebar({
      conversations: [],
      onSelectConversation: vi.fn(),
      onNewDm: vi.fn(),
      friendsActive: true,
    });
    sidebar.mount(container);

    const friendsNav = container.querySelector(".dm-nav-item");
    expect(friendsNav!.classList.contains("active")).toBe(true);

    sidebar.destroy?.();
  });

  it("renders conversation items", () => {
    const conversations: DmConversation[] = [
      makeConvo({ userId: 1, username: "Alice" }),
      makeConvo({ userId: 2, username: "Bob" }),
    ];

    const sidebar = createDmSidebar({
      conversations,
      onSelectConversation: vi.fn(),
      onNewDm: vi.fn(),
    });
    sidebar.mount(container);

    const items = container.querySelectorAll(".dm-item");
    expect(items.length).toBe(2);

    sidebar.destroy?.();
  });

  it("sorts unread conversations first", () => {
    const conversations: DmConversation[] = [
      makeConvo({ userId: 1, username: "Alice", unread: false }),
      makeConvo({ userId: 2, username: "Bob", unread: true }),
    ];

    const sidebar = createDmSidebar({
      conversations,
      onSelectConversation: vi.fn(),
      onNewDm: vi.fn(),
    });
    sidebar.mount(container);

    const items = container.querySelectorAll(".dm-item");
    // Bob (unread) should come first
    expect(items[0]!.querySelector(".dm-name")!.textContent).toBe("Bob");
    expect(items[1]!.querySelector(".dm-name")!.textContent).toBe("Alice");

    sidebar.destroy?.();
  });

  it("shows unread dot for unread conversations", () => {
    const sidebar = createDmSidebar({
      conversations: [makeConvo({ unread: true })],
      onSelectConversation: vi.fn(),
      onNewDm: vi.fn(),
    });
    sidebar.mount(container);

    const unreadDot = container.querySelector(".dm-unread");
    expect(unreadDot).not.toBeNull();

    sidebar.destroy?.();
  });

  it("calls onSelectConversation when a DM item is clicked", () => {
    const onSelectConversation = vi.fn();
    const sidebar = createDmSidebar({
      conversations: [makeConvo({ userId: 42 })],
      onSelectConversation,
      onNewDm: vi.fn(),
    });
    sidebar.mount(container);

    const item = container.querySelector(".dm-item") as HTMLElement;
    item.click();
    expect(onSelectConversation).toHaveBeenCalledWith(42);

    sidebar.destroy?.();
  });

  it("calls onCloseDm when close button is clicked", () => {
    const onCloseDm = vi.fn();
    const sidebar = createDmSidebar({
      conversations: [makeConvo({ userId: 42 })],
      onSelectConversation: vi.fn(),
      onNewDm: vi.fn(),
      onCloseDm,
    });
    sidebar.mount(container);

    const closeBtn = container.querySelector(".dm-close") as HTMLButtonElement;
    closeBtn.click();
    expect(onCloseDm).toHaveBeenCalledWith(42);

    sidebar.destroy?.();
  });

  it("calls onNewDm when add button is clicked", () => {
    const onNewDm = vi.fn();
    const sidebar = createDmSidebar({
      conversations: [],
      onSelectConversation: vi.fn(),
      onNewDm,
    });
    sidebar.mount(container);

    const addBtn = container.querySelector(".dm-add") as HTMLButtonElement;
    addBtn.click();
    expect(onNewDm).toHaveBeenCalledOnce();

    sidebar.destroy?.();
  });

  it("shows avatar initial when no avatar image", () => {
    const sidebar = createDmSidebar({
      conversations: [makeConvo({ username: "alice", avatar: null })],
      onSelectConversation: vi.fn(),
      onNewDm: vi.fn(),
    });
    sidebar.mount(container);

    const avatar = container.querySelector(".dm-avatar");
    expect(avatar!.textContent).toBe("A");

    sidebar.destroy?.();
  });

  it("shows avatar image when avatar URL is provided", () => {
    const sidebar = createDmSidebar({
      conversations: [makeConvo({ avatar: "http://example.com/img.png" })],
      onSelectConversation: vi.fn(),
      onNewDm: vi.fn(),
    });
    sidebar.mount(container);

    const img = container.querySelector(".dm-avatar img") as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.src).toBe("http://example.com/img.png");

    sidebar.destroy?.();
  });

  it("marks active conversation with active class", () => {
    const sidebar = createDmSidebar({
      conversations: [makeConvo({ active: true })],
      onSelectConversation: vi.fn(),
      onNewDm: vi.fn(),
    });
    sidebar.mount(container);

    const item = container.querySelector(".dm-item");
    expect(item!.classList.contains("active")).toBe(true);

    sidebar.destroy?.();
  });

  it("cleans up on destroy", () => {
    const sidebar = createDmSidebar({
      conversations: [],
      onSelectConversation: vi.fn(),
      onNewDm: vi.fn(),
    });
    sidebar.mount(container);

    expect(container.querySelector(".channel-sidebar")).not.toBeNull();

    sidebar.destroy?.();
    expect(container.querySelector(".channel-sidebar")).toBeNull();
  });

  it("renders back header when onBack is provided", () => {
    const onBack = vi.fn();
    const sidebar = createDmSidebar({
      conversations: [],
      onSelectConversation: vi.fn(),
      onNewDm: vi.fn(),
      onBack,
      serverName: "OwnCord",
    });
    sidebar.mount(container);

    const backHeader = container.querySelector('[data-testid="dm-back-header"]');
    expect(backHeader).not.toBeNull();
    expect(backHeader!.textContent).toContain("Back to OwnCord");
    expect(backHeader!.textContent).toContain("Return to channels");

    sidebar.destroy?.();
  });

  it("clicking back header calls onBack", () => {
    const onBack = vi.fn();
    const sidebar = createDmSidebar({
      conversations: [],
      onSelectConversation: vi.fn(),
      onNewDm: vi.fn(),
      onBack,
    });
    sidebar.mount(container);

    const backHeader = container.querySelector('[data-testid="dm-back-header"]') as HTMLDivElement;
    backHeader.click();
    expect(onBack).toHaveBeenCalledOnce();

    sidebar.destroy?.();
  });

  it("does not render back header when onBack is undefined", () => {
    const sidebar = createDmSidebar({
      conversations: [],
      onSelectConversation: vi.fn(),
      onNewDm: vi.fn(),
    });
    sidebar.mount(container);

    const backHeader = container.querySelector('[data-testid="dm-back-header"]');
    expect(backHeader).toBeNull();

    sidebar.destroy?.();
  });

  it("calls onFriendsClick when Friends nav item is clicked", () => {
    const onFriendsClick = vi.fn();
    const sidebar = createDmSidebar({
      conversations: [],
      onSelectConversation: vi.fn(),
      onNewDm: vi.fn(),
      onFriendsClick,
    });
    sidebar.mount(container);

    const friendsNav = container.querySelector(".dm-nav-item") as HTMLDivElement;
    friendsNav.click();
    expect(onFriendsClick).toHaveBeenCalledOnce();

    sidebar.destroy?.();
  });

  it("applies correct status color to DM status dot", () => {
    const sidebar = createDmSidebar({
      conversations: [
        makeConvo({ userId: 1, username: "Alice", status: "online" }),
        makeConvo({ userId: 2, username: "Bob", status: "dnd" }),
        makeConvo({ userId: 3, username: "Charlie", status: "idle" }),
        makeConvo({ userId: 4, username: "Dave", status: "offline" }),
      ],
      onSelectConversation: vi.fn(),
      onNewDm: vi.fn(),
    });
    sidebar.mount(container);

    const statusDots = container.querySelectorAll(".dm-status") as NodeListOf<HTMLSpanElement>;
    const colors = Array.from(statusDots).map((dot) => dot.style.background);

    expect(colors).toContain("var(--green)");
    expect(colors).toContain("var(--red)");
    expect(colors).toContain("var(--yellow)");
    expect(colors).toContain("var(--text-micro)");

    sidebar.destroy?.();
  });

  it("close button click does not trigger conversation select", () => {
    const onSelectConversation = vi.fn();
    const onCloseDm = vi.fn();
    const sidebar = createDmSidebar({
      conversations: [makeConvo({ userId: 42 })],
      onSelectConversation,
      onNewDm: vi.fn(),
      onCloseDm,
    });
    sidebar.mount(container);

    const closeBtn = container.querySelector(".dm-close") as HTMLButtonElement;
    closeBtn.click();

    // Close fires but select should NOT fire (stopPropagation)
    expect(onCloseDm).toHaveBeenCalledWith(42);
    expect(onSelectConversation).not.toHaveBeenCalled();

    sidebar.destroy?.();
  });

  it("clicking a DM item marks it active and deactivates siblings", () => {
    const sidebar = createDmSidebar({
      conversations: [
        makeConvo({ userId: 1, username: "Alice" }),
        makeConvo({ userId: 2, username: "Bob" }),
      ],
      onSelectConversation: vi.fn(),
      onNewDm: vi.fn(),
    });
    sidebar.mount(container);

    const items = container.querySelectorAll(".dm-item");
    (items[0] as HTMLElement).click();
    expect(items[0]!.classList.contains("active")).toBe(true);

    // Click the second item — first should lose active
    (items[1] as HTMLElement).click();
    expect(items[1]!.classList.contains("active")).toBe(true);
    expect(items[0]!.classList.contains("active")).toBe(false);

    sidebar.destroy?.();
  });

  it("uses default avatar color when avatarColor is not provided", () => {
    const sidebar = createDmSidebar({
      conversations: [makeConvo({ avatar: null, avatarColor: undefined })],
      onSelectConversation: vi.fn(),
      onNewDm: vi.fn(),
    });
    sidebar.mount(container);

    const avatar = container.querySelector(".dm-avatar") as HTMLDivElement;
    // Default background is #5865F2
    expect(avatar.style.background).toBe("rgb(88, 101, 242)");

    sidebar.destroy?.();
  });

  it("uses custom avatar color when provided", () => {
    const sidebar = createDmSidebar({
      conversations: [makeConvo({ avatar: null, avatarColor: "#ff0000" })],
      onSelectConversation: vi.fn(),
      onNewDm: vi.fn(),
    });
    sidebar.mount(container);

    const avatar = container.querySelector(".dm-avatar") as HTMLDivElement;
    expect(avatar.style.background).toBe("rgb(255, 0, 0)");

    sidebar.destroy?.();
  });

  it("does not show unread dot for read conversations", () => {
    const sidebar = createDmSidebar({
      conversations: [makeConvo({ unread: false })],
      onSelectConversation: vi.fn(),
      onNewDm: vi.fn(),
    });
    sidebar.mount(container);

    const unreadDot = container.querySelector(".dm-unread");
    expect(unreadDot).toBeNull();

    sidebar.destroy?.();
  });

  it("back header defaults to 'Server' when serverName not provided", () => {
    const sidebar = createDmSidebar({
      conversations: [],
      onSelectConversation: vi.fn(),
      onNewDm: vi.fn(),
      onBack: vi.fn(),
    });
    sidebar.mount(container);

    const backHeader = container.querySelector('[data-testid="dm-back-header"]');
    expect(backHeader!.textContent).toContain("Back to Server");

    sidebar.destroy?.();
  });

  it("uses offline status color for unknown status values", () => {
    const sidebar = createDmSidebar({
      conversations: [makeConvo({ status: undefined })],
      onSelectConversation: vi.fn(),
      onNewDm: vi.fn(),
    });
    sidebar.mount(container);

    const statusDot = container.querySelector(".dm-status") as HTMLSpanElement;
    // undefined status falls back to "offline" key
    expect(statusDot.style.background).toBe("var(--text-micro)");

    sidebar.destroy?.();
  });
});
