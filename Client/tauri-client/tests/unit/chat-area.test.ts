import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be set up before the module under test is imported
// ---------------------------------------------------------------------------

const {
  mockPinnedToggle,
  mockPinnedCleanup,
  mockSearchOpen,
  mockSearchCleanup,
  mockVideoMount,
  mockVideoDestroy,
} = vi.hoisted(() => ({
  mockPinnedToggle: vi.fn(),
  mockPinnedCleanup: vi.fn(),
  mockSearchOpen: vi.fn(),
  mockSearchCleanup: vi.fn(),
  mockVideoMount: vi.fn(),
  mockVideoDestroy: vi.fn(),
}));

vi.mock("@lib/icons", () => ({
  createIcon: () => document.createElement("span"),
}));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

vi.mock("@lib/toast", () => ({
  showToast: vi.fn(),
}));

// Mock the OverlayManagers used by ChatArea
vi.mock("../../src/pages/main-page/OverlayManagers", () => ({
  createPinnedPanelController: vi.fn((_opts: unknown) => ({
    toggle: mockPinnedToggle,
    cleanup: mockPinnedCleanup,
  })),
  createSearchOverlayController: vi.fn((_opts: unknown) => ({
    open: mockSearchOpen,
    cleanup: mockSearchCleanup,
  })),
}));

// Mock VideoGrid
vi.mock("@components/VideoGrid", () => ({
  createVideoGrid: vi.fn(() => ({
    mount: mockVideoMount,
    destroy: mockVideoDestroy,
    addStream: vi.fn(),
    removeStream: vi.fn(),
    hasStreams: vi.fn(() => false),
    setFocusedTile: vi.fn(),
    getFocusedTileId: vi.fn(() => null),
  })),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { createChatArea } from "../../src/pages/main-page/ChatArea";
import type { ChatAreaOptions } from "../../src/pages/main-page/ChatArea";
import { createPinnedPanelController, createSearchOverlayController } from "../../src/pages/main-page/OverlayManagers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOptions(overrides: Partial<ChatAreaOptions> = {}): ChatAreaOptions {
  return {
    api: { getPins: vi.fn(), search: vi.fn(), unpinMessage: vi.fn() } as unknown as ChatAreaOptions["api"],
    getRoot: () => document.createElement("div"),
    getToast: () => null,
    getChannelCtrl: () => null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createChatArea", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    container.remove();
  });

  // --- DOM structure ---

  it("returns a chatArea element with class 'chat-area' and data-testid", () => {
    const result = createChatArea(makeOptions());

    expect(result.chatArea).toBeInstanceOf(HTMLDivElement);
    expect(result.chatArea.classList.contains("chat-area")).toBe(true);
    expect(result.chatArea.getAttribute("data-testid")).toBe("chat-area");
  });

  it("includes a chat header as the first child", () => {
    const result = createChatArea(makeOptions());

    const header = result.chatArea.querySelector("[data-testid='chat-header']");
    expect(header).not.toBeNull();
    // The header should be the first child of chatArea
    expect(result.chatArea.firstElementChild).toBe(header);
  });

  it("creates messages-slot with correct class and testid", () => {
    const result = createChatArea(makeOptions());

    const slot = result.chatArea.querySelector("[data-testid='messages-slot']");
    expect(slot).not.toBeNull();
    expect(slot!.classList.contains("messages-slot")).toBe(true);
  });

  it("creates typing-slot with correct class and testid", () => {
    const result = createChatArea(makeOptions());

    const slot = result.chatArea.querySelector("[data-testid='typing-slot']");
    expect(slot).not.toBeNull();
    expect(slot!.classList.contains("typing-slot")).toBe(true);
  });

  it("creates input-slot with correct class and testid", () => {
    const result = createChatArea(makeOptions());

    const slot = result.chatArea.querySelector("[data-testid='input-slot']");
    expect(slot).not.toBeNull();
    expect(slot!.classList.contains("input-slot")).toBe(true);
  });

  it("creates video-grid-slot hidden by default", () => {
    const result = createChatArea(makeOptions());

    const slot = result.chatArea.querySelector("[data-testid='video-grid-slot']");
    expect(slot).not.toBeNull();
    expect(slot!.classList.contains("video-grid-slot")).toBe(true);
    expect((slot as HTMLElement).style.display).toBe("none");
  });

  it("appends slots in order: header, messages, typing, input, videoGrid", () => {
    const result = createChatArea(makeOptions());
    const children = Array.from(result.chatArea.children);

    expect(children.length).toBe(5);
    expect(children[0]!.getAttribute("data-testid")).toBe("chat-header");
    expect(children[1]!.getAttribute("data-testid")).toBe("messages-slot");
    expect(children[2]!.getAttribute("data-testid")).toBe("typing-slot");
    expect(children[3]!.getAttribute("data-testid")).toBe("input-slot");
    expect(children[4]!.getAttribute("data-testid")).toBe("video-grid-slot");
  });

  // --- Slots in return value ---

  it("returns all four slots as separate DOM elements", () => {
    const result = createChatArea(makeOptions());

    expect(result.slots.messagesSlot).toBeInstanceOf(HTMLDivElement);
    expect(result.slots.typingSlot).toBeInstanceOf(HTMLDivElement);
    expect(result.slots.inputSlot).toBeInstanceOf(HTMLDivElement);
    expect(result.slots.videoGridSlot).toBeInstanceOf(HTMLDivElement);
  });

  it("slot elements are children of chatArea", () => {
    const result = createChatArea(makeOptions());

    expect(result.chatArea.contains(result.slots.messagesSlot)).toBe(true);
    expect(result.chatArea.contains(result.slots.typingSlot)).toBe(true);
    expect(result.chatArea.contains(result.slots.inputSlot)).toBe(true);
    expect(result.chatArea.contains(result.slots.videoGridSlot)).toBe(true);
  });

  // --- VideoGrid ---

  it("mounts the videoGrid into the video-grid-slot", () => {
    const result = createChatArea(makeOptions());

    expect(mockVideoMount).toHaveBeenCalledTimes(1);
    expect(mockVideoMount).toHaveBeenCalledWith(result.slots.videoGridSlot);
  });

  it("includes videoGrid in children array for cleanup", () => {
    const result = createChatArea(makeOptions());

    expect(result.children.length).toBe(1);
    expect(result.children[0]).toHaveProperty("mount");
    expect(result.children[0]).toHaveProperty("destroy");
  });

  it("returns the videoGrid component instance", () => {
    const result = createChatArea(makeOptions());

    expect(result.videoGrid).toBeDefined();
    expect(result.videoGrid.hasStreams()).toBe(false);
  });

  // --- ChatHeader refs ---

  it("returns chatHeaderName from header refs", () => {
    const result = createChatArea(makeOptions());

    // The header name element should exist
    expect(result.chatHeaderName).not.toBeNull();
    expect(result.chatHeaderName!.classList.contains("ch-name")).toBe(true);
  });

  it("returns chatHeaderRefs with hashEl, nameEl, and topicEl", () => {
    const result = createChatArea(makeOptions());
    const refs = result.chatHeaderRefs;

    expect(refs.hashEl).toBeInstanceOf(HTMLSpanElement);
    expect(refs.nameEl).toBeInstanceOf(HTMLSpanElement);
    expect(refs.topicEl).toBeInstanceOf(HTMLSpanElement);
  });

  it("chatHeaderName matches the nameEl in chatHeaderRefs", () => {
    const result = createChatArea(makeOptions());

    expect(result.chatHeaderName).toBe(result.chatHeaderRefs.nameEl);
  });

  // --- Overlay controllers ---

  it("creates a PinnedPanelController with correct options", () => {
    const api = { getPins: vi.fn(), search: vi.fn() } as unknown as ChatAreaOptions["api"];
    const getRoot = () => document.createElement("div");

    createChatArea(makeOptions({ api, getRoot }));

    expect(createPinnedPanelController).toHaveBeenCalledTimes(1);
    const call = vi.mocked(createPinnedPanelController).mock.calls[0]![0];
    expect(call.api).toBe(api);
    expect(call.getRoot).toBe(getRoot);
    expect(typeof call.getCurrentChannelId).toBe("function");
    expect(typeof call.onJumpToMessage).toBe("function");
  });

  it("creates a SearchOverlayController with correct options", () => {
    const api = { getPins: vi.fn(), search: vi.fn() } as unknown as ChatAreaOptions["api"];
    const getRoot = () => document.createElement("div");

    createChatArea(makeOptions({ api, getRoot }));

    expect(createSearchOverlayController).toHaveBeenCalledTimes(1);
    const call = vi.mocked(createSearchOverlayController).mock.calls[0]![0];
    expect(call.api).toBe(api);
    expect(call.getRoot).toBe(getRoot);
    expect(typeof call.getCurrentChannelId).toBe("function");
    expect(typeof call.onJumpToMessage).toBe("function");
  });

  it("returns searchCtrl in the result", () => {
    const result = createChatArea(makeOptions());

    expect(result.searchCtrl).toBeDefined();
    expect(typeof result.searchCtrl.open).toBe("function");
    expect(typeof result.searchCtrl.cleanup).toBe("function");
  });

  // --- Unsubscribers ---

  it("includes cleanup functions for pinned and search controllers", () => {
    const result = createChatArea(makeOptions());

    // Should have at least 2 unsubscribers (pinned + search)
    expect(result.unsubscribers.length).toBe(2);
    expect(typeof result.unsubscribers[0]).toBe("function");
    expect(typeof result.unsubscribers[1]).toBe("function");
  });

  it("unsubscribers call cleanup on pinned and search controllers", () => {
    const result = createChatArea(makeOptions());

    result.unsubscribers[0]!();
    expect(mockPinnedCleanup).toHaveBeenCalledTimes(1);

    result.unsubscribers[1]!();
    expect(mockSearchCleanup).toHaveBeenCalledTimes(1);
  });

  // --- Pin button interaction ---

  it("clicking pin button toggles the pinned panel controller", () => {
    const result = createChatArea(makeOptions());

    const pinBtn = result.chatArea.querySelector("[data-testid='pin-btn']") as HTMLButtonElement;
    expect(pinBtn).not.toBeNull();
    pinBtn.click();
    expect(mockPinnedToggle).toHaveBeenCalledTimes(1);
  });

  // --- Search input interaction ---

  it("focusing search input opens the search overlay controller", () => {
    const result = createChatArea(makeOptions());

    const searchInput = result.chatArea.querySelector("[data-testid='search-input']") as HTMLInputElement;
    expect(searchInput).not.toBeNull();
    searchInput.dispatchEvent(new Event("focus"));
    expect(mockSearchOpen).toHaveBeenCalledTimes(1);
  });

  // --- Channel controller integration via getCurrentChannelId ---

  it("pinned controller getCurrentChannelId returns null when getChannelCtrl returns null", () => {
    createChatArea(makeOptions({ getChannelCtrl: () => null }));

    const call = vi.mocked(createPinnedPanelController).mock.calls[0]![0];
    expect(call.getCurrentChannelId()).toBeNull();
  });

  it("pinned controller getCurrentChannelId returns channelId from channel controller", () => {
    const channelCtrl = { currentChannelId: 42, messageList: null } as any;
    createChatArea(makeOptions({ getChannelCtrl: () => channelCtrl }));

    const call = vi.mocked(createPinnedPanelController).mock.calls[0]![0];
    expect(call.getCurrentChannelId()).toBe(42);
  });

  it("search controller getCurrentChannelId returns null when getChannelCtrl returns null", () => {
    createChatArea(makeOptions({ getChannelCtrl: () => null }));

    const call = vi.mocked(createSearchOverlayController).mock.calls[0]![0];
    expect(call.getCurrentChannelId()).toBeNull();
  });

  it("search controller getCurrentChannelId returns channelId from channel controller", () => {
    const channelCtrl = { currentChannelId: 99, messageList: null } as any;
    createChatArea(makeOptions({ getChannelCtrl: () => channelCtrl }));

    const call = vi.mocked(createSearchOverlayController).mock.calls[0]![0];
    expect(call.getCurrentChannelId()).toBe(99);
  });

  // --- onJumpToMessage for pinned controller ---

  it("pinned onJumpToMessage returns false when channel controller is null", () => {
    createChatArea(makeOptions({ getChannelCtrl: () => null }));

    const call = vi.mocked(createPinnedPanelController).mock.calls[0]![0];
    expect(call.onJumpToMessage!(123)).toBe(false);
  });

  it("pinned onJumpToMessage returns false when messageList is null", () => {
    const channelCtrl = { currentChannelId: 1, messageList: null } as any;
    createChatArea(makeOptions({ getChannelCtrl: () => channelCtrl }));

    const call = vi.mocked(createPinnedPanelController).mock.calls[0]![0];
    expect(call.onJumpToMessage!(123)).toBe(false);
  });

  it("pinned onJumpToMessage delegates to messageList.scrollToMessage", () => {
    const mockScrollToMessage = vi.fn(() => true);
    const channelCtrl = {
      currentChannelId: 1,
      messageList: { scrollToMessage: mockScrollToMessage },
    } as any;
    createChatArea(makeOptions({ getChannelCtrl: () => channelCtrl }));

    const call = vi.mocked(createPinnedPanelController).mock.calls[0]![0];
    const result = call.onJumpToMessage!(42);
    expect(result).toBe(true);
    expect(mockScrollToMessage).toHaveBeenCalledWith(42);
  });

  it("pinned onJumpToMessage returns false when scrollToMessage returns false", () => {
    const mockScrollToMessage = vi.fn(() => false);
    const channelCtrl = {
      currentChannelId: 1,
      messageList: { scrollToMessage: mockScrollToMessage },
    } as any;
    createChatArea(makeOptions({ getChannelCtrl: () => channelCtrl }));

    const call = vi.mocked(createPinnedPanelController).mock.calls[0]![0];
    const result = call.onJumpToMessage!(99);
    expect(result).toBe(false);
    expect(mockScrollToMessage).toHaveBeenCalledWith(99);
  });

  // --- onJumpToMessage for search controller ---

  it("search onJumpToMessage returns false when channel controller is null", () => {
    createChatArea(makeOptions({ getChannelCtrl: () => null }));

    const call = vi.mocked(createSearchOverlayController).mock.calls[0]![0];
    expect(call.onJumpToMessage!(1, 123)).toBe(false);
  });

  it("search onJumpToMessage returns false when messageList is null", () => {
    const channelCtrl = { currentChannelId: 1, messageList: null } as any;
    createChatArea(makeOptions({ getChannelCtrl: () => channelCtrl }));

    const call = vi.mocked(createSearchOverlayController).mock.calls[0]![0];
    expect(call.onJumpToMessage!(1, 123)).toBe(false);
  });

  it("search onJumpToMessage delegates to messageList.scrollToMessage", () => {
    const mockScrollToMessage = vi.fn(() => true);
    const channelCtrl = {
      currentChannelId: 1,
      messageList: { scrollToMessage: mockScrollToMessage },
    } as any;
    createChatArea(makeOptions({ getChannelCtrl: () => channelCtrl }));

    const call = vi.mocked(createSearchOverlayController).mock.calls[0]![0];
    const result = call.onJumpToMessage!(1, 55);
    expect(result).toBe(true);
    expect(mockScrollToMessage).toHaveBeenCalledWith(55);
  });

  // --- Header default content ---

  it("chat header defaults to 'general' channel name", () => {
    const result = createChatArea(makeOptions());

    expect(result.chatHeaderRefs.nameEl.textContent).toBe("general");
  });

  it("chat header shows '#' hash by default", () => {
    const result = createChatArea(makeOptions());

    expect(result.chatHeaderRefs.hashEl.textContent).toBe("#");
  });
});
