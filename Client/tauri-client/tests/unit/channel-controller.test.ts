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

const { mockSetMessagePinned } = vi.hoisted(() => ({
  mockSetMessagePinned: vi.fn(),
}));

vi.mock("@stores/messages.store", () => ({
  getChannelMessages: mockGetChannelMessages,
  setMessagePinned: mockSetMessagePinned,
}));

const { mockUpdateChatHeaderForDm } = vi.hoisted(() => ({
  mockUpdateChatHeaderForDm: vi.fn(),
}));

vi.mock("../../src/pages/main-page/ChatHeader", () => ({
  updateChatHeaderForDm: mockUpdateChatHeaderForDm,
}));

const { mockDmStoreGetState, mockMembersStoreGetState } = vi.hoisted(() => ({
  mockDmStoreGetState: vi.fn(() => ({ channels: [] })),
  mockMembersStoreGetState: vi.fn(() => ({ members: new Map() })),
}));

vi.mock("@stores/dm.store", () => ({
  dmStore: { getState: mockDmStoreGetState },
}));

vi.mock("@stores/members.store", () => ({
  membersStore: { getState: mockMembersStoreGetState },
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
    chatHeaderRefs: null,
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

    it("onReplyClick uses empty string for unknown message", () => {
      mockGetChannelMessages.mockReturnValue([]);
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      capturedMessageListOpts!.onReplyClick(999);

      expect(mockSetReplyTo).toHaveBeenCalledWith(999, "");
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

    it("onEditClick does nothing for unknown message", () => {
      mockGetChannelMessages.mockReturnValue([]);
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      capturedMessageListOpts!.onEditClick(999);

      expect(mockStartEdit).not.toHaveBeenCalled();
    });

    it("onPinClick pins a message and shows toast", async () => {
      const opts = makeOpts();
      (opts.api as unknown as { pinMessage: ReturnType<typeof vi.fn> }).pinMessage = vi.fn().mockResolvedValue(undefined);
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      capturedMessageListOpts!.onPinClick(5, 42, false);

      await vi.waitFor(() => {
        expect(mockSetMessagePinned).toHaveBeenCalledWith(42, 5, true);
        expect(opts.showToast).toHaveBeenCalledWith("Message pinned", "success");
      });
    });

    it("onPinClick unpins a message and shows toast", async () => {
      const opts = makeOpts();
      (opts.api as unknown as { unpinMessage: ReturnType<typeof vi.fn> }).unpinMessage = vi.fn().mockResolvedValue(undefined);
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      capturedMessageListOpts!.onPinClick(5, 42, true);

      await vi.waitFor(() => {
        expect(mockSetMessagePinned).toHaveBeenCalledWith(42, 5, false);
        expect(opts.showToast).toHaveBeenCalledWith("Message unpinned", "success");
      });
    });

    it("onPinClick shows error toast on failure", async () => {
      const opts = makeOpts();
      (opts.api as unknown as { pinMessage: ReturnType<typeof vi.fn> }).pinMessage = vi.fn().mockRejectedValue(new Error("network error"));
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      capturedMessageListOpts!.onPinClick(5, 42, false);

      await vi.waitFor(() => {
        expect(opts.showToast).toHaveBeenCalledWith("Failed to pin/unpin message", "error");
      });
    });

    it("onScrollTop does not load when channelAbort is null (after destroy)", () => {
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      // Capture the onScrollTop callback
      const scrollTopCb = capturedMessageListOpts!.onScrollTop;

      // Destroy channel (sets channelAbort to null)
      ctrl.destroyChannel();
      vi.clearAllMocks();

      // Calling onScrollTop after destroy should not call loadOlderMessages
      scrollTopCb();

      expect(opts.msgCtrl.loadOlderMessages).not.toHaveBeenCalled();
    });
  });

  describe("MessageInput callbacks - additional", () => {
    it("onEditMessage sends chat_edit when content changed", () => {
      mockGetChannelMessages.mockReturnValue([{ id: 5, content: "old content" }]);
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      capturedMessageInputOpts!.onEditMessage(5, "new content");

      expect(opts.ws.send).toHaveBeenCalledWith({
        type: "chat_edit",
        payload: { message_id: 5, content: "new content" },
      });
      expect(opts.showToast).toHaveBeenCalledWith("Message edited", "success");
    });

    it("onEditMessage sends edit when message not found in store", () => {
      mockGetChannelMessages.mockReturnValue([]);
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      capturedMessageInputOpts!.onEditMessage(999, "new content");

      expect(opts.ws.send).toHaveBeenCalledWith({
        type: "chat_edit",
        payload: { message_id: 999, content: "new content" },
      });
    });

    it("onSend includes reply_to and attachments", () => {
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      capturedMessageInputOpts.onSend("hello", 10, ["file1.png"]);

      expect(opts.ws.send).toHaveBeenCalledWith({
        type: "chat_send",
        payload: {
          channel_id: 42,
          content: "hello",
          reply_to: 10,
          attachments: ["file1.png"],
        },
      });
    });
  });

  describe("edit-last-message event", () => {
    it("finds the last non-deleted message by current user and starts edit", () => {
      mockGetChannelMessages.mockReturnValue([
        { id: 1, content: "first", user: { id: 1, username: "me" }, deleted: false },
        { id: 2, content: "other user", user: { id: 2, username: "them" }, deleted: false },
        { id: 3, content: "my deleted", user: { id: 1, username: "me" }, deleted: true },
        { id: 4, content: "my latest", user: { id: 1, username: "me" }, deleted: false },
      ]);
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");
      vi.clearAllMocks();

      opts.slots.inputSlot.dispatchEvent(new Event("edit-last-message"));

      expect(mockStartEdit).toHaveBeenCalledWith(4, "my latest");
    });

    it("skips deleted messages and finds earlier non-deleted message", () => {
      mockGetChannelMessages.mockReturnValue([
        { id: 1, content: "earliest", user: { id: 1, username: "me" }, deleted: false },
        { id: 2, content: "deleted", user: { id: 1, username: "me" }, deleted: true },
      ]);
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");
      vi.clearAllMocks();

      opts.slots.inputSlot.dispatchEvent(new Event("edit-last-message"));

      expect(mockStartEdit).toHaveBeenCalledWith(1, "earliest");
    });

    it("does nothing when no own messages exist", () => {
      mockGetChannelMessages.mockReturnValue([
        { id: 1, content: "other", user: { id: 2, username: "them" }, deleted: false },
      ]);
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");
      vi.clearAllMocks();

      opts.slots.inputSlot.dispatchEvent(new Event("edit-last-message"));

      expect(mockStartEdit).not.toHaveBeenCalled();
    });
  });

  describe("DM channel header", () => {
    it("updates chat header for DM channel with recipient status", () => {
      mockDmStoreGetState.mockReturnValue({
        channels: [
          {
            channelId: 42,
            recipient: { id: 5, username: "alice", avatar: "", status: "online" },
            lastMessageId: null,
            lastMessage: "",
            lastMessageAt: "",
            unreadCount: 0,
          },
        ],
      });
      mockMembersStoreGetState.mockReturnValue({
        members: new Map([[5, { id: 5, username: "alice", status: "idle" }]]),
      });

      const chatHeaderRefs = {
        hashEl: document.createElement("span"),
        nameEl: document.createElement("span"),
        topicEl: document.createElement("span"),
      };
      const opts = makeOpts({ chatHeaderRefs });
      const ctrl = createChannelController(opts);

      ctrl.mountChannel(42, "alice", "dm");

      // Should use member status ("idle") over DM recipient status ("online")
      expect(mockUpdateChatHeaderForDm).toHaveBeenCalledWith(chatHeaderRefs, {
        username: "alice",
        status: "Idle",
      });
    });

    it("uses DM recipient status when member not found in members store", () => {
      mockDmStoreGetState.mockReturnValue({
        channels: [
          {
            channelId: 42,
            recipient: { id: 5, username: "bob", avatar: "", status: "dnd" },
            lastMessageId: null,
            lastMessage: "",
            lastMessageAt: "",
            unreadCount: 0,
          },
        ],
      });
      mockMembersStoreGetState.mockReturnValue({
        members: new Map(),
      });

      const chatHeaderRefs = {
        hashEl: document.createElement("span"),
        nameEl: document.createElement("span"),
        topicEl: document.createElement("span"),
      };
      const opts = makeOpts({ chatHeaderRefs });
      const ctrl = createChannelController(opts);

      ctrl.mountChannel(42, "bob", "dm");

      expect(mockUpdateChatHeaderForDm).toHaveBeenCalledWith(chatHeaderRefs, {
        username: "bob",
        status: "Dnd",
      });
    });

    it("falls back to 'Offline' when DM channel not found in dmStore", () => {
      mockDmStoreGetState.mockReturnValue({ channels: [] });

      const chatHeaderRefs = {
        hashEl: document.createElement("span"),
        nameEl: document.createElement("span"),
        topicEl: document.createElement("span"),
      };
      const opts = makeOpts({ chatHeaderRefs });
      const ctrl = createChannelController(opts);

      ctrl.mountChannel(42, "unknown", "dm");

      expect(mockUpdateChatHeaderForDm).toHaveBeenCalledWith(chatHeaderRefs, {
        username: "unknown",
        status: "Offline",
      });
    });

    it("resets header for non-DM channel when chatHeaderRefs is provided", () => {
      const chatHeaderRefs = {
        hashEl: document.createElement("span"),
        nameEl: document.createElement("span"),
        topicEl: document.createElement("span"),
      };
      const opts = makeOpts({ chatHeaderRefs });
      const ctrl = createChannelController(opts);

      ctrl.mountChannel(42, "general", "text");

      expect(mockUpdateChatHeaderForDm).toHaveBeenCalledWith(chatHeaderRefs, null);
      expect(opts.chatHeaderName!.textContent).toBe("general");
    });

    it("only sets chatHeaderName when no chatHeaderRefs", () => {
      const opts = makeOpts({ chatHeaderRefs: null });
      const ctrl = createChannelController(opts);

      ctrl.mountChannel(42, "random");

      expect(opts.chatHeaderName!.textContent).toBe("random");
      expect(mockUpdateChatHeaderForDm).not.toHaveBeenCalled();
    });
  });

  describe("destroyChannel edge cases", () => {
    it("destroyChannel is safe to call when no channel is mounted", () => {
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      // Should not throw
      ctrl.destroyChannel();
      expect(ctrl.currentChannelId).toBeNull();
    });

    it("destroyChannel aborts the channel signal", () => {
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      ctrl.destroyChannel();

      // Verify edit-last-message listener is cleaned up (signal aborted)
      // by dispatching the event and checking startEdit is not called
      mockGetChannelMessages.mockReturnValue([
        { id: 1, content: "msg", user: { id: 1, username: "me" }, deleted: false },
      ]);
      vi.clearAllMocks();
      opts.slots.inputSlot.dispatchEvent(new Event("edit-last-message"));
      expect(mockStartEdit).not.toHaveBeenCalled();
    });
  });
});
