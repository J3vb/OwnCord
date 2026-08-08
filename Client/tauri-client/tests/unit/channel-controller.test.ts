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
  mockSetDisabled,
} = vi.hoisted(() => ({
  mockMessageListMount: vi.fn(),
  mockMessageListDestroy: vi.fn(),
  mockMessageInputMount: vi.fn(),
  mockMessageInputDestroy: vi.fn(),
  mockTypingMount: vi.fn(),
  mockTypingDestroy: vi.fn(),
  mockGetChannelMessages: vi.fn(
    (): Array<{
      id: number;
      content?: string;
      user?: { id: number; username: string };
      deleted?: boolean;
      status?: string;
    }> => [],
  ),
  mockSetReplyTo: vi.fn(),
  mockStartEdit: vi.fn(),
  mockScrollToMessage: vi.fn(() => true),
  mockSetDisabled: vi.fn(),
}));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("@lib/dom", () => ({
  createElement: vi.fn((tag: string) => document.createElement(tag)),
  clearChildren: vi.fn((el: HTMLElement) => {
    el.innerHTML = "";
  }),
  setText: vi.fn((el: HTMLElement, text: string) => {
    el.textContent = text;
  }),
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
      clearReply: vi.fn(),
      cancelEdit: vi.fn(),
      setDisabled: mockSetDisabled,
    };
  }),
}));

// The gate component itself is covered by nsfw-gate.test.ts; what the
// controller owns is WHETHER and with what it is mounted.
const { mockNsfwGateMount, mockNsfwGateDestroy, mockCreateNsfwGate, capturedNsfwOpts } = vi.hoisted(
  () => ({
    mockNsfwGateMount: vi.fn(),
    mockNsfwGateDestroy: vi.fn(),
    mockCreateNsfwGate: vi.fn(),
    capturedNsfwOpts: { value: null as any },
  }),
);

vi.mock("@components/NsfwGate", () => ({
  createNsfwGate: (opts: any) => {
    capturedNsfwOpts.value = opts;
    mockCreateNsfwGate(opts);
    return { mount: mockNsfwGateMount, destroy: mockNsfwGateDestroy };
  },
}));

vi.mock("@components/TypingIndicator", () => ({
  createTypingIndicator: vi.fn(() => ({
    mount: mockTypingMount,
    destroy: mockTypingDestroy,
  })),
}));

const { mockSetMessagePinned, mockAddOptimistic, mockMarkSendFailed, mockRemoveOptimistic } =
  vi.hoisted(() => ({
    mockSetMessagePinned: vi.fn(),
    mockAddOptimistic: vi.fn(),
    mockMarkSendFailed: vi.fn(),
    mockRemoveOptimistic: vi.fn(),
  }));

const { mockMarkChannelRead } = vi.hoisted(() => ({ mockMarkChannelRead: vi.fn() }));

vi.mock("@lib/read-state", () => ({
  markChannelRead: mockMarkChannelRead,
}));

const { mockRole } = vi.hoisted(() => ({ mockRole: { value: "member" } }));

const { mockReattachToPresent, mockJumpToMessage, mockIsWindowDetached } = vi.hoisted(() => ({
  mockReattachToPresent: vi.fn(),
  mockJumpToMessage: vi.fn(),
  mockIsWindowDetached: vi.fn(() => false),
}));

vi.mock("@stores/messages.store", () => ({
  getChannelMessages: mockGetChannelMessages,
  setMessagePinned: mockSetMessagePinned,
  addOptimisticMessage: mockAddOptimistic,
  markSendFailed: mockMarkSendFailed,
  removeOptimistic: mockRemoveOptimistic,
  reattachToPresent: mockReattachToPresent,
  isWindowDetached: mockIsWindowDetached,
}));

vi.mock("@lib/message-navigation", () => ({
  jumpToMessage: mockJumpToMessage,
}));

vi.mock("@stores/auth.store", () => ({
  authStore: {
    getState: () => ({ user: { id: 1, username: "tester", avatar: null, role: mockRole.value } }),
  },
}));

const { mockUpdateChatHeaderForDm } = vi.hoisted(() => ({
  mockUpdateChatHeaderForDm: vi.fn(),
}));

vi.mock("../../src/pages/main-page/ChatHeader", () => ({
  updateChatHeaderForDm: mockUpdateChatHeaderForDm,
}));

const {
  mockDmStoreGetState,
  mockMembersStoreGetState,
  dmStoreSubscribers,
  membersStoreSubscribers,
} = vi.hoisted(() => ({
  mockDmStoreGetState: vi.fn(() => ({
    channels: [] as Array<{
      channelId: number;
      recipient: { id: number; username: string; avatar: string; status: string };
      // Group DMs: the participant list, the optional name and the group flag.
      participants: Array<{ id: number; username: string; avatar: string; status: string }>;
      name: string;
      isGroup: boolean;
      lastMessageId: number | null;
      lastMessage: string;
      lastMessageAt: string;
      unreadCount: number;
    }>,
  })),
  mockMembersStoreGetState: vi.fn(() => ({ members: new Map() })),
  dmStoreSubscribers: [] as Array<() => void>,
  membersStoreSubscribers: [] as Array<() => void>,
}));

vi.mock("@stores/dm.store", async () => {
  // dmDisplayName is real: it is the single answer to "what is this DM
  // called", and mocking it would let the controller and the sidebar disagree
  // in a test while agreeing in production.
  const actual = await vi.importActual<typeof import("@stores/dm.store")>("@stores/dm.store");
  return {
    dmStore: {
      getState: mockDmStoreGetState,
      subscribeSelector: vi.fn((_sel: unknown, cb: () => void) => {
        dmStoreSubscribers.push(cb);
        return () => {};
      }),
    },
    dmDisplayName: actual.dmDisplayName,
  };
});

vi.mock("@stores/members.store", () => ({
  membersStore: {
    getState: mockMembersStoreGetState,
    subscribeSelector: vi.fn((_sel: unknown, cb: () => void) => {
      membersStoreSubscribers.push(cb);
      return () => {};
    }),
  },
}));

// Block-state gating: capture the subscription callback so tests can simulate a
// live change (block/unblock) and mock the reason the store reports.
const { mockBlocksGetState, mockDmComposerBlockReason, blocksSubscribers } = vi.hoisted(() => ({
  mockBlocksGetState: vi.fn(() => ({ blockedByMe: new Set<number>(), blockedByThem: new Set() })),
  mockDmComposerBlockReason: vi.fn((): string | null => null),
  blocksSubscribers: [] as Array<() => void>,
}));

vi.mock("@stores/blocks.store", () => ({
  blocksStore: {
    getState: mockBlocksGetState,
    subscribeSelector: vi.fn((_sel: unknown, cb: () => void) => {
      blocksSubscribers.push(cb);
      return () => {};
    }),
  },
  dmComposerBlockReason: mockDmComposerBlockReason,
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { createChannelController } from "../../src/pages/main-page/ChannelController";
import type { ChannelControllerOptions } from "../../src/pages/main-page/ChannelController";
import { setConnectionStatus } from "@stores/ui.store";
import {
  channelsStore,
  setChannels,
  setActiveChannel,
  setRoles,
  updateChannel,
} from "@stores/channels.store";
import { acknowledgeNsfw } from "@lib/nsfw-gate";

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
    ws: {
      send: vi.fn(),
      getState: vi.fn(() => "connected"),
      onStateChange: vi.fn(() => vi.fn()),
      // The composer subscribes to chat_send_ok / error to drive slow mode.
      on: vi.fn(() => vi.fn()),
    } as unknown as ChannelControllerOptions["ws"],
    api: {
      uploadFile: vi.fn().mockResolvedValue({ id: 1, url: "/f/1", filename: "f.txt" }),
    } as unknown as ChannelControllerOptions["api"],
    msgCtrl: {
      loadMessages: vi.fn(),
      loadOlderMessages: vi.fn(),
    } as unknown as ChannelControllerOptions["msgCtrl"],
    pendingDeleteManager: { tryDelete: vi.fn(() => "pending" as const), cleanup: vi.fn() },
    reactionCtrl: {
      handleReaction: vi.fn(),
      destroy: vi.fn(),
    } as unknown as ChannelControllerOptions["reactionCtrl"],
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
    blocksSubscribers.length = 0;
    dmStoreSubscribers.length = 0;
    membersStoreSubscribers.length = 0;
    mockDmComposerBlockReason.mockReturnValue(null);
    // The controller gates sends on the store-backed connection status
    // (docs/architecture/ux §3), not on ws.getState().
    setConnectionStatus("connected");
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

  it("marks the previous channel read when switching away from it", () => {
    // channel_focus only advances read state for the channel being entered;
    // nothing advances it for the channel being left, so leaving must mark it
    // read explicitly or its badges come back stale on the next `ready`.
    const opts = makeOpts();
    const ctrl = createChannelController(opts);

    ctrl.mountChannel(42, "general");
    expect(mockMarkChannelRead).not.toHaveBeenCalled();

    ctrl.mountChannel(99, "random");

    expect(mockMarkChannelRead).toHaveBeenCalledWith(42);
  });

  it("does not mark anything read on the very first mount (no previous channel)", () => {
    const opts = makeOpts();
    const ctrl = createChannelController(opts);

    ctrl.mountChannel(42, "general");

    expect(mockMarkChannelRead).not.toHaveBeenCalled();
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
      (opts.pendingDeleteManager.tryDelete as ReturnType<typeof vi.fn>).mockReturnValue(
        "confirmed",
      );
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

    it("onSend from a detached window reattaches to present before sending", () => {
      // After a jump into history the composer stays enabled; sending must
      // land the optimistic row in the live tail, not mid-history.
      mockIsWindowDetached.mockReturnValueOnce(true);
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");
      (opts.msgCtrl.loadMessages as ReturnType<typeof vi.fn>).mockClear();

      capturedMessageInputOpts.onSend("hello", null, []);

      expect(mockReattachToPresent).toHaveBeenCalledWith(42);
      // Reattach clears "loaded", so the live tail is refetched.
      expect(opts.msgCtrl.loadMessages).toHaveBeenCalledWith(42, expect.any(AbortSignal));
      // The send itself still goes out.
      expect(opts.ws.send).toHaveBeenCalledWith(expect.objectContaining({ type: "chat_send" }));
    });

    it("onSend while disconnected records a failed optimistic row (no silent drop)", () => {
      const opts = makeOpts();
      setConnectionStatus("disconnected");
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      capturedMessageInputOpts.onSend("hello", null, []);

      // No socket send is attempted; the row is shown as failed with retry.
      expect(opts.ws.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "chat_send" }));
      expect(mockAddOptimistic).toHaveBeenCalled();
      expect(mockMarkSendFailed).toHaveBeenCalledWith(expect.any(String), "OFFLINE");
    });

    it("composer disable reason distinguishes reconnecting from disconnected", () => {
      const opts = makeOpts();
      setConnectionStatus("reconnecting");
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");
      expect(mockSetDisabled).toHaveBeenLastCalledWith("Reconnecting…");

      ctrl.destroyChannel();
      setConnectionStatus("disconnected");
      ctrl.mountChannel(43, "general-2");
      expect(mockSetDisabled).toHaveBeenLastCalledWith("Not connected");
    });

    it("onRetryLoad re-invokes loadMessages for the mounted channel", () => {
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");
      (opts.msgCtrl.loadMessages as ReturnType<typeof vi.fn>).mockClear();

      capturedMessageListOpts.onRetryLoad();

      expect(opts.msgCtrl.loadMessages).toHaveBeenCalledWith(42, expect.any(AbortSignal));
    });

    it("onJumpToMessage routes a reply-bar jump through the shared jumper", () => {
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      capturedMessageListOpts.onJumpToMessage(1234);

      // Scoped to the mounted channel: a reply always points inside it.
      expect(mockJumpToMessage).toHaveBeenCalledWith(42, 1234);
    });

    it("onJumpToPresent reattaches the channel and refetches the live tail", () => {
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");
      (opts.msgCtrl.loadMessages as ReturnType<typeof vi.fn>).mockClear();

      capturedMessageListOpts.onJumpToPresent();

      // Reattaching first is what makes the refetch actually happen —
      // loadMessages short-circuits while the channel is still "loaded".
      expect(mockReattachToPresent).toHaveBeenCalledWith(42);
      expect(opts.msgCtrl.loadMessages).toHaveBeenCalledWith(42, expect.any(AbortSignal));
      expect(mockReattachToPresent.mock.invocationCallOrder[0]).toBeLessThan(
        (opts.msgCtrl.loadMessages as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
      );
    });

    it("onRetry re-sends the failed draft with a fresh correlation id", () => {
      const opts = makeOpts();
      let n = 0;
      (opts.ws.send as ReturnType<typeof vi.fn>).mockImplementation(() => `cid-${++n}`);
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      // cid-1 is channel_focus; the chat_send gets cid-2.
      capturedMessageInputOpts.onSend("hello", null, []);
      expect(mockAddOptimistic).toHaveBeenCalledWith(
        expect.objectContaining({ correlationId: "cid-2", content: "hello" }),
      );

      capturedMessageListOpts.onRetry("cid-2");

      // The old row is discarded and the draft re-sent under a new id.
      expect(mockRemoveOptimistic).toHaveBeenCalledWith("cid-2");
      expect(mockAddOptimistic).toHaveBeenLastCalledWith(
        expect.objectContaining({ correlationId: "cid-3", content: "hello" }),
      );
    });

    it("onDeleteDraft discards the failed row without re-sending", () => {
      const opts = makeOpts();
      let n = 0;
      (opts.ws.send as ReturnType<typeof vi.fn>).mockImplementation(() => `cid-${++n}`);
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      capturedMessageInputOpts.onSend("hello", null, []);
      const sendCalls = (opts.ws.send as ReturnType<typeof vi.fn>).mock.calls.length;

      capturedMessageListOpts.onDeleteDraft("cid-2");

      expect(mockRemoveOptimistic).toHaveBeenCalledWith("cid-2");
      expect((opts.ws.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(sendCalls);
    });

    it("onRetry still re-sends a failed draft after the channel was remounted", () => {
      // A failed row survives a channel switch (it is carried across history
      // refetches), so its draft must too — a per-mount draft map left Retry
      // silently inert once the reader switched away and back.
      const opts = makeOpts();
      let n = 0;
      (opts.ws.send as ReturnType<typeof vi.fn>).mockImplementation(() => `cid-${++n}`);
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      // cid-1 is channel_focus; the chat_send gets cid-2.
      capturedMessageInputOpts.onSend("hello", null, []);
      expect(mockAddOptimistic).toHaveBeenCalledWith(
        expect.objectContaining({ correlationId: "cid-2", content: "hello" }),
      );

      // Simulate a real remount: switch away and back to the same channel.
      ctrl.destroyChannel();
      ctrl.mountChannel(42, "general");

      capturedMessageListOpts.onRetry("cid-2");

      expect(mockRemoveOptimistic).toHaveBeenCalledWith("cid-2");
      expect(mockAddOptimistic).toHaveBeenLastCalledWith(
        expect.objectContaining({ correlationId: "cid-4", content: "hello" }),
      );
    });

    it("releases a draft once the send is acked", () => {
      // The draft map outlives a channel switch so a failed row stays
      // retriable. Nothing else prunes it, so an accepted send must release
      // its own entry or every message of the session is retained forever.
      const opts = makeOpts();
      let n = 0;
      (opts.ws.send as ReturnType<typeof vi.fn>).mockImplementation(() => `cid-${++n}`);
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      capturedMessageInputOpts.onSend("hello", null, []);

      const ackCall = (opts.ws.on as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) => c[0] === "chat_send_ok",
      );
      const onAck = ackCall![1] as (payload: unknown, id?: string) => void;
      onAck({ message_id: 7, timestamp: "2024-01-01T00:00:00Z" }, "cid-2");

      const sendCalls = (opts.ws.send as ReturnType<typeof vi.fn>).mock.calls.length;
      capturedMessageListOpts.onRetry("cid-2");

      // No draft left to re-send: the ack already released it.
      expect((opts.ws.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(sendCalls);
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
      (
        opts.api as unknown as { uploadFile: ReturnType<typeof vi.fn> }
      ).uploadFile.mockRejectedValue(new Error("upload failed"));
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      await expect(
        capturedMessageInputOpts!.onUploadFile(new File(["x"], "test.txt")),
      ).rejects.toThrow("upload failed");
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

    it("onEditClick skips startEdit when message id is not found in channel", () => {
      mockGetChannelMessages.mockReturnValue([]);
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      capturedMessageListOpts!.onEditClick(999);

      expect(mockStartEdit).not.toHaveBeenCalled();
    });

    it("onPinClick pins a message and shows toast", async () => {
      const opts = makeOpts();
      (opts.api as unknown as { pinMessage: ReturnType<typeof vi.fn> }).pinMessage = vi
        .fn()
        .mockResolvedValue(undefined);
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
      (opts.api as unknown as { unpinMessage: ReturnType<typeof vi.fn> }).unpinMessage = vi
        .fn()
        .mockResolvedValue(undefined);
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
      (opts.api as unknown as { pinMessage: ReturnType<typeof vi.fn> }).pinMessage = vi
        .fn()
        .mockRejectedValue(new Error("network error"));
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
        {
          id: 1,
          content: "first",
          user: { id: 1, username: "me" },
          deleted: false,
          status: "sent",
        },
        {
          id: 2,
          content: "other user",
          user: { id: 2, username: "them" },
          deleted: false,
          status: "sent",
        },
        {
          id: 3,
          content: "my deleted",
          user: { id: 1, username: "me" },
          deleted: true,
          status: "sent",
        },
        {
          id: 4,
          content: "my latest",
          user: { id: 1, username: "me" },
          deleted: false,
          status: "sent",
        },
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
        {
          id: 1,
          content: "earliest",
          user: { id: 1, username: "me" },
          deleted: false,
          status: "sent",
        },
        {
          id: 2,
          content: "deleted",
          user: { id: 1, username: "me" },
          deleted: true,
          status: "sent",
        },
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
        {
          id: 1,
          content: "other",
          user: { id: 2, username: "them" },
          deleted: false,
          status: "sent",
        },
      ]);
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");
      vi.clearAllMocks();

      opts.slots.inputSlot.dispatchEvent(new Event("edit-last-message"));

      expect(mockStartEdit).not.toHaveBeenCalled();
    });

    it("skips an unconfirmed/failed optimistic row (id 0) and edits the last actually-sent message", () => {
      mockGetChannelMessages.mockReturnValue([
        {
          id: 5,
          content: "sent earlier",
          user: { id: 1, username: "me" },
          deleted: false,
          status: "sent",
        },
        {
          id: 0,
          content: "still sending",
          user: { id: 1, username: "me" },
          deleted: false,
          status: "pending",
        },
      ]);
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");
      vi.clearAllMocks();

      opts.slots.inputSlot.dispatchEvent(new Event("edit-last-message"));

      // The visual Edit affordance only appears on status === "sent" rows
      // (renderers.ts); the keyboard shortcut must honor the same gate rather
      // than editing an optimistic row that has no real message id yet.
      expect(mockStartEdit).toHaveBeenCalledWith(5, "sent earlier");
    });

    it("does nothing when every own message is still pending/failed", () => {
      mockGetChannelMessages.mockReturnValue([
        {
          id: 0,
          content: "still sending",
          user: { id: 1, username: "me" },
          deleted: false,
          status: "failed",
        },
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
            participants: [{ id: 5, username: "alice", avatar: "", status: "online" }],
            name: "",
            isGroup: false,
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
        callBtn: document.createElement("button"),
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
            participants: [{ id: 5, username: "bob", avatar: "", status: "dnd" }],
            name: "",
            isGroup: false,
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
        callBtn: document.createElement("button"),
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
        callBtn: document.createElement("button"),
      };
      const opts = makeOpts({ chatHeaderRefs });
      const ctrl = createChannelController(opts);

      ctrl.mountChannel(42, "unknown", "dm");

      expect(mockUpdateChatHeaderForDm).toHaveBeenCalledWith(chatHeaderRefs, {
        username: "unknown",
        status: "Offline",
      });
    });

    it("keeps the DM header subtitle live when the partner's presence changes", () => {
      mockDmStoreGetState.mockReturnValue({
        channels: [
          {
            channelId: 42,
            recipient: { id: 5, username: "alice", avatar: "", status: "offline" },
            participants: [{ id: 5, username: "alice", avatar: "", status: "offline" }],
            name: "",
            isGroup: false,
            lastMessageId: null,
            lastMessage: "",
            lastMessageAt: "",
            unreadCount: 0,
          },
        ],
      });
      mockMembersStoreGetState.mockReturnValue({ members: new Map() });

      const chatHeaderRefs = {
        hashEl: document.createElement("span"),
        nameEl: document.createElement("span"),
        topicEl: document.createElement("span"),
        callBtn: document.createElement("button"),
      };
      const opts = makeOpts({ chatHeaderRefs });
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "alice", "dm");

      expect(mockUpdateChatHeaderForDm).toHaveBeenLastCalledWith(chatHeaderRefs, {
        username: "alice",
        status: "Offline",
      });

      // The partner comes online — no re-mount, just a members store update.
      mockMembersStoreGetState.mockReturnValue({
        members: new Map([[5, { id: 5, username: "alice", status: "online" }]]),
      });
      for (const cb of membersStoreSubscribers) cb();

      expect(mockUpdateChatHeaderForDm).toHaveBeenLastCalledWith(chatHeaderRefs, {
        username: "alice",
        status: "Online",
      });
    });

    it("keeps a group DM header live when the roster changes", () => {
      const dmChannel = {
        channelId: 42,
        recipient: { id: 5, username: "alice", avatar: "", status: "online" },
        participants: [{ id: 5, username: "alice", avatar: "", status: "online" }],
        name: "",
        isGroup: true,
        lastMessageId: null,
        lastMessage: "",
        lastMessageAt: "",
        unreadCount: 0,
      };
      mockDmStoreGetState.mockReturnValue({ channels: [dmChannel] });

      const chatHeaderRefs = {
        hashEl: document.createElement("span"),
        nameEl: document.createElement("span"),
        topicEl: document.createElement("span"),
        callBtn: document.createElement("button"),
      };
      const opts = makeOpts({ chatHeaderRefs });
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "Group", "dm");

      expect(mockUpdateChatHeaderForDm).toHaveBeenLastCalledWith(
        chatHeaderRefs,
        expect.objectContaining({ status: "2 members: You, alice" }),
      );

      // Someone else joins the group — no re-mount, just a dm store update.
      mockDmStoreGetState.mockReturnValue({
        channels: [
          {
            ...dmChannel,
            participants: [
              { id: 5, username: "alice", avatar: "", status: "online" },
              { id: 6, username: "bob", avatar: "", status: "online" },
            ],
          },
        ],
      });
      for (const cb of dmStoreSubscribers) cb();

      expect(mockUpdateChatHeaderForDm).toHaveBeenLastCalledWith(
        chatHeaderRefs,
        expect.objectContaining({ status: "3 members: You, alice, bob" }),
      );
    });

    it("resets header for non-DM channel when chatHeaderRefs is provided", () => {
      const chatHeaderRefs = {
        hashEl: document.createElement("span"),
        nameEl: document.createElement("span"),
        topicEl: document.createElement("span"),
        callBtn: document.createElement("button"),
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

    it("keeps the header name live when the channel is renamed mid-session (mirrors the topic subscription)", () => {
      setChannels([
        {
          id: 42,
          name: "general",
          type: "text",
          category: null,
          position: 0,
          can_send: true,
          nsfw: false,
        },
      ]);
      const chatHeaderRefs = {
        hashEl: document.createElement("span"),
        nameEl: document.createElement("span"),
        topicEl: document.createElement("span"),
        callBtn: document.createElement("button"),
      };
      const opts = makeOpts({ chatHeaderRefs });
      const ctrl = createChannelController(opts);

      ctrl.mountChannel(42, "general", "text");
      expect(opts.chatHeaderName!.textContent).toBe("general");

      updateChannel({ id: 42, name: "renamed" });
      channelsStore.flush();

      expect(opts.chatHeaderName!.textContent).toBe("renamed");
    });
  });

  describe("slow mode", () => {
    /** Pull a ws.on handler registered by the controller. */
    function wsHandler(opts: ChannelControllerOptions, event: string): (payload: never) => void {
      const calls = (opts.ws.on as ReturnType<typeof vi.fn>).mock.calls;
      const entry = calls.find((c) => c[0] === event);
      expect(entry).toBeDefined();
      return entry![1] as (payload: never) => void;
    }

    function seedChannel(slowMode: number): void {
      setChannels([
        {
          id: 42,
          name: "general",
          type: "text",
          category: null,
          position: 0,
          can_send: true,
          slow_mode: slowMode,
        },
      ]);
      setActiveChannel(42);
    }

    beforeEach(() => {
      mockRole.value = "member";
      setRoles([{ id: 4, name: "member", color: null, permissions: 0 }]);
      setConnectionStatus("connected");
    });

    it("disables the composer for the cooldown after an accepted send", () => {
      vi.useFakeTimers();
      try {
        seedChannel(5);
        const opts = makeOpts();
        const ctrl = createChannelController(opts);
        ctrl.mountChannel(42, "general");
        expect(mockSetDisabled).toHaveBeenLastCalledWith(null);

        wsHandler(opts, "chat_send_ok")({} as never);
        expect(mockSetDisabled).toHaveBeenLastCalledWith("Slow mode — 5s");

        vi.advanceTimersByTime(3000);
        expect(mockSetDisabled).toHaveBeenLastCalledWith("Slow mode — 2s");

        vi.advanceTimersByTime(2000);
        expect(mockSetDisabled).toHaveBeenLastCalledWith(null);
      } finally {
        vi.useRealTimers();
      }
    });

    it("leaves the composer alone in a channel without slow mode", () => {
      seedChannel(0);
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      wsHandler(opts, "chat_send_ok")({} as never);

      expect(mockSetDisabled).toHaveBeenLastCalledWith(null);
    });

    it("restarts the cooldown when the server refuses with SLOW_MODE", () => {
      vi.useFakeTimers();
      try {
        seedChannel(10);
        const opts = makeOpts();
        const ctrl = createChannelController(opts);
        ctrl.mountChannel(42, "general");

        wsHandler(opts, "error")({ code: "SLOW_MODE", message: "slow mode" } as never);
        expect(mockSetDisabled).toHaveBeenLastCalledWith("Slow mode — 10s");

        // An unrelated error must not gate the composer.
        vi.advanceTimersByTime(10_000);
        mockSetDisabled.mockClear();
        wsHandler(opts, "error")({ code: "FORBIDDEN", message: "nope" } as never);
        expect(mockSetDisabled).not.toHaveBeenCalledWith(expect.stringContaining("Slow mode"));
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not gate a moderator, who bypasses slow mode server-side", () => {
      seedChannel(5);
      mockRole.value = "moderator";
      setRoles([{ id: 3, name: "moderator", color: null, permissions: 0x10000 }]);
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      wsHandler(opts, "chat_send_ok")({} as never);

      expect(mockSetDisabled).toHaveBeenLastCalledWith(null);
    });

    it("stops the countdown when the channel unmounts", () => {
      vi.useFakeTimers();
      try {
        seedChannel(5);
        const opts = makeOpts();
        const ctrl = createChannelController(opts);
        ctrl.mountChannel(42, "general");
        wsHandler(opts, "chat_send_ok")({} as never);

        ctrl.destroyChannel();
        mockSetDisabled.mockClear();
        vi.advanceTimersByTime(5000);

        expect(mockSetDisabled).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("DM composer block gating", () => {
    function mountDm(reason: string | null): void {
      mockDmStoreGetState.mockReturnValue({
        channels: [
          {
            channelId: 42,
            recipient: { id: 5, username: "alice", avatar: "", status: "online" },
            participants: [{ id: 5, username: "alice", avatar: "", status: "online" }],
            name: "",
            isGroup: false,
            lastMessageId: null,
            lastMessage: "",
            lastMessageAt: "",
            unreadCount: 0,
          },
        ],
      });
      mockDmComposerBlockReason.mockReturnValue(reason);
      const ctrl = createChannelController(makeOpts());
      ctrl.mountChannel(42, "alice", "dm");
    }

    it("disables the DM composer with the explicit reason when the user blocked them", () => {
      mountDm("You've blocked this user. Unblock to send messages.");
      expect(mockSetDisabled).toHaveBeenLastCalledWith(
        "You've blocked this user. Unblock to send messages.",
      );
    });

    it("disables the DM composer with the neutral reason when being blocked", () => {
      mountDm("You can't message this user right now.");
      expect(mockSetDisabled).toHaveBeenLastCalledWith("You can't message this user right now.");
    });

    it("leaves the DM composer enabled when not blocked", () => {
      mountDm(null);
      expect(mockSetDisabled).toHaveBeenLastCalledWith(null);
    });

    it("un-gates live when the block clears (unblock)", () => {
      mountDm("You've blocked this user. Unblock to send messages.");
      expect(mockSetDisabled).toHaveBeenLastCalledWith(
        "You've blocked this user. Unblock to send messages.",
      );
      // Simulate an unblock: the store reports no reason and notifies subscribers.
      mockDmComposerBlockReason.mockReturnValue(null);
      for (const cb of blocksSubscribers) cb();
      expect(mockSetDisabled).toHaveBeenLastCalledWith(null);
    });

    it("does not subscribe to block state for non-DM channels", () => {
      const ctrl = createChannelController(makeOpts());
      ctrl.mountChannel(42, "general", "text");
      expect(blocksSubscribers).toHaveLength(0);
    });

    // Discord semantics, mirrored by the server's requireDMNotBlocked: a group
    // DM is a shared room, and gating one member's composer over a block with
    // one other member would leave the group reading a conversation that person
    // cannot join. Blocks are enforced when the group is created instead.
    it("does not gate a group DM's composer on block state", () => {
      mockDmStoreGetState.mockReturnValue({
        channels: [
          {
            channelId: 42,
            recipient: { id: 5, username: "alice", avatar: "", status: "online" },
            participants: [
              { id: 5, username: "alice", avatar: "", status: "online" },
              { id: 6, username: "bob", avatar: "", status: "online" },
            ],
            name: "Crew",
            isGroup: true,
            lastMessageId: null,
            lastMessage: "",
            lastMessageAt: "",
            unreadCount: 0,
          },
        ],
      });
      mockDmComposerBlockReason.mockReturnValue("You've blocked this user.");

      const ctrl = createChannelController(makeOpts());
      ctrl.mountChannel(42, "Crew", "dm");

      expect(mockSetDisabled).toHaveBeenLastCalledWith(null);
      expect(blocksSubscribers).toHaveLength(0);
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

    it("destroyChannel closes any open reaction picker — it survives every other teardown path otherwise", () => {
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      ctrl.destroyChannel();

      expect(opts.reactionCtrl.destroy).toHaveBeenCalled();
    });
  });
  // ─── NSFW age gate ────────────────────────────────────────────────────────

  describe("NSFW age gate", () => {
    function seedChannel(nsfw: boolean): void {
      setChannels([
        {
          id: 42,
          name: "spicy",
          type: "text",
          category: null,
          position: 0,
          can_send: true,
          nsfw,
        },
      ]);
    }

    beforeEach(() => {
      sessionStorage.clear();
      mockCreateNsfwGate.mockClear();
      mockNsfwGateMount.mockClear();
      mockNsfwGateDestroy.mockClear();
      capturedNsfwOpts.value = null;
    });

    it("is not mounted for an unflagged channel", () => {
      seedChannel(false);
      const ctrl = createChannelController(makeOpts());
      ctrl.mountChannel(42, "spicy");
      expect(mockCreateNsfwGate).not.toHaveBeenCalled();
      ctrl.destroyChannel();
    });

    it("mounts over the message area for a flagged channel", () => {
      seedChannel(true);
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "spicy");

      expect(mockCreateNsfwGate).toHaveBeenCalledTimes(1);
      expect(capturedNsfwOpts.value.channelId).toBe(42);
      expect(capturedNsfwOpts.value.channelName).toBe("spicy");
      // Over the messages, not over the whole app: the sidebar stays usable.
      expect(mockNsfwGateMount).toHaveBeenCalledWith(opts.slots.messagesSlot);
      ctrl.destroyChannel();
    });

    it("tears the gate down when Continue is accepted", () => {
      seedChannel(true);
      const ctrl = createChannelController(makeOpts());
      ctrl.mountChannel(42, "spicy");

      capturedNsfwOpts.value.onContinue();

      expect(mockNsfwGateDestroy).toHaveBeenCalled();
      ctrl.destroyChannel();
    });

    it("leaves the channel when the reader declines", () => {
      seedChannel(true);
      const ctrl = createChannelController(makeOpts());
      ctrl.mountChannel(42, "spicy");

      capturedNsfwOpts.value.onCancel();

      expect(ctrl.currentChannelId).toBeNull();
      expect(channelsStore.getState().activeChannelId).toBeNull();
    });

    // Once per session: the stored acknowledgement (written by the gate's
    // Continue button, which is stubbed out here) is what suppresses the second
    // ask, so switching away and back must not re-prompt.
    it("does not mount for a channel already acknowledged this session", () => {
      acknowledgeNsfw(42);
      seedChannel(true);
      const ctrl = createChannelController(makeOpts());

      ctrl.mountChannel(42, "spicy");

      expect(mockCreateNsfwGate).not.toHaveBeenCalled();
      ctrl.destroyChannel();
    });

    it("destroys an unaccepted gate when the channel unmounts", () => {
      seedChannel(true);
      const ctrl = createChannelController(makeOpts());
      ctrl.mountChannel(42, "spicy");

      ctrl.destroyChannel();

      expect(mockNsfwGateDestroy).toHaveBeenCalled();
    });
  });
});
