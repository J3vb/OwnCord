import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const {
  mockSetMessages,
  mockPrependMessages,
  mockIsChannelLoaded,
  mockGetChannelMessages,
  mockSetChannelLoading,
  mockSetChannelLoadError,
} = vi.hoisted(() => ({
  mockSetMessages: vi.fn(),
  mockPrependMessages: vi.fn(),
  mockIsChannelLoaded: vi.fn((): boolean => false),
  mockGetChannelMessages: vi.fn((): Array<{ id: number; content?: string }> => []),
  mockSetChannelLoading: vi.fn(),
  mockSetChannelLoadError: vi.fn(),
}));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("@stores/messages.store", () => ({
  setMessages: mockSetMessages,
  prependMessages: mockPrependMessages,
  isChannelLoaded: mockIsChannelLoaded,
  getChannelMessages: mockGetChannelMessages,
  setChannelLoading: mockSetChannelLoading,
  setChannelLoadError: mockSetChannelLoadError,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  createMessageController,
  createPendingDeleteManager,
} from "../../src/pages/main-page/MessageController";
import type { MessageControllerOptions } from "../../src/pages/main-page/MessageController";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApi(overrides: Partial<MessageControllerOptions["api"]> = {}) {
  return {
    getMessages: vi.fn().mockResolvedValue({
      messages: [{ id: 1, content: "hi" }],
      has_more: false,
    }),
    ...overrides,
  } as unknown as MessageControllerOptions["api"];
}

function makeAbort(): { signal: AbortSignal; abort: () => void } {
  const ctrl = new AbortController();
  return { signal: ctrl.signal, abort: () => ctrl.abort() };
}

// ---------------------------------------------------------------------------
// MessageController
// ---------------------------------------------------------------------------

describe("createMessageController", () => {
  let showError: Mock<(msg: string) => void>;

  beforeEach(() => {
    vi.clearAllMocks();
    showError = vi.fn<(msg: string) => void>();
    mockIsChannelLoaded.mockReturnValue(false);
    mockGetChannelMessages.mockReturnValue([]);
  });

  describe("loadMessages", () => {
    it("loads messages and stores them", async () => {
      const api = makeApi();
      const ctrl = createMessageController({ api, showError });
      const { signal } = makeAbort();

      await ctrl.loadMessages(42, signal);

      expect(api.getMessages).toHaveBeenCalledWith(42, { limit: 50 }, signal);
      expect(mockSetMessages).toHaveBeenCalledWith(42, [{ id: 1, content: "hi" }], false);
    });

    it("marks the channel loading before the fetch resolves", async () => {
      const api = makeApi();
      const ctrl = createMessageController({ api, showError });

      const pending = ctrl.loadMessages(42, makeAbort().signal);

      // Synchronous prefix: the loading placeholder is visible from the
      // first render, before the first await.
      expect(mockSetChannelLoading).toHaveBeenCalledWith(42);
      await pending;
    });

    it("skips fetch when channel is already loaded", async () => {
      mockIsChannelLoaded.mockReturnValue(true);
      const api = makeApi();
      const ctrl = createMessageController({ api, showError });

      await ctrl.loadMessages(42, makeAbort().signal);

      expect(api.getMessages).not.toHaveBeenCalled();
      expect(mockSetMessages).not.toHaveBeenCalled();
      expect(mockSetChannelLoading).not.toHaveBeenCalled();
    });

    it("does not store messages after abort", async () => {
      const { signal, abort } = makeAbort();
      const api = makeApi({
        getMessages: vi.fn().mockImplementation(async () => {
          abort();
          return { messages: [{ id: 1 }], has_more: false };
        }),
      });
      const ctrl = createMessageController({ api, showError });

      await ctrl.loadMessages(42, signal);

      expect(mockSetMessages).not.toHaveBeenCalled();
    });

    it("marks the channel load-errored on fetch failure (inline error, not a toast)", async () => {
      const api = makeApi({
        getMessages: vi.fn().mockRejectedValue(new Error("network error")),
      });
      const ctrl = createMessageController({ api, showError });

      await ctrl.loadMessages(42, makeAbort().signal);

      // The region renders an inline error + Retry (UX spec §2); no toast.
      expect(mockSetChannelLoadError).toHaveBeenCalledWith(42);
      expect(showError).not.toHaveBeenCalled();
    });

    it("falls back to a toast on failure when the channel already has rows", async () => {
      // Live broadcasts or an optimistic send can populate a channel before
      // history loads; the inline region won't render then, so the failure
      // must surface as a toast instead of silently.
      mockGetChannelMessages.mockReturnValue([{ id: 5, content: "live row" }]);
      const api = makeApi({
        getMessages: vi.fn().mockRejectedValue(new Error("network error")),
      });
      const ctrl = createMessageController({ api, showError });

      await ctrl.loadMessages(42, makeAbort().signal);

      expect(mockSetChannelLoadError).toHaveBeenCalledWith(42);
      expect(showError).toHaveBeenCalledWith("Failed to load message history");
    });

    it("does not mark an error when aborted before failure", async () => {
      const { signal, abort } = makeAbort();
      abort();
      const api = makeApi({
        getMessages: vi.fn().mockRejectedValue(new Error("aborted")),
      });
      const ctrl = createMessageController({ api, showError });

      await ctrl.loadMessages(42, signal);

      expect(mockSetChannelLoadError).not.toHaveBeenCalled();
      expect(showError).not.toHaveBeenCalled();
    });

    it("discards a stale tail response if the channel was loaded by something else while the fetch was in flight (e.g. a same-channel jump's around-window)", async () => {
      // Not loaded when the fetch starts (so it proceeds), but loaded by the
      // time it resolves — simulating MessageJump's setAroundMessages winning
      // the race and installing a window this response must not clobber.
      mockIsChannelLoaded.mockReturnValueOnce(false).mockReturnValueOnce(true);
      const api = makeApi();
      const ctrl = createMessageController({ api, showError });

      await ctrl.loadMessages(42, makeAbort().signal);

      expect(mockSetMessages).not.toHaveBeenCalled();
    });
  });

  describe("loadOlderMessages", () => {
    it("prepends older messages using oldest id", async () => {
      mockGetChannelMessages.mockReturnValue([
        { id: 10, content: "oldest" },
        { id: 20, content: "newest" },
      ]);
      const api = makeApi({
        getMessages: vi.fn().mockResolvedValue({
          messages: [{ id: 5, content: "older" }],
          has_more: true,
        }),
      });
      const ctrl = createMessageController({ api, showError });
      const { signal } = makeAbort();

      await ctrl.loadOlderMessages(42, signal);

      expect(api.getMessages).toHaveBeenCalledWith(42, { before: 10, limit: 50 }, signal);
      expect(mockPrependMessages).toHaveBeenCalledWith(42, [{ id: 5, content: "older" }], true);
    });

    it("does nothing when channel has no messages", async () => {
      mockGetChannelMessages.mockReturnValue([]);
      const api = makeApi();
      const ctrl = createMessageController({ api, showError });

      await ctrl.loadOlderMessages(42, makeAbort().signal);

      expect(api.getMessages).not.toHaveBeenCalled();
    });

    it("shows error on fetch failure", async () => {
      mockGetChannelMessages.mockReturnValue([{ id: 1 }]);
      const api = makeApi({
        getMessages: vi.fn().mockRejectedValue(new Error("fail")),
      });
      const ctrl = createMessageController({ api, showError });

      await ctrl.loadOlderMessages(42, makeAbort().signal);

      expect(showError).toHaveBeenCalledWith("Failed to load older messages");
    });

    it("does not show error when aborted before failure", async () => {
      mockGetChannelMessages.mockReturnValue([{ id: 1 }]);
      const { signal, abort } = makeAbort();
      abort();
      const api = makeApi({
        getMessages: vi.fn().mockRejectedValue(new Error("aborted")),
      });
      const ctrl = createMessageController({ api, showError });

      await ctrl.loadOlderMessages(42, signal);

      expect(showError).not.toHaveBeenCalled();
    });

    it("does not prepend after abort", async () => {
      mockGetChannelMessages.mockReturnValue([{ id: 1 }]);
      const { signal, abort } = makeAbort();
      const api = makeApi({
        getMessages: vi.fn().mockImplementation(async () => {
          abort();
          return { messages: [{ id: 0 }], has_more: false };
        }),
      });
      const ctrl = createMessageController({ api, showError });

      await ctrl.loadOlderMessages(42, signal);

      expect(mockPrependMessages).not.toHaveBeenCalled();
    });

    it("discards a stale older-page if the window was replaced while the fetch was in flight (e.g. a same-channel jump swapped in an around-window)", async () => {
      // First read (before the fetch): oldest visible row is id 10. Second
      // read (after the await resolves): the window has already been
      // replaced — id 10 is no longer at the front — so splicing this page
      // onto it would duplicate/misorder rows.
      mockGetChannelMessages
        .mockReturnValueOnce([
          { id: 10, content: "oldest" },
          { id: 20, content: "newest" },
        ])
        .mockReturnValueOnce([
          { id: 77, content: "replaced" },
          { id: 78, content: "replaced2" },
        ]);
      const api = makeApi({
        getMessages: vi.fn().mockResolvedValue({
          messages: [{ id: 5, content: "older" }],
          has_more: true,
        }),
      });
      const ctrl = createMessageController({ api, showError });

      await ctrl.loadOlderMessages(42, makeAbort().signal);

      expect(mockPrependMessages).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// PendingDeleteManager
// ---------------------------------------------------------------------------

describe("createPendingDeleteManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("returns 'pending' on first click", () => {
    const mgr = createPendingDeleteManager();
    expect(mgr.tryDelete(1)).toBe("pending");
  });

  it("returns 'confirmed' on second click within timeout", () => {
    const mgr = createPendingDeleteManager();
    mgr.tryDelete(1);
    expect(mgr.tryDelete(1)).toBe("confirmed");
  });

  it("returns 'pending' again after timeout expires", () => {
    const mgr = createPendingDeleteManager();
    mgr.tryDelete(1);
    vi.advanceTimersByTime(5001); // just past the 5000ms pending timeout
    expect(mgr.tryDelete(1)).toBe("pending");
  });

  it("tracks multiple messages independently", () => {
    const mgr = createPendingDeleteManager();
    mgr.tryDelete(1);
    mgr.tryDelete(2);
    expect(mgr.tryDelete(1)).toBe("confirmed");
    expect(mgr.tryDelete(2)).toBe("confirmed");
  });

  it("cleanup clears all pending timeouts", () => {
    const mgr = createPendingDeleteManager();
    mgr.tryDelete(1);
    mgr.tryDelete(2);
    mgr.cleanup();
    // After cleanup, both should be fresh "pending" again
    expect(mgr.tryDelete(1)).toBe("pending");
    expect(mgr.tryDelete(2)).toBe("pending");
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});
