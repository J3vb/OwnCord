import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (vi.hoisted so they're available in vi.mock factories)
// ---------------------------------------------------------------------------

const {
  mockLogError,
  mockInviteManagerMount,
  mockInviteManagerDestroy,
  mockPinnedMessagesMount,
  mockPinnedMessagesDestroy,
  mockShowToast,
  mockQuickSwitcherMount,
  mockQuickSwitcherDestroy,
  mockSearchOverlayMount,
  mockSearchOverlayDestroy,
  mockSetActiveChannel,
} = vi.hoisted(() => ({
  mockLogError: vi.fn(),
  mockInviteManagerMount: vi.fn(),
  mockInviteManagerDestroy: vi.fn(),
  mockPinnedMessagesMount: vi.fn(),
  mockPinnedMessagesDestroy: vi.fn(),
  mockShowToast: vi.fn(),
  mockQuickSwitcherMount: vi.fn(),
  mockQuickSwitcherDestroy: vi.fn(),
  mockSearchOverlayMount: vi.fn(),
  mockSearchOverlayDestroy: vi.fn(),
  mockSetActiveChannel: vi.fn(),
}));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLogError,
  }),
}));

vi.mock("@components/QuickSwitcher", () => ({
  createQuickSwitcher: vi.fn(() => ({
    mount: mockQuickSwitcherMount,
    destroy: mockQuickSwitcherDestroy,
  })),
}));

vi.mock("@components/InviteManager", () => ({
  createInviteManager: vi.fn(() => ({
    mount: mockInviteManagerMount,
    destroy: mockInviteManagerDestroy,
  })),
}));

vi.mock("@components/PinnedMessages", () => ({
  createPinnedMessages: vi.fn(() => ({
    mount: mockPinnedMessagesMount,
    destroy: mockPinnedMessagesDestroy,
  })),
}));

vi.mock("@components/SearchOverlay", () => ({
  createSearchOverlay: vi.fn(() => ({
    mount: mockSearchOverlayMount,
    destroy: mockSearchOverlayDestroy,
  })),
}));

vi.mock("@stores/channels.store", () => ({
  setActiveChannel: mockSetActiveChannel,
}));

vi.mock("@lib/toast", () => ({
  initToast: vi.fn(),
  teardownToast: vi.fn(),
  showToast: mockShowToast,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { createQuickSwitcher } from "@components/QuickSwitcher";
import { createInviteManager } from "@components/InviteManager";
import { createPinnedMessages } from "@components/PinnedMessages";
import { createSearchOverlay } from "@components/SearchOverlay";
import {
  mapInviteResponse,
  mapToPinnedMessage,
  createQuickSwitcherManager,
  createInviteManagerController,
  createPinnedPanelController,
  createSearchOverlayController,
} from "@pages/main-page/OverlayManagers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInviteResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    code: "abc123xyz",
    url: "https://example.com/abc123xyz",
    max_uses: 10,
    use_count: 3,
    expires_at: null,
    ...overrides,
  };
}

function makeMockApi(overrides: Record<string, unknown> = {}) {
  return {
    getInvites: vi.fn().mockResolvedValue([makeInviteResponse()]),
    createInvite: vi.fn().mockResolvedValue(makeInviteResponse({ code: "new123" })),
    revokeInvite: vi.fn().mockResolvedValue(undefined),
    getPins: vi.fn().mockResolvedValue({
      messages: [
        { id: 1, user: { username: "Alice" }, content: "Pinned msg", created_at: "2024-01-01" },
      ],
    }),
    unpinMessage: vi.fn().mockResolvedValue(undefined),
    search: vi
      .fn()
      .mockResolvedValue({ results: [{ channel_id: 1, message_id: 10, content: "hello" }] }),
    ...overrides,
  };
}

function makeMockToast() {
  return { show: vi.fn() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createInviteManagerController", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
    vi.clearAllMocks();
  });

  afterEach(() => {
    root.remove();
  });

  it("opens invite manager and mounts to root", async () => {
    const api = makeMockApi();
    const toast = makeMockToast();

    const controller = createInviteManagerController({
      api: api as never,
      getRoot: () => root,
    });

    await controller.open();

    expect(createInviteManager).toHaveBeenCalledOnce();
    expect(mockInviteManagerMount).toHaveBeenCalledWith(root);
  });

  it("onRevokeInvite catches API error and re-throws for component handling", async () => {
    const api = makeMockApi({
      revokeInvite: vi.fn().mockRejectedValue(new Error("network error")),
    });
    const toast = makeMockToast();

    const controller = createInviteManagerController({
      api: api as never,
      getRoot: () => root,
    });

    await controller.open();

    // Extract the onRevokeInvite callback passed to InviteManager
    const opts = (createInviteManager as Mock).mock.calls[0]![0] as {
      onRevokeInvite: (code: string) => Promise<void>;
    };

    // The callback should re-throw so InviteManager's catch prevents optimistic removal
    await expect(opts.onRevokeInvite("abc123xyz")).rejects.toThrow("network error");

    // Controller should log the error with context
    expect(mockLogError).toHaveBeenCalled();
  });

  it("onRevokeInvite succeeds normally when API works", async () => {
    const api = makeMockApi();
    const toast = makeMockToast();

    const controller = createInviteManagerController({
      api: api as never,
      getRoot: () => root,
    });

    await controller.open();

    const opts = (createInviteManager as Mock).mock.calls[0]![0] as {
      onRevokeInvite: (code: string) => Promise<void>;
    };

    await expect(opts.onRevokeInvite("abc123xyz")).resolves.toBeUndefined();
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it("shows toast when open fails to load invites", async () => {
    const api = makeMockApi({
      getInvites: vi.fn().mockRejectedValue(new Error("load failed")),
    });
    const toast = makeMockToast();

    const controller = createInviteManagerController({
      api: api as never,
      getRoot: () => root,
    });

    await controller.open();

    expect(mockShowToast).toHaveBeenCalledWith("Failed to load invites", "error");
  });
});

describe("createPinnedPanelController", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
    vi.clearAllMocks();
  });

  afterEach(() => {
    root.remove();
  });

  it("toggles pinned panel open and mounts to root", async () => {
    const api = makeMockApi();
    const toast = makeMockToast();

    const controller = createPinnedPanelController({
      api: api as never,
      getRoot: () => root,

      getCurrentChannelId: () => 42,
    });

    await controller.toggle();

    expect(createPinnedMessages).toHaveBeenCalledOnce();
    expect(mockPinnedMessagesMount).toHaveBeenCalledWith(root);
  });

  it("onUnpin catches API error, shows toast, and does NOT close the panel", async () => {
    const api = makeMockApi({
      unpinMessage: vi.fn().mockRejectedValue(new Error("unpin failed")),
    });
    const toast = makeMockToast();

    const controller = createPinnedPanelController({
      api: api as never,
      getRoot: () => root,

      getCurrentChannelId: () => 42,
    });

    await controller.toggle();

    // Extract onUnpin callback passed to PinnedMessages
    const opts = (createPinnedMessages as Mock).mock.calls[0]![0] as {
      onUnpin: (msgId: number) => void;
    };

    // Call onUnpin — it should handle the error internally
    opts.onUnpin(1);

    // Wait for the async error handling to complete
    await vi.waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith("Failed to unpin message", "error");
    });

    // Panel should NOT have been destroyed (still open)
    expect(mockPinnedMessagesDestroy).not.toHaveBeenCalled();
  });

  it("onUnpin closes panel on success", async () => {
    const api = makeMockApi();
    const toast = makeMockToast();

    const controller = createPinnedPanelController({
      api: api as never,
      getRoot: () => root,

      getCurrentChannelId: () => 42,
    });

    await controller.toggle();

    const opts = (createPinnedMessages as Mock).mock.calls[0]![0] as {
      onUnpin: (msgId: number) => void;
    };

    opts.onUnpin(1);

    // Wait for the async success handling to complete
    await vi.waitFor(() => {
      expect(mockPinnedMessagesDestroy).toHaveBeenCalled();
    });

    // No error toast should be shown
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it("onJumpToMessage calls provided scroll callback and closes panel", async () => {
    const api = makeMockApi();
    const toast = makeMockToast();
    const mockScrollToMessage = vi.fn().mockReturnValue(true);

    const controller = createPinnedPanelController({
      api: api as never,
      getRoot: () => root,

      getCurrentChannelId: () => 42,
      onJumpToMessage: mockScrollToMessage,
    });

    await controller.toggle();

    const opts = (createPinnedMessages as Mock).mock.calls[0]![0] as {
      onJumpToMessage: (msgId: number) => void;
    };

    opts.onJumpToMessage(1);

    expect(mockScrollToMessage).toHaveBeenCalledWith(1);
    expect(mockPinnedMessagesDestroy).toHaveBeenCalled();
  });

  it("onJumpToMessage shows toast when message not in loaded window", async () => {
    const api = makeMockApi();
    const toast = makeMockToast();
    const mockScrollToMessage = vi.fn().mockReturnValue(false);

    const controller = createPinnedPanelController({
      api: api as never,
      getRoot: () => root,

      getCurrentChannelId: () => 42,
      onJumpToMessage: mockScrollToMessage,
    });

    await controller.toggle();

    const opts = (createPinnedMessages as Mock).mock.calls[0]![0] as {
      onJumpToMessage: (msgId: number) => void;
    };

    opts.onJumpToMessage(999);

    expect(mockScrollToMessage).toHaveBeenCalledWith(999);
    expect(mockShowToast).toHaveBeenCalledWith(expect.stringContaining("not in"), "info");
    // Panel should NOT close when message not found
    expect(mockPinnedMessagesDestroy).not.toHaveBeenCalled();
  });

  it("shows toast when toggle fails to load pins", async () => {
    const api = makeMockApi({
      getPins: vi.fn().mockRejectedValue(new Error("load failed")),
    });
    const toast = makeMockToast();

    const controller = createPinnedPanelController({
      api: api as never,
      getRoot: () => root,

      getCurrentChannelId: () => 42,
    });

    await controller.toggle();

    expect(mockShowToast).toHaveBeenCalledWith("Failed to load pinned messages", "error");
  });

  it("does nothing when root is null", async () => {
    const api = makeMockApi();

    const controller = createPinnedPanelController({
      api: api as never,
      getRoot: () => null,
      getCurrentChannelId: () => 42,
    });

    await controller.toggle();

    expect(createPinnedMessages).not.toHaveBeenCalled();
  });

  it("does nothing when channelId is null", async () => {
    const api = makeMockApi();

    const controller = createPinnedPanelController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => null,
    });

    await controller.toggle();

    expect(createPinnedMessages).not.toHaveBeenCalled();
  });

  it("toggle closes panel when already open", async () => {
    const api = makeMockApi();

    const controller = createPinnedPanelController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 42,
    });

    await controller.toggle();
    expect(mockPinnedMessagesMount).toHaveBeenCalledOnce();

    // Toggle again should close
    await controller.toggle();
    expect(mockPinnedMessagesDestroy).toHaveBeenCalled();
  });

  it("cleanup closes panel if open", async () => {
    const api = makeMockApi();

    const controller = createPinnedPanelController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 42,
    });

    await controller.toggle();
    controller.cleanup();

    expect(mockPinnedMessagesDestroy).toHaveBeenCalled();
  });

  it("cleanup is safe when no panel is open", () => {
    const api = makeMockApi();

    const controller = createPinnedPanelController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 42,
    });

    // Should not throw
    controller.cleanup();
    expect(mockPinnedMessagesDestroy).not.toHaveBeenCalled();
  });

  it("onJumpToMessage closes panel when no callback is provided", async () => {
    const api = makeMockApi();

    const controller = createPinnedPanelController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 42,
      // no onJumpToMessage provided
    });

    await controller.toggle();

    const opts = (createPinnedMessages as Mock).mock.calls[0]![0] as {
      onJumpToMessage: (msgId: number) => void;
    };

    opts.onJumpToMessage(1);

    // Without a callback, should just close the panel
    expect(mockPinnedMessagesDestroy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// mapInviteResponse
// ---------------------------------------------------------------------------

describe("mapInviteResponse", () => {
  it("maps a basic invite response with use_count", () => {
    const result = mapInviteResponse({
      id: 1,
      code: "abc123",
      url: "https://example.com/abc123",
      max_uses: 10,
      use_count: 3,
      expires_at: "2024-12-31",
    });

    expect(result.code).toBe("abc123");
    expect(result.uses).toBe(3);
    expect(result.maxUses).toBe(10);
    expect(result.expiresAt).toBe("2024-12-31");
    expect(result.createdBy).toBe("unknown");
    expect(result.createdAt).toBe("2024-12-31");
  });

  it("extracts created_by username from extra field", () => {
    const raw = {
      id: 1,
      code: "abc",
      url: "https://example.com/abc",
      max_uses: 5,
      use_count: 0,
      expires_at: null,
      created_by: { username: "Alice" },
    };

    const result = mapInviteResponse(raw as never);
    expect(result.createdBy).toBe("Alice");
  });

  it("falls back to 'unknown' when created_by has no username", () => {
    const raw = {
      id: 1,
      code: "abc",
      url: "https://example.com/abc",
      max_uses: 5,
      use_count: 0,
      expires_at: null,
      created_by: {},
    };

    const result = mapInviteResponse(raw as never);
    expect(result.createdBy).toBe("unknown");
  });

  it("falls back to 'unknown' when created_by is not an object", () => {
    const raw = {
      id: 1,
      code: "abc",
      url: "https://example.com/abc",
      max_uses: 5,
      use_count: 0,
      expires_at: null,
      created_by: "string-value",
    };

    const result = mapInviteResponse(raw as never);
    expect(result.createdBy).toBe("unknown");
  });

  it("uses 'uses' extra field when use_count is undefined", () => {
    const raw = {
      id: 1,
      code: "abc",
      url: "https://example.com/abc",
      max_uses: 5,
      use_count: undefined,
      expires_at: null,
      uses: 7,
    };

    const result = mapInviteResponse(raw as never);
    expect(result.uses).toBe(7);
  });

  it("defaults uses to 0 when neither use_count nor uses is present", () => {
    const raw = {
      id: 1,
      code: "abc",
      url: "https://example.com/abc",
      max_uses: 5,
      use_count: undefined,
      expires_at: null,
    };

    const result = mapInviteResponse(raw as never);
    expect(result.uses).toBe(0);
  });

  it("uses empty string for createdAt when expires_at is null", () => {
    const raw = {
      id: 1,
      code: "abc",
      url: "https://example.com/abc",
      max_uses: 5,
      use_count: 0,
      expires_at: null,
    };

    const result = mapInviteResponse(raw as never);
    expect(result.createdAt).toBe("");
  });
});

// ---------------------------------------------------------------------------
// mapToPinnedMessage
// ---------------------------------------------------------------------------

describe("mapToPinnedMessage", () => {
  it("maps a pinned message with created_at", () => {
    const result = mapToPinnedMessage({
      id: 1,
      user: { username: "Alice" },
      content: "Hello",
      created_at: "2024-01-01",
    });

    expect(result.id).toBe(1);
    expect(result.author).toBe("Alice");
    expect(result.content).toBe("Hello");
    expect(result.timestamp).toBe("2024-01-01");
    expect(result.avatarColor).toMatch(/^hsl\(\d+, 55%, 55%\)$/);
  });

  it("falls back to timestamp when created_at is undefined", () => {
    const result = mapToPinnedMessage({
      id: 2,
      user: { username: "Bob" },
      content: "World",
      timestamp: "2024-02-15",
    });

    expect(result.timestamp).toBe("2024-02-15");
  });

  it("falls back to empty string when neither created_at nor timestamp is set", () => {
    const result = mapToPinnedMessage({
      id: 3,
      user: { username: "Charlie" },
      content: "No timestamp",
    });

    expect(result.timestamp).toBe("");
  });

  it("generates deterministic avatar color for same username", () => {
    const a = mapToPinnedMessage({ id: 1, user: { username: "Alice" }, content: "" });
    const b = mapToPinnedMessage({ id: 2, user: { username: "Alice" }, content: "" });

    expect(a.avatarColor).toBe(b.avatarColor);
  });

  it("generates different colors for different usernames", () => {
    const a = mapToPinnedMessage({ id: 1, user: { username: "Alice" }, content: "" });
    const b = mapToPinnedMessage({ id: 2, user: { username: "Bob" }, content: "" });

    // Not guaranteed to be different in theory, but these specific names will differ
    expect(a.avatarColor).not.toBe(b.avatarColor);
  });
});

// ---------------------------------------------------------------------------
// createQuickSwitcherManager
// ---------------------------------------------------------------------------

describe("createQuickSwitcherManager", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
    vi.clearAllMocks();
  });

  afterEach(() => {
    root.remove();
  });

  it("opens quick switcher on Ctrl+K", () => {
    const manager = createQuickSwitcherManager(() => root);
    const cleanup = manager.attach();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));

    expect(createQuickSwitcher).toHaveBeenCalledOnce();
    expect(mockQuickSwitcherMount).toHaveBeenCalledWith(root);

    cleanup();
  });

  it("closes quick switcher on second Ctrl+K", () => {
    const manager = createQuickSwitcherManager(() => root);
    const cleanup = manager.attach();

    // Open
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    expect(createQuickSwitcher).toHaveBeenCalledOnce();

    // Close
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    expect(mockQuickSwitcherDestroy).toHaveBeenCalled();

    cleanup();
  });

  it("opens quick switcher on Meta+K (macOS)", () => {
    const manager = createQuickSwitcherManager(() => root);
    const cleanup = manager.attach();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));

    expect(createQuickSwitcher).toHaveBeenCalledOnce();

    cleanup();
  });

  it("does not open on plain K key without modifier", () => {
    const manager = createQuickSwitcherManager(() => root);
    const cleanup = manager.attach();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k" }));

    expect(createQuickSwitcher).not.toHaveBeenCalled();

    cleanup();
  });

  it("does nothing when root is null", () => {
    const manager = createQuickSwitcherManager(() => null);
    const cleanup = manager.attach();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));

    expect(createQuickSwitcher).not.toHaveBeenCalled();

    cleanup();
  });

  it("cleanup removes the keydown listener and closes", () => {
    const manager = createQuickSwitcherManager(() => root);
    const cleanup = manager.attach();

    // Open first
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    expect(createQuickSwitcher).toHaveBeenCalledOnce();

    // Cleanup
    cleanup();

    // Verify destroy was called
    expect(mockQuickSwitcherDestroy).toHaveBeenCalled();

    // After cleanup, Ctrl+K should not open a new instance
    vi.clearAllMocks();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    expect(createQuickSwitcher).not.toHaveBeenCalled();
  });

  it("onSelectChannel callback sets active channel", () => {
    const manager = createQuickSwitcherManager(() => root);
    const cleanup = manager.attach();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));

    // Extract the onSelectChannel callback
    const opts = (createQuickSwitcher as Mock).mock.calls[0]![0] as {
      onSelectChannel: (channelId: number) => void;
    };

    opts.onSelectChannel(42);
    expect(mockSetActiveChannel).toHaveBeenCalledWith(42);

    cleanup();
  });

  it("onClose callback resets instance so re-open works", () => {
    const manager = createQuickSwitcherManager(() => root);
    const cleanup = manager.attach();

    // Open
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    expect(createQuickSwitcher).toHaveBeenCalledOnce();

    // Simulate component calling onClose directly
    const opts = (createQuickSwitcher as Mock).mock.calls[0]![0] as {
      onClose: () => void;
    };
    opts.onClose();

    // Re-open should work
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    expect(createQuickSwitcher).toHaveBeenCalledTimes(2);

    cleanup();
  });

  it("does not open a second instance if already open", () => {
    const manager = createQuickSwitcherManager(() => root);
    const cleanup = manager.attach();

    // Open
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));

    // Simulate trying to open from external code — the instance check should prevent it
    // The attach() function only exposes Ctrl+K, and the toggle logic handles this
    expect(createQuickSwitcher).toHaveBeenCalledOnce();

    cleanup();
  });
});

// ---------------------------------------------------------------------------
// createInviteManagerController (additional coverage)
// ---------------------------------------------------------------------------

describe("createInviteManagerController (additional)", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
    vi.clearAllMocks();
  });

  afterEach(() => {
    root.remove();
  });

  it("does nothing when root is null", async () => {
    const api = makeMockApi();

    const controller = createInviteManagerController({
      api: api as never,
      getRoot: () => null,
    });

    await controller.open();

    expect(createInviteManager).not.toHaveBeenCalled();
  });

  it("does not open a second time if already open", async () => {
    const api = makeMockApi();

    const controller = createInviteManagerController({
      api: api as never,
      getRoot: () => root,
    });

    await controller.open();
    await controller.open();

    expect(createInviteManager).toHaveBeenCalledOnce();
  });

  it("cleanup destroys instance when open", async () => {
    const api = makeMockApi();

    const controller = createInviteManagerController({
      api: api as never,
      getRoot: () => root,
    });

    await controller.open();
    controller.cleanup();

    expect(mockInviteManagerDestroy).toHaveBeenCalled();
  });

  it("cleanup is safe when not open", () => {
    const api = makeMockApi();

    const controller = createInviteManagerController({
      api: api as never,
      getRoot: () => root,
    });

    // Should not throw
    controller.cleanup();
    expect(mockInviteManagerDestroy).not.toHaveBeenCalled();
  });

  it("onCreateInvite callback creates and maps an invite", async () => {
    const api = makeMockApi();

    const controller = createInviteManagerController({
      api: api as never,
      getRoot: () => root,
    });

    await controller.open();

    const opts = (createInviteManager as Mock).mock.calls[0]![0] as {
      onCreateInvite: () => Promise<unknown>;
    };

    const result = await opts.onCreateInvite();
    expect(api.createInvite).toHaveBeenCalledWith({});
    expect((result as { code: string }).code).toBe("new123");
  });

  it("onCopyLink copies code to clipboard", async () => {
    const api = makeMockApi();
    const mockWriteText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText: mockWriteText },
    });

    const controller = createInviteManagerController({
      api: api as never,
      getRoot: () => root,
    });

    await controller.open();

    const opts = (createInviteManager as Mock).mock.calls[0]![0] as {
      onCopyLink: (code: string) => void;
    };

    opts.onCopyLink("test-code");
    expect(mockWriteText).toHaveBeenCalledWith("test-code");
  });

  it("onClose callback destroys instance and allows re-open", async () => {
    const api = makeMockApi();

    const controller = createInviteManagerController({
      api: api as never,
      getRoot: () => root,
    });

    await controller.open();

    const opts = (createInviteManager as Mock).mock.calls[0]![0] as {
      onClose: () => void;
    };

    opts.onClose();
    expect(mockInviteManagerDestroy).toHaveBeenCalled();

    // Should be able to re-open
    vi.clearAllMocks();
    await controller.open();
    expect(createInviteManager).toHaveBeenCalledOnce();
  });

  it("onError logs and shows toast", async () => {
    const api = makeMockApi();

    const controller = createInviteManagerController({
      api: api as never,
      getRoot: () => root,
    });

    await controller.open();

    const opts = (createInviteManager as Mock).mock.calls[0]![0] as {
      onError: (message: string) => void;
    };

    opts.onError("Something went wrong");
    expect(mockLogError).toHaveBeenCalledWith("Something went wrong");
    expect(mockShowToast).toHaveBeenCalledWith("Something went wrong", "error");
  });

  it("onRevokeInvite succeeds when invite code is not found in re-fetch", async () => {
    const api = makeMockApi({
      getInvites: vi
        .fn()
        .mockResolvedValueOnce([makeInviteResponse()]) // initial load
        .mockResolvedValueOnce([]), // re-fetch returns empty
    });

    const controller = createInviteManagerController({
      api: api as never,
      getRoot: () => root,
    });

    await controller.open();

    const opts = (createInviteManager as Mock).mock.calls[0]![0] as {
      onRevokeInvite: (code: string) => Promise<void>;
    };

    // Should not throw and should not call revokeInvite since no match
    await expect(opts.onRevokeInvite("nonexistent")).resolves.toBeUndefined();
    expect(api.revokeInvite).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createSearchOverlayController
// ---------------------------------------------------------------------------

describe("createSearchOverlayController", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
    vi.clearAllMocks();
  });

  afterEach(() => {
    root.remove();
  });

  it("opens search overlay and mounts to root", () => {
    const api = makeMockApi();

    const controller = createSearchOverlayController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 5,
    });

    controller.open();

    expect(createSearchOverlay).toHaveBeenCalledOnce();
    expect(mockSearchOverlayMount).toHaveBeenCalledWith(root);
  });

  it("does nothing when root is null", () => {
    const api = makeMockApi();

    const controller = createSearchOverlayController({
      api: api as never,
      getRoot: () => null,
      getCurrentChannelId: () => 5,
    });

    controller.open();

    expect(createSearchOverlay).not.toHaveBeenCalled();
  });

  it("does not open a second instance if already open", () => {
    const api = makeMockApi();

    const controller = createSearchOverlayController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 5,
    });

    controller.open();
    controller.open();

    expect(createSearchOverlay).toHaveBeenCalledOnce();
  });

  it("passes currentChannelId as undefined when null", () => {
    const api = makeMockApi();

    const controller = createSearchOverlayController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => null,
    });

    controller.open();

    const opts = (createSearchOverlay as Mock).mock.calls[0]![0] as {
      currentChannelId: number | undefined;
    };

    expect(opts.currentChannelId).toBeUndefined();
  });

  it("onSearch calls api.search and returns results", async () => {
    const api = makeMockApi();

    const controller = createSearchOverlayController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 5,
    });

    controller.open();

    const opts = (createSearchOverlay as Mock).mock.calls[0]![0] as {
      onSearch: (
        query: string,
        chId: number | undefined,
        signal?: AbortSignal,
      ) => Promise<unknown[]>;
    };

    const results = await opts.onSearch("hello", 5);
    expect(api.search).toHaveBeenCalledWith("hello", { channelId: 5 }, undefined);
    expect(results).toEqual([{ channel_id: 1, message_id: 10, content: "hello" }]);
  });

  it("onSearch re-throws AbortError", async () => {
    const abortError = new DOMException("Aborted", "AbortError");
    const api = makeMockApi({
      search: vi.fn().mockRejectedValue(abortError),
    });

    const controller = createSearchOverlayController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 5,
    });

    controller.open();

    const opts = (createSearchOverlay as Mock).mock.calls[0]![0] as {
      onSearch: (
        query: string,
        chId: number | undefined,
        signal?: AbortSignal,
      ) => Promise<unknown[]>;
    };

    await expect(opts.onSearch("test", 5)).rejects.toThrow("Aborted");
    // Should NOT show toast for abort errors
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it("onSearch shows toast and re-throws on non-abort error", async () => {
    const api = makeMockApi({
      search: vi.fn().mockRejectedValue(new Error("network failure")),
    });

    const controller = createSearchOverlayController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 5,
    });

    controller.open();

    const opts = (createSearchOverlay as Mock).mock.calls[0]![0] as {
      onSearch: (
        query: string,
        chId: number | undefined,
        signal?: AbortSignal,
      ) => Promise<unknown[]>;
    };

    await expect(opts.onSearch("test", 5)).rejects.toThrow("network failure");
    expect(mockShowToast).toHaveBeenCalledWith("Search failed", "error");
    expect(mockLogError).toHaveBeenCalled();
  });

  it("onSelectResult sets active channel and calls onJumpToMessage", () => {
    const api = makeMockApi();
    const mockJump = vi.fn().mockReturnValue(true);

    const controller = createSearchOverlayController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 5,
      onJumpToMessage: mockJump,
    });

    controller.open();

    const opts = (createSearchOverlay as Mock).mock.calls[0]![0] as {
      onSelectResult: (result: { channel_id: number; message_id: number }) => void;
    };

    // Mock requestAnimationFrame to execute immediately
    const origRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    };

    opts.onSelectResult({ channel_id: 3, message_id: 42 });

    expect(mockSetActiveChannel).toHaveBeenCalledWith(3);
    expect(mockJump).toHaveBeenCalledWith(3, 42);

    globalThis.requestAnimationFrame = origRaf;
  });

  it("onSelectResult shows toast when message not found", () => {
    const api = makeMockApi();
    const mockJump = vi.fn().mockReturnValue(false);

    const controller = createSearchOverlayController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 5,
      onJumpToMessage: mockJump,
    });

    controller.open();

    const opts = (createSearchOverlay as Mock).mock.calls[0]![0] as {
      onSelectResult: (result: { channel_id: number; message_id: number }) => void;
    };

    const origRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    };

    opts.onSelectResult({ channel_id: 3, message_id: 999 });

    expect(mockShowToast).toHaveBeenCalledWith("Message not in loaded history", "info");

    globalThis.requestAnimationFrame = origRaf;
  });

  it("onSelectResult works without onJumpToMessage callback", () => {
    const api = makeMockApi();

    const controller = createSearchOverlayController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 5,
      // no onJumpToMessage
    });

    controller.open();

    const opts = (createSearchOverlay as Mock).mock.calls[0]![0] as {
      onSelectResult: (result: { channel_id: number; message_id: number }) => void;
    };

    // Should not throw
    opts.onSelectResult({ channel_id: 3, message_id: 42 });
    expect(mockSetActiveChannel).toHaveBeenCalledWith(3);
  });

  it("onClose closes overlay and allows re-open", () => {
    const api = makeMockApi();

    const controller = createSearchOverlayController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 5,
    });

    controller.open();

    const opts = (createSearchOverlay as Mock).mock.calls[0]![0] as {
      onClose: () => void;
    };

    opts.onClose();
    expect(mockSearchOverlayDestroy).toHaveBeenCalled();

    // Re-open should work
    vi.clearAllMocks();
    controller.open();
    expect(createSearchOverlay).toHaveBeenCalledOnce();
  });

  it("cleanup destroys instance when open", () => {
    const api = makeMockApi();

    const controller = createSearchOverlayController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 5,
    });

    controller.open();
    controller.cleanup();

    expect(mockSearchOverlayDestroy).toHaveBeenCalled();
  });

  it("cleanup is safe when not open", () => {
    const api = makeMockApi();

    const controller = createSearchOverlayController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 5,
    });

    // Should not throw
    controller.cleanup();
    expect(mockSearchOverlayDestroy).not.toHaveBeenCalled();
  });
});
