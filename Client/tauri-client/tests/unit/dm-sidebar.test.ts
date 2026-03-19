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
});
