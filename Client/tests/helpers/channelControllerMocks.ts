import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

export const {
  mockMessageListMount,
  mockMessageListDestroy,
  mockMessageInputMount,
  mockMessageInputDestroy,
  mockTypingMount,
  mockTypingDestroy,
  mockGetChannelMessages,
  mockSetReplyTo,
  mockStartEdit,
  mockCancelEdit,
  mockIsEditing,
  mockInputFocus,
  mockIsIdle,
  mockScrollToMessage,
  mockSetDisabled,
  mockSetSendGate,
  mockSetSlowModeNote,
  mockGetDraft,
  mockRestoreDraft,
  mockRestoreUnsent,
  mockPeekDraft,
} = {
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
      user?: { id: number; username: string; display_name?: string | null };
      sticker?: { id: number | null; name: string; url: string | null };
      attachments?: Array<{ id: string }>;
      deleted?: boolean;
      status?: string;
      correlationId?: string;
      errorCode?: string | null;
    }> => [],
  ),
  mockSetReplyTo: vi.fn(),
  // The list owns the inline editor now: startEdit says whether one opened.
  mockStartEdit: vi.fn((_id: number, _text?: string) => true),
  mockCancelEdit: vi.fn(),
  mockIsEditing: vi.fn(() => false),
  mockInputFocus: vi.fn(),
  mockIsIdle: vi.fn(() => true),
  mockScrollToMessage: vi.fn(() => true),
  mockSetDisabled: vi.fn(),
  mockSetSendGate: vi.fn(),
  mockSetSlowModeNote: vi.fn(),
  mockGetDraft: vi.fn<
    () => {
      content: string;
      replyTo: { messageId: number; username: string } | null;
      attachments: { id: string; filename: string }[];
      uploads?: { filename: string; owner: { destroy(): void } }[];
    }
  >(() => ({ content: "", replyTo: null, attachments: [] })),
  mockRestoreDraft: vi.fn(),
  mockRestoreUnsent: vi.fn(),
  mockPeekDraft: vi.fn<
    () => { content: string; replyTo: { messageId: number; username: string } | null }
  >(() => ({ content: "", replyTo: null })),
};

// Captured from the mock factories; typed at the call sites.
export let capturedMessageListOpts: any = null;

export let capturedMessageInputOpts: any = null;

// The gate component itself is covered by nsfw-gate.test.ts; what the
// controller owns is WHETHER and with what it is mounted.
export const {
  mockNsfwGateMount,
  mockNsfwGateDestroy,
  mockCreateNsfwGate,
  capturedNsfwOpts,
  mockConsentBarMount,
  mockConsentBarDestroy,
  capturedBarOpts,
} = {
  mockNsfwGateMount: vi.fn(),
  mockNsfwGateDestroy: vi.fn(),
  mockCreateNsfwGate: vi.fn(),
  capturedNsfwOpts: { value: null as any },
  mockConsentBarMount: vi.fn(),
  mockConsentBarDestroy: vi.fn(),
  capturedBarOpts: { value: null as any },
};

export const { mockSetMessagePinned, mockAddOptimistic, mockMarkSendFailed, mockRemoveOptimistic } =
  {
    mockSetMessagePinned: vi.fn(),
    mockAddOptimistic: vi.fn(),
    mockMarkSendFailed: vi.fn(),
    mockRemoveOptimistic: vi.fn(),
  };

export const { mockMarkChannelRead, mockLeaveChannel, mockMarkChannelReadSeen } = {
  mockMarkChannelRead: vi.fn(),
  mockLeaveChannel: vi.fn(),
  mockMarkChannelReadSeen: vi.fn(),
};

export const { mockRole } = { mockRole: { value: "member" } };

/** The messages store's per-message pin revisions, which a chat_pinned moves. */
export const { mockPinRevisions } = { mockPinRevisions: new Map<number, number>() };

export const {
  mockReattachToPresent,
  mockJumpToMessage,
  mockIsWindowDetached,
  mockInvalidateWindow,
  mockClearChannelContent,
} = {
  mockReattachToPresent: vi.fn(),
  mockJumpToMessage: vi.fn(),
  mockIsWindowDetached: vi.fn(() => false),
  mockInvalidateWindow: vi.fn(),
  mockClearChannelContent: vi.fn(),
};

export const { mockUpdateChatHeaderForDm } = {
  mockUpdateChatHeaderForDm: vi.fn(),
};

export const {
  mockDmStoreGetState,
  mockMembersStoreGetState,
  dmStoreSubscribers,
  membersStoreSubscribers,
} = {
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
};

export const { fetchImageAsObjectUrl } = { fetchImageAsObjectUrl: vi.fn() };

// Block-state gating: capture the subscription callback so tests can simulate a
// live change (block/unblock) and mock the reason the store reports.
export const { mockBlocksGetState, mockDmComposerBlockReason, blocksSubscribers } = {
  mockBlocksGetState: vi.fn(() => ({ blockedByMe: new Set<number>(), blockedByThem: new Set() })),
  mockDmComposerBlockReason: vi.fn((): string | null => null),
  blocksSubscribers: [] as Array<() => void>,
};

export const { mockThreadOpenById } = { mockThreadOpenById: vi.fn() };

export { loggerMock } from "./loggerMock";

export function domMock() {
  return {
    createElement: vi.fn((tag: string, attrs?: Record<string, string>, textContent?: string) => {
      const el = document.createElement(tag);
      if (attrs) {
        for (const [key, value] of Object.entries(attrs)) {
          if (key === "class") el.className = value;
          else el.setAttribute(key, value);
        }
      }
      if (textContent !== undefined) el.textContent = textContent;
      return el;
    }),
    clearChildren: vi.fn((el: HTMLElement) => {
      el.innerHTML = "";
    }),
    setText: vi.fn((el: HTMLElement, text: string) => {
      el.textContent = text;
    }),
  };
}

export function messageListMock() {
  return {
    createMessageList: vi.fn((opts: any) => {
      capturedMessageListOpts = opts;
      return {
        mount: mockMessageListMount,
        destroy: mockMessageListDestroy,
        scrollToMessage: mockScrollToMessage,
        setReplyTo: mockSetReplyTo,
        startEdit: mockStartEdit,
        cancelEdit: mockCancelEdit,
        isEditing: mockIsEditing,
      };
    }),
  };
}

export function messageInputMock() {
  return {
    createMessageInput: vi.fn((opts: any) => {
      capturedMessageInputOpts = opts;
      return {
        mount: mockMessageInputMount,
        destroy: mockMessageInputDestroy,
        setReplyTo: mockSetReplyTo,
        clearReply: vi.fn(),
        focus: mockInputFocus,
        isIdle: mockIsIdle,
        setDisabled: mockSetDisabled,
        setSendGate: mockSetSendGate,
        setSlowModeNote: mockSetSlowModeNote,
        getDraft: mockGetDraft,
        restoreDraft: mockRestoreDraft,
        restoreUnsent: mockRestoreUnsent,
        peekDraft: mockPeekDraft,
      };
    }),
  };
}

export async function nsfwGateMock() {
  return {
    nsfwConsentText: (
      await vi.importActual<typeof import("../../src/i18n/nsfwConsent")>(
        "../../src/i18n/nsfwConsent",
      )
    ).nsfwConsentText,
    createNsfwGate: (opts: any) => {
      capturedNsfwOpts.value = opts;
      mockCreateNsfwGate(opts);
      return { mount: mockNsfwGateMount, destroy: mockNsfwGateDestroy };
    },
    createNsfwConsentBar: (opts: any) => {
      capturedBarOpts.value = opts;
      return { mount: mockConsentBarMount, destroy: mockConsentBarDestroy };
    },
  };
}

export function typingIndicatorMock() {
  return {
    createTypingIndicator: vi.fn(() => ({
      mount: mockTypingMount,
      destroy: mockTypingDestroy,
    })),
  };
}

export function readStateMock() {
  return {
    // threads.store registers its thread check at load.
    setKnownThreadCheck: vi.fn(),
    setThreadReadPointer: vi.fn(),
    markChannelRead: mockMarkChannelRead,
    leaveChannel: mockLeaveChannel,
    markChannelReadSeen: mockMarkChannelReadSeen,
  };
}

export function messagesStoreMock() {
  return {
    messagesStore: {
      getState: () => ({ messagePinRevision: mockPinRevisions }),
    },
    getChannelMessages: mockGetChannelMessages,
    setMessagePinned: mockSetMessagePinned,
    addOptimisticMessage: mockAddOptimistic,
    markSendFailed: mockMarkSendFailed,
    removeOptimistic: mockRemoveOptimistic,
    reattachToPresent: mockReattachToPresent,
    isWindowDetached: mockIsWindowDetached,
    invalidateChannelMessageWindow: mockInvalidateWindow,
    clearChannelContent: mockClearChannelContent,
  };
}

export function navMessageNavigationMock() {
  return {
    jumpToMessage: mockJumpToMessage,
  };
}

export function authStoreMock() {
  return {
    authStore: {
      getState: () => ({ user: { id: 1, username: "tester", avatar: null, role: mockRole.value } }),
    },
    onAuthCleared: vi.fn(() => () => {}),
  };
}

export async function pageChatHeaderMock(importOriginal: <T>() => Promise<T>) {
  return {
    ...(await importOriginal<typeof import("../../src/pages/main-page/ChatHeader")>()),
    updateChatHeaderForDm: mockUpdateChatHeaderForDm,
  };
}

export async function dmStoreMock() {
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
    clearDmUnread: vi.fn(),
  };
}

export async function listAttachmentsMock(importOriginal: <T>() => Promise<T>) {
  return {
    ...(await importOriginal<typeof import("../../src/features/messaging/content/attachments")>()),
    fetchImageAsObjectUrl,
  };
}

export function membersStoreMock() {
  return {
    membersStore: {
      getState: mockMembersStoreGetState,
      subscribeSelector: vi.fn((_sel: unknown, cb: () => void) => {
        membersStoreSubscribers.push(cb);
        return () => {};
      }),
    },
  };
}

export function blocksStoreMock() {
  return {
    blocksStore: {
      getState: mockBlocksGetState,
      subscribeSelector: vi.fn((_sel: unknown, cb: () => void) => {
        blocksSubscribers.push(cb);
        return () => {};
      }),
    },
    dmComposerBlockReason: mockDmComposerBlockReason,
  };
}

// Only tests that pass a threadSlot get a thread panel host.
export function pageThreadPanelHostMock() {
  return {
    createThreadPanelHost: vi.fn(() => ({
      open: vi.fn(),
      openById: mockThreadOpenById,
      close: vi.fn(),
      openThreadId: null,
      destroy: vi.fn(),
    })),
  };
}

export function resetCapturedOpts(): void {
  capturedMessageListOpts = null;
  capturedMessageInputOpts = null;
}
