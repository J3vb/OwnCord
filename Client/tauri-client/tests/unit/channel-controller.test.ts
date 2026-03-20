import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const {
  mockMessageListMount,
  mockMessageListDestroy,
  mockMessageInputMount,
  mockMessageInputDestroy,
  mockTypingMount,
  mockTypingDestroy,
  mockGetChannelMessages,
  mockSetReplyTo,
  mockStartEdit,
  mockScrollToMessage,
} = vi.hoisted(() => ({
  mockMessageListMount: vi.fn(),
  mockMessageListDestroy: vi.fn(),
  mockMessageInputMount: vi.fn(),
  mockMessageInputDestroy: vi.fn(),
  mockTypingMount: vi.fn(),
  mockTypingDestroy: vi.fn(),
  mockGetChannelMessages: vi.fn((): Array<{ id: number; content?: string; user?: { id: number; username: string } }> => []),
  mockSetReplyTo: vi.fn(),
  mockStartEdit: vi.fn(),
  mockScrollToMessage: vi.fn(() => true),
}));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

vi.mock("@lib/dom", () => ({
  createElement: vi.fn((tag: string) => document.createElement(tag)),
  clearChildren: vi.fn((el: HTMLElement) => { el.innerHTML = ""; }),
  setText: vi.fn((el: HTMLElement, text: string) => { el.textContent = text; }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- captured from mock factory, typed at call sites
let capturedMessageListOpts: any = null;
let capturedMessageInputOpts: any = null;

vi.mock("@components/MessageList", () => ({
  createMessageList: vi.fn((opts: any) => {
    capturedMessageListOpts = opts;
    return {
      mount: mockMessageListMount,
      destroy: mockMessageListDestroy,
      scrollToMessage: mockScrollToMessage,
      setReplyTo: mockSetReplyTo,
    };
  }),
}));

vi.mock("@components/MessageInput", () => ({
  createMessageInput: vi.fn((opts: any) => {
    capturedMessageInputOpts = opts;
    return {
      mount: mockMessageInputMount,
      destroy: mockMessageInputDestroy,
      setReplyTo: mockSetReplyTo,
      startEdit: mockStartEdit,
    };
  }),
}));

vi.mock("@components/TypingIndicator", () => ({
  createTypingIndicator: vi.fn(() => ({
    mount: mockTypingMount,
    destroy: mockTypingDestroy,
  })),
}));

vi.mock("@stores/messages.store", () => ({
  getChannelMessages: mockGetChannelMessages,
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { createChannelController } from "../../src/pages/main-page/ChannelController";
import type { ChannelControllerOptions } from "../../src/pages/main-page/ChannelController";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSlots(): ChannelControllerOptions["slots"] {
  return {
    messagesSlot: document.createElement("div") as HTMLDivElement,
    typingSlot: document.createElement("div") as HTMLDivElement,
    inputSlot: document.createElement("div") as HTMLDivElement,
  };
}

function makeOpts(overrides: Partial<ChannelControllerOptions> = {}): ChannelControllerOptions {
  return {
    ws: { send: vi.fn(), getState: vi.fn(() => "connected") } as unknown as ChannelControllerOptions["ws"],
    api: { uploadFile: vi.fn().mockResolvedValue({ id: 1, url: "/f/1", filename: "f.txt" }) } as unknown as ChannelControllerOptions["api"],
    msgCtrl: { loadMessages: vi.fn(), loadOlderMessages: vi.fn() } as unknown as ChannelControllerOptions["msgCtrl"],
    pendingDeleteManager: { tryDelete: vi.fn(() => "pending" as const), cleanup: vi.fn() },
    reactionCtrl: { handleReaction: vi.fn(), destroy: vi.fn() } as unknown as ChannelControllerOptions["reactionCtrl"],
    typingLimiter: { tryConsume: vi.fn(() => true) },
    showToast: vi.fn(),
    getCurrentUserId: () => 1,
    slots: makeSlots(),
    chatHeaderName: document.createElement("span"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createChannelController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedMessageListOpts = null;
    capturedMessageInputOpts = null;
  });

  it("starts with no channel mounted", () => {
    const ctrl = createChannelController(makeOpts());
    expect(ctrl.currentChannelId).toBeNull();
    expect(ctrl.messageList).toBeNull();
  });

  it("mounts channel components", () => {
    const opts = makeOpts();
    const ctrl = createChannelController(opts);

    ctrl.mountChannel(42, "general");

    expect(ctrl.currentChannelId).toBe(42);
    expect(ctrl.messageList).not.toBeNull();
    expect(mockMessageListMount).toHaveBeenCalledWith(opts.slots.messagesSlot);
    expect(mockMessageInputMount).toHaveBeenCalledWith(opts.slots.inputSlot);
    expect(mockTypingMount).toHaveBeenCalledWith(opts.slots.typingSlot);
  });

  it("sends channel_focus on mount", () => {
    const opts = makeOpts();
    const ctrl = createChannelController(opts);

    ctrl.mountChannel(42, "general");

    expect(opts.ws.send).toHaveBeenCalledWith({
      type: "channel_focus",
      payload: { channel_id: 42 },
    });
  });

  it("loads messages on mount", () => {
    const opts = makeOpts();
    const ctrl = createChannelController(opts);

    ctrl.mountChannel(42, "general");

    expect(opts.msgCtrl.loadMessages).toHaveBeenCalledWith(42, expect.any(AbortSignal));
  });

  it("is no-op when same channel mounted", () => {
    const opts = makeOpts();
    const ctrl = createChannelController(opts);

    ctrl.mountChannel(42, "general");
    vi.clearAllMocks();

    ctrl.mountChannel(42, "general");

    expect(opts.ws.send).not.toHaveBeenCalled();
    expect(mockMessageListMount).not.toHaveBeenCalled();
  });

  it("destroys old channel before mounting new one", () => {
    const opts = makeOpts();
    const ctrl = createChannelController(opts);

    ctrl.mountChannel(42, "general");
    ctrl.mountChannel(99, "random");

    expect(mockMessageListDestroy).toHaveBeenCalled();
    expect(mockTypingDestroy).toHaveBeenCalled();
    expect(mockMessageInputDestroy).toHaveBeenCalled();
    expect(ctrl.currentChannelId).toBe(99);
  });

  it("updates chat header name", () => {
    const opts = makeOpts();
    const ctrl = createChannelController(opts);

    ctrl.mountChannel(42, "general");

    expect(opts.chatHeaderName!.textContent).toBe("general");
  });

  it("destroyChannel resets state", () => {
    const opts = makeOpts();
    const ctrl = createChannelController(opts);

    ctrl.mountChannel(42, "general");
    ctrl.destroyChannel();

    expect(ctrl.currentChannelId).toBeNull();
    expect(ctrl.messageList).toBeNull();
    expect(opts.pendingDeleteManager.cleanup).toHaveBeenCalled();
  });

  describe("MessageList callbacks", () => {
    it("onDeleteClick sends delete on confirmed", () => {
      const opts = makeOpts();
      (opts.pendingDeleteManager.tryDelete as ReturnType<typeof vi.fn>).mockReturnValue("confirmed");
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      capturedMessageListOpts!.onDeleteClick(5);

      expect(opts.pendingDeleteManager.tryDelete).toHaveBeenCalledWith(5);
      expect(opts.ws.send).toHaveBeenCalledWith({
        type: "chat_delete",
        payload: { message_id: 5 },
      });
    });

    it("onDeleteClick shows info toast on pending", () => {
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      capturedMessageListOpts!.onDeleteClick(5);

      expect(opts.showToast).toHaveBeenCalledWith("Click delete again to confirm", "info");
    });

    it("onReactionClick delegates to reactionCtrl", () => {
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      capturedMessageListOpts.onReactionClick(5, "👍");

      expect(opts.reactionCtrl.handleReaction).toHaveBeenCalledWith(5, "👍");
    });
  });

  describe("MessageInput callbacks", () => {
    it("onSend sends chat_send via ws", () => {
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      capturedMessageInputOpts.onSend("hello", null, []);

      expect(opts.ws.send).toHaveBeenCalledWith({
        type: "chat_send",
        payload: {
          channel_id: 42,
          content: "hello",
          reply_to: null,
          attachments: [],
        },
      });
    });

    it("onSend shows error when not connected", () => {
      const opts = makeOpts();
      (opts.ws.getState as ReturnType<typeof vi.fn>).mockReturnValue("disconnected");
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      capturedMessageInputOpts.onSend("hello", null, []);

      expect(opts.showToast).toHaveBeenCalledWith("Not connected — message not sent", "error");
    });

    it("onTyping sends typing_start via ws", () => {
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      capturedMessageInputOpts.onTyping();

      expect(opts.ws.send).toHaveBeenCalledWith({
        type: "typing_start",
        payload: { channel_id: 42 },
      });
    });

    it("onEditMessage rejects empty content", () => {
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      capturedMessageInputOpts.onEditMessage(5, "   ");

      expect(opts.showToast).toHaveBeenCalledWith("Message cannot be empty", "error");
    });

    it("onEditMessage skips when content unchanged", () => {
      mockGetChannelMessages.mockReturnValue([{ id: 5, content: "hello" }]);
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      capturedMessageInputOpts!.onEditMessage(5, "hello");

      // Should not send edit since content hasn't changed
      const sendMock = opts.ws.send as ReturnType<typeof vi.fn>;
      const editCalls = sendMock.mock.calls.filter(
        (c: unknown[]) => (c[0] as { type: string }).type === "chat_edit",
      );
      expect(editCalls).toHaveLength(0);
    });

    it("onTyping does not send when rate limited", () => {
      const opts = makeOpts();
      (opts.typingLimiter.tryConsume as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      capturedMessageInputOpts!.onTyping();

      const sendMock = opts.ws.send as ReturnType<typeof vi.fn>;
      const typingCalls = sendMock.mock.calls.filter(
        (c: unknown[]) => (c[0] as { type: string }).type === "typing_start",
      );
      expect(typingCalls).toHaveLength(0);
    });

    it("onUploadFile returns file data on success", async () => {
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      const result = await capturedMessageInputOpts!.onUploadFile(new File(["x"], "test.txt"));

      expect(result).toEqual({ id: 1, url: "/f/1", filename: "f.txt" });
    });

    it("onUploadFile shows toast on failure", async () => {
      const opts = makeOpts();
      (opts.api as unknown as { uploadFile: ReturnType<typeof vi.fn> }).uploadFile.mockRejectedValue(new Error("upload failed"));
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      await expect(capturedMessageInputOpts!.onUploadFile(new File(["x"], "test.txt"))).rejects.toThrow("upload failed");
      expect(opts.showToast).toHaveBeenCalledWith("File upload failed", "error");
    });
  });

  describe("MessageList callbacks - additional", () => {
    it("onScrollTop delegates to msgCtrl.loadOlderMessages", () => {
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      capturedMessageListOpts!.onScrollTop();

      expect(opts.msgCtrl.loadOlderMessages).toHaveBeenCalledWith(42, expect.any(AbortSignal));
    });

    it("onReplyClick sets reply with username", () => {
      mockGetChannelMessages.mockReturnValue([
        { id: 5, content: "hello", user: { id: 2, username: "alice" } },
      ]);
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      capturedMessageListOpts!.onReplyClick(5);

      expect(mockSetReplyTo).toHaveBeenCalledWith(5, "alice");
    });

    it("onEditClick starts edit with message content", () => {
      mockGetChannelMessages.mockReturnValue([
        { id: 5, content: "hello", user: { id: 1, username: "me" } },
      ]);
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      capturedMessageListOpts!.onEditClick(5);

      expect(mockStartEdit).toHaveBeenCalledWith(5, "hello");
    });
  });
});
