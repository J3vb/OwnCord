import { vi, beforeEach } from "vitest";
import { deactivatePendingMessages } from "@lib/pendingMessages";
import type { ChannelControllerOptions } from "../../src/pages/main-page/ChannelController";
import { setConnectionStatus } from "@stores/ui.store";
import {
  mockStartEdit,
  mockIsEditing,
  mockIsIdle,
  dmStoreSubscribers,
  membersStoreSubscribers,
  mockDmComposerBlockReason,
  blocksSubscribers,
  resetCapturedOpts,
} from "./channelControllerMocks";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function makeSlots(): ChannelControllerOptions["slots"] {
  return {
    messagesSlot: document.createElement("div"),
    typingSlot: document.createElement("div"),
    inputSlot: document.createElement("div"),
  };
}

export function makeOpts(
  overrides: Partial<ChannelControllerOptions> = {},
): ChannelControllerOptions {
  return {
    ws: {
      send: vi.fn(),
      getState: vi.fn(() => "connected"),
      onStateChange: vi.fn(() => vi.fn()),
      // The composer subscribes to chat_send_ok / error to drive slow mode.
      on: vi.fn(() => vi.fn()),
      onSendFailure: vi.fn(() => vi.fn()),
    } as unknown as ChannelControllerOptions["ws"],
    api: {
      uploadFile: vi.fn().mockResolvedValue({ id: 1, url: "/f/1", filename: "f.txt" }),
      gifFavorites: vi.fn().mockResolvedValue({ favorites: [] }),
    } as unknown as ChannelControllerOptions["api"],
    msgCtrl: {
      loadMessages: vi.fn(),
      loadOlderMessages: vi.fn(),
      loadNewerMessages: vi.fn(),
    },
    reactionCtrl: {
      handleReaction: vi.fn(),
      destroy: vi.fn(),
    },
    typingLimiter: { tryConsume: vi.fn(() => true) },
    showToast: vi.fn(),
    getCurrentUserId: () => 1,
    slots: makeSlots(),
    chatHeaderName: document.createElement("span"),
    chatHeaderRefs: null,
    ...overrides,
  };
}

/** Registers the shared beforeEach for the "createChannelController" describe. */
export function useChannelControllerHarness(): void {
  beforeEach(() => {
    deactivatePendingMessages();
    vi.clearAllMocks();
    resetCapturedOpts();
    blocksSubscribers.length = 0;
    dmStoreSubscribers.length = 0;
    membersStoreSubscribers.length = 0;
    mockDmComposerBlockReason.mockReturnValue(null);
    mockIsIdle.mockReturnValue(true);
    mockIsEditing.mockReturnValue(false);
    mockStartEdit.mockReturnValue(true);
    // The controller gates sends on the store-backed connection status
    // (docs/architecture/ux §3), not on ws.getState().
    setConnectionStatus("connected");
  });
}
