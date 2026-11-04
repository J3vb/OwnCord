import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import * as logMock from "../helpers/loggerMock";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const {
  mockSetMessages,
  mockPrependMessages,
  mockAppendNewerMessages,
  mockMergeTailMessages,
  mockInvalidateChannelMessageWindow,
  mockIsChannelLoaded,
  mockGetChannelMessages,
  mockSetChannelLoading,
  mockSetChannelLoadError,
  mockSetOlderLoadFailed,
  mockIsWindowDetached,
} = vi.hoisted(() => ({
  mockSetMessages: vi.fn(),
  mockPrependMessages: vi.fn(),
  mockAppendNewerMessages: vi.fn(),
  mockMergeTailMessages: vi.fn(),
  mockInvalidateChannelMessageWindow: vi.fn(),
  mockIsChannelLoaded: vi.fn((): boolean => false),
  mockGetChannelMessages: vi.fn((): Array<{ id: number; content?: string }> => []),
  mockSetChannelLoading: vi.fn(),
  mockSetChannelLoadError: vi.fn(),
  mockSetOlderLoadFailed: vi.fn(),
  mockIsWindowDetached: vi.fn((): boolean => false),
}));

vi.mock("@lib/logger", () => logMock.loggerMock());

vi.mock("@stores/messages.store", () => ({
  setMessages: mockSetMessages,
  prependMessages: mockPrependMessages,
  appendNewerMessages: mockAppendNewerMessages,
  mergeTailMessages: mockMergeTailMessages,
  invalidateChannelMessageWindow: mockInvalidateChannelMessageWindow,
  isChannelLoaded: mockIsChannelLoaded,
  getChannelMessages: mockGetChannelMessages,
  setChannelLoading: mockSetChannelLoading,
  setChannelLoadError: mockSetChannelLoadError,
  setOlderLoadFailed: mockSetOlderLoadFailed,
  isWindowDetached: mockIsWindowDetached,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { createMessageController } from "../../src/pages/main-page/MessageController";
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

  function makeController(overrides: Partial<MessageControllerOptions["api"]> = {}) {
    const api = makeApi(overrides);
    return { api, ctrl: createMessageController({ api, showError }) };
  }

  describe("loadMessages", () => {
    it("loads messages and stores them", async () => {
      const { api, ctrl } = makeController();
      const { signal } = makeAbort();

      await ctrl.loadMessages(42, signal);

      expect(api.getMessages).toHaveBeenCalledWith(42, { limit: 50 }, signal);
      expect(mockSetMessages).toHaveBeenCalledWith(42, [{ id: 1, content: "hi" }], false);
    });

    it("marks the channel loading before the fetch resolves", async () => {
      const { ctrl } = makeController();

      const pending = ctrl.loadMessages(42, makeAbort().signal);

      // Synchronous prefix: the loading placeholder is visible from the
      // first render, before the first await.
      expect(mockSetChannelLoading).toHaveBeenCalledWith(42);
      await pending;
    });

    it("skips fetch when channel is already loaded", async () => {
      mockIsChannelLoaded.mockReturnValue(true);
      const { api, ctrl } = makeController();

      await ctrl.loadMessages(42, makeAbort().signal);

      expect(api.getMessages).not.toHaveBeenCalled();
      expect(mockSetMessages).not.toHaveBeenCalled();
      expect(mockSetChannelLoading).not.toHaveBeenCalled();
    });

    it("does not store messages after abort", async () => {
      const { signal, abort } = makeAbort();
      const { ctrl } = makeController({
        getMessages: vi.fn().mockImplementation(async () => {
          abort();
          return { messages: [{ id: 1 }], has_more: false };
        }),
      });

      await ctrl.loadMessages(42, signal);

      expect(mockSetMessages).not.toHaveBeenCalled();
    });

    it("marks the channel load-errored on fetch failure (inline error, not a toast)", async () => {
      const { ctrl } = makeController({
        getMessages: vi.fn().mockRejectedValue(new Error("network error")),
      });

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
      const { ctrl } = makeController({
        getMessages: vi.fn().mockRejectedValue(new Error("network error")),
      });

      await ctrl.loadMessages(42, makeAbort().signal);

      expect(mockSetChannelLoadError).toHaveBeenCalledWith(42);
      expect(showError).toHaveBeenCalledWith("Failed to load message history");
    });

    it("does not mark an error when aborted before failure", async () => {
      const { signal, abort } = makeAbort();
      abort();
      const { ctrl } = makeController({
        getMessages: vi.fn().mockRejectedValue(new Error("aborted")),
      });

      await ctrl.loadMessages(42, signal);

      expect(mockSetChannelLoadError).not.toHaveBeenCalled();
      expect(showError).not.toHaveBeenCalled();
    });

    it("discards a stale tail response if the channel was loaded by something else while the fetch was in flight (e.g. a same-channel jump's around-window)", async () => {
      // Not loaded when the fetch starts (so it proceeds), but loaded by the
      // time it resolves — simulating MessageJump's setAroundMessages winning
      // the race and installing a window this response must not clobber.
      mockIsChannelLoaded.mockReturnValueOnce(false).mockReturnValueOnce(true);
      const { ctrl } = makeController();

      await ctrl.loadMessages(42, makeAbort().signal);

      expect(mockSetMessages).not.toHaveBeenCalled();
    });

    it("does not mark load-errored or toast when a stale tail fetch rejects after the channel was loaded by something else (e.g. a same-channel jump's around-window won the race)", async () => {
      // Not loaded when the fetch starts (so it proceeds past the early
      // return), but loaded by the time it rejects — simulating
      // MessageJump.jumpTo's setAroundMessages winning the race and
      // rendering the jump target while this mount-time tail fetch is still
      // in flight. The window it installed has rows, matching the real
      // repro where the user already sees a fully-loaded, correct channel.
      mockIsChannelLoaded.mockReturnValueOnce(false).mockReturnValueOnce(true);
      mockGetChannelMessages.mockReturnValue([{ id: 5, content: "around window row" }]);
      const { ctrl } = makeController({
        getMessages: vi.fn().mockRejectedValue(new Error("network error")),
      });

      await ctrl.loadMessages(42, makeAbort().signal);

      // The jump already succeeded and rendered correctly — a losing tail
      // fetch must not retroactively flag the channel load-errored or pop an
      // error toast on top of a visibly-working jump.
      expect(mockSetChannelLoadError).not.toHaveBeenCalled();
      expect(showError).not.toHaveBeenCalled();
    });
  });

  describe("loadNewerMessages", () => {
    it("fetches the page after the newest delivered row and appends it", async () => {
      mockIsWindowDetached.mockReturnValue(true);
      mockGetChannelMessages.mockReturnValue([
        { id: 10, content: "a" },
        { id: 20, content: "b" },
        { id: 0, content: "pending optimistic row" },
      ]);
      const page = [{ id: 21, content: "c" }];
      const { api, ctrl } = makeController({
        getMessages: vi.fn().mockResolvedValue({ messages: page, has_more: true }),
      });
      const { signal } = makeAbort();

      await ctrl.loadNewerMessages(42, signal);

      expect(api.getMessages).toHaveBeenCalledWith(42, { after: 20, limit: 50 }, signal);
      expect(mockAppendNewerMessages).toHaveBeenCalledWith(42, page, true);
    });

    it("passes has_more false through so the store can reattach", async () => {
      mockIsWindowDetached.mockReturnValue(true);
      mockGetChannelMessages.mockReturnValue([{ id: 20 }]);
      const { api, ctrl } = makeController({
        getMessages: vi.fn().mockResolvedValue({ messages: [], has_more: false }),
      });
      const { signal } = makeAbort();

      await ctrl.loadNewerMessages(42, signal);

      expect(mockAppendNewerMessages).toHaveBeenCalledWith(42, [], false);
      // One follow-up tail fetch after the re-attach, from the start id when
      // the final page was empty.
      expect(api.getMessages).toHaveBeenLastCalledWith(42, { after: 20, limit: 50 }, signal);
      expect(mockMergeTailMessages).toHaveBeenCalledWith(42, []);
    });

    it("falls back to a tail reload when the follow-up has more", async () => {
      mockIsWindowDetached.mockReturnValue(true);
      mockGetChannelMessages.mockReturnValue([{ id: 20 }]);
      const getMessages = vi
        .fn()
        .mockResolvedValueOnce({ messages: [{ id: 21 }], has_more: false })
        .mockResolvedValue({ messages: [{ id: 22 }], has_more: true });
      const ctrl = createMessageController({ api: makeApi({ getMessages }), showError });

      await ctrl.loadNewerMessages(42, makeAbort().signal);

      expect(getMessages).toHaveBeenNthCalledWith(
        2,
        42,
        { after: 21, limit: 50 },
        expect.anything(),
      );
      expect(mockMergeTailMessages).not.toHaveBeenCalled();
      expect(mockInvalidateChannelMessageWindow).toHaveBeenCalledWith(42);
    });

    it("skips the follow-up when more pages remain", async () => {
      mockIsWindowDetached.mockReturnValue(true);
      mockGetChannelMessages.mockReturnValue([{ id: 20 }]);
      const { api, ctrl } = makeController({
        getMessages: vi.fn().mockResolvedValue({ messages: [{ id: 21 }], has_more: true }),
      });

      await ctrl.loadNewerMessages(42, makeAbort().signal);

      expect(api.getMessages).toHaveBeenCalledTimes(1);
      expect(mockMergeTailMessages).not.toHaveBeenCalled();
    });

    it("does nothing for an attached window or an empty one", async () => {
      const { api, ctrl } = makeController();

      mockIsWindowDetached.mockReturnValue(false);
      mockGetChannelMessages.mockReturnValue([{ id: 20 }]);
      await ctrl.loadNewerMessages(42, makeAbort().signal);
      mockIsWindowDetached.mockReturnValue(true);
      mockGetChannelMessages.mockReturnValue([]);
      await ctrl.loadNewerMessages(42, makeAbort().signal);

      expect(api.getMessages).not.toHaveBeenCalled();
    });

    it("drops the page when the window was replaced while the fetch was in flight", async () => {
      mockIsWindowDetached.mockReturnValue(true);
      // Before the fetch the window ends at 20; by the time it resolves a new
      // jump has swapped in a window ending at 900.
      mockGetChannelMessages
        .mockReturnValueOnce([{ id: 20 }])
        .mockReturnValueOnce([{ id: 880 }, { id: 900 }]);
      const { ctrl } = makeController({
        getMessages: vi.fn().mockResolvedValue({ messages: [{ id: 21 }], has_more: true }),
      });

      await ctrl.loadNewerMessages(42, makeAbort().signal);

      expect(mockAppendNewerMessages).not.toHaveBeenCalled();
    });

    it("drops the page when the window reattached while the fetch was in flight", async () => {
      mockGetChannelMessages.mockReturnValue([{ id: 20 }]);
      mockIsWindowDetached.mockReturnValueOnce(true).mockReturnValueOnce(false);
      const { ctrl } = makeController({
        getMessages: vi.fn().mockResolvedValue({ messages: [{ id: 21 }], has_more: false }),
      });

      await ctrl.loadNewerMessages(42, makeAbort().signal);

      expect(mockAppendNewerMessages).not.toHaveBeenCalled();
    });

    it("drops the page after abort (channel switch)", async () => {
      mockIsWindowDetached.mockReturnValue(true);
      mockGetChannelMessages.mockReturnValue([{ id: 20 }]);
      const { signal, abort } = makeAbort();
      const { ctrl } = makeController({
        getMessages: vi.fn().mockImplementation(async () => {
          abort();
          return { messages: [{ id: 21 }], has_more: true };
        }),
      });

      await ctrl.loadNewerMessages(42, signal);

      expect(mockAppendNewerMessages).not.toHaveBeenCalled();
    });

    it("shows an error on failure, but not when aborted", async () => {
      mockIsWindowDetached.mockReturnValue(true);
      mockGetChannelMessages.mockReturnValue([{ id: 20 }]);
      const { ctrl } = makeController({
        getMessages: vi.fn().mockRejectedValue(new Error("fail")),
      });

      await ctrl.loadNewerMessages(42, makeAbort().signal);
      expect(showError).toHaveBeenCalledWith("Failed to load newer messages");

      showError.mockClear();
      const { signal, abort } = makeAbort();
      abort();
      await ctrl.loadNewerMessages(42, signal);
      expect(showError).not.toHaveBeenCalled();
    });
  });

  describe("loadOlderMessages", () => {
    it("prepends older messages using oldest id", async () => {
      mockGetChannelMessages.mockReturnValue([
        { id: 10, content: "oldest" },
        { id: 20, content: "newest" },
      ]);
      const { api, ctrl } = makeController({
        getMessages: vi.fn().mockResolvedValue({
          messages: [{ id: 5, content: "older" }],
          has_more: true,
        }),
      });
      const { signal } = makeAbort();

      await ctrl.loadOlderMessages(42, signal);

      expect(api.getMessages).toHaveBeenCalledWith(42, { before: 10, limit: 50 }, signal);
      expect(mockPrependMessages).toHaveBeenCalledWith(42, [{ id: 5, content: "older" }], true);
    });

    it("does nothing when channel has no messages", async () => {
      mockGetChannelMessages.mockReturnValue([]);
      const { api, ctrl } = makeController();

      await ctrl.loadOlderMessages(42, makeAbort().signal);

      expect(api.getMessages).not.toHaveBeenCalled();
    });

    it("flags the channel's older page as failed on fetch failure, without a toast", async () => {
      mockGetChannelMessages.mockReturnValue([{ id: 1 }]);
      const { ctrl } = makeController({
        getMessages: vi.fn().mockRejectedValue(new Error("fail")),
      });

      await ctrl.loadOlderMessages(42, makeAbort().signal);

      expect(mockSetOlderLoadFailed).toHaveBeenCalledWith(42, true);
      expect(showError).not.toHaveBeenCalled();
    });

    it("clears the failed flag when a later older page succeeds (a Retry)", async () => {
      mockGetChannelMessages.mockReturnValue([{ id: 1 }]);
      const { ctrl } = makeController();

      await ctrl.loadOlderMessages(42, makeAbort().signal);

      expect(mockSetOlderLoadFailed).toHaveBeenCalledWith(42, false);
      expect(mockSetOlderLoadFailed).not.toHaveBeenCalledWith(42, true);
    });

    it("sets no flag when the window was replaced (a jump) while the fetch was in flight", async () => {
      mockGetChannelMessages.mockReturnValueOnce([{ id: 10 }]);
      // The jump swaps in an around-window whose oldest row differs.
      mockGetChannelMessages.mockReturnValue([{ id: 500 }]);
      const { ctrl } = makeController({
        getMessages: vi.fn().mockRejectedValue(new Error("fail")),
      });

      await ctrl.loadOlderMessages(42, makeAbort().signal);

      expect(mockSetOlderLoadFailed).not.toHaveBeenCalledWith(42, true);
    });

    it("sets no flag when the failed fetch was aborted", async () => {
      mockGetChannelMessages.mockReturnValue([{ id: 1 }]);
      const { signal, abort } = makeAbort();
      abort();
      const { ctrl } = makeController({
        getMessages: vi.fn().mockRejectedValue(new Error("aborted")),
      });

      await ctrl.loadOlderMessages(42, signal);

      expect(mockSetOlderLoadFailed).not.toHaveBeenCalled();
    });

    it("mounting a channel clears an older-page failure left by an earlier visit", async () => {
      mockIsChannelLoaded.mockReturnValue(true);
      const ctrl = createMessageController({ api: makeApi(), showError });

      await ctrl.loadMessages(42, makeAbort().signal);

      expect(mockSetOlderLoadFailed).toHaveBeenCalledWith(42, false);
    });

    it("does not show error when aborted before failure", async () => {
      mockGetChannelMessages.mockReturnValue([{ id: 1 }]);
      const { signal, abort } = makeAbort();
      abort();
      const { ctrl } = makeController({
        getMessages: vi.fn().mockRejectedValue(new Error("aborted")),
      });

      await ctrl.loadOlderMessages(42, signal);

      expect(showError).not.toHaveBeenCalled();
    });

    it("does not prepend after abort", async () => {
      mockGetChannelMessages.mockReturnValue([{ id: 1 }]);
      const { signal, abort } = makeAbort();
      const { ctrl } = makeController({
        getMessages: vi.fn().mockImplementation(async () => {
          abort();
          return { messages: [{ id: 0 }], has_more: false };
        }),
      });

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
      const { ctrl } = makeController({
        getMessages: vi.fn().mockResolvedValue({
          messages: [{ id: 5, content: "older" }],
          has_more: true,
        }),
      });

      await ctrl.loadOlderMessages(42, makeAbort().signal);

      expect(mockPrependMessages).not.toHaveBeenCalled();
    });
  });
});
