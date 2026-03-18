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
} = vi.hoisted(() => ({
  mockLogError: vi.fn(),
  mockInviteManagerMount: vi.fn(),
  mockInviteManagerDestroy: vi.fn(),
  mockPinnedMessagesMount: vi.fn(),
  mockPinnedMessagesDestroy: vi.fn(),
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
    mount: vi.fn(),
    destroy: vi.fn(),
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

vi.mock("@stores/channels.store", () => ({
  setActiveChannel: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { createInviteManager } from "@components/InviteManager";
import { createPinnedMessages } from "@components/PinnedMessages";
import {
  createInviteManagerController,
  createPinnedPanelController,
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
      getToast: () => toast as never,
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
      getToast: () => toast as never,
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
      getToast: () => toast as never,
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
      getToast: () => toast as never,
    });

    await controller.open();

    expect(toast.show).toHaveBeenCalledWith("Failed to load invites", "error");
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
      getToast: () => toast as never,
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
      getToast: () => toast as never,
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
      expect(toast.show).toHaveBeenCalledWith("Failed to unpin message", "error");
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
      getToast: () => toast as never,
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
    expect(toast.show).not.toHaveBeenCalled();
  });

  it("onJumpToMessage calls provided scroll callback and closes panel", async () => {
    const api = makeMockApi();
    const toast = makeMockToast();
    const mockScrollToMessage = vi.fn().mockReturnValue(true);

    const controller = createPinnedPanelController({
      api: api as never,
      getRoot: () => root,
      getToast: () => toast as never,
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
      getToast: () => toast as never,
      getCurrentChannelId: () => 42,
      onJumpToMessage: mockScrollToMessage,
    });

    await controller.toggle();

    const opts = (createPinnedMessages as Mock).mock.calls[0]![0] as {
      onJumpToMessage: (msgId: number) => void;
    };

    opts.onJumpToMessage(999);

    expect(mockScrollToMessage).toHaveBeenCalledWith(999);
    expect(toast.show).toHaveBeenCalledWith(
      expect.stringContaining("not in"),
      "info",
    );
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
      getToast: () => toast as never,
      getCurrentChannelId: () => 42,
    });

    await controller.toggle();

    expect(toast.show).toHaveBeenCalledWith("Failed to load pinned messages", "error");
  });
});
