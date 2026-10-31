import { vi, beforeEach } from "vitest";
import { deactivatePendingMessages } from "@lib/pendingMessages";
import { createChannelController } from "../../src/pages/main-page/ChannelController";
import type {
  ChannelController,
  ChannelControllerOptions,
} from "../../src/pages/main-page/ChannelController";
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

/** Builds a controller from fresh options and mounts a channel on it. */
export function mountController(
  overrides: Partial<ChannelControllerOptions> = {},
  channelId = 42,
  channelName = "general",
): { opts: ChannelControllerOptions; ctrl: ChannelController } {
  const opts = makeOpts(overrides);
  const ctrl = createChannelController(opts);
  ctrl.mountChannel(channelId, channelName);
  return { opts, ctrl };
}

/** Makes ws.send hand out sequential client ids: cid-1, cid-2, ... */
export function installSendIds(opts: ChannelControllerOptions): void {
  let next = 0;
  vi.mocked(opts.ws.send).mockImplementation(() => `cid-${++next}`);
}

/** mountController with sequential send ids installed before the channel mounts. */
export function mountControllerWithSendIds(): {
  opts: ChannelControllerOptions;
  ctrl: ChannelController;
} {
  const opts = makeOpts();
  installSendIds(opts);
  const ctrl = createChannelController(opts);
  ctrl.mountChannel(42, "general");
  return { opts, ctrl };
}

export function makeChatHeaderRefs(): NonNullable<ChannelControllerOptions["chatHeaderRefs"]> {
  return {
    hashEl: document.createElement("span"),
    nameEl: document.createElement("span"),
    topicEl: document.createElement("span"),
    callBtn: document.createElement("button"),
    videoCallBtn: document.createElement("button"),
    profileBtn: document.createElement("button"),
    membersBtn: document.createElement("button"),
    memberListBtn: document.createElement("button"),
    callChatBtn: document.createElement("button"),
    avatarEl: document.createElement("span"),
    sidebarToggle: document.createElement("button"),
    nameGroupEl: document.createElement("div"),
  };
}

export interface DmUser {
  id: number;
  username: string;
  avatar: string;
  status: string;
}

export function dmUser(id: number, username: string, status = "online"): DmUser {
  return { id, username, avatar: "", status };
}

export interface DmSummaryStub {
  channelId: number;
  recipient: DmUser;
  participants: DmUser[];
  name: string;
  isGroup: boolean;
  lastMessageId: number | null;
  lastMessage: string;
  lastMessageAt: string;
  unreadCount: number;
}

/** A DM summary for channel 42 whose recipient is the first participant. */
export function dmSummary(
  participants: [DmUser, ...DmUser[]],
  extra: Partial<DmSummaryStub> = {},
): DmSummaryStub {
  return {
    channelId: 42,
    recipient: participants[0],
    participants,
    name: "",
    isGroup: false,
    lastMessageId: null,
    lastMessage: "",
    lastMessageAt: "",
    unreadCount: 0,
    ...extra,
  };
}

/** The frames the controller handed to ws.send, filtered by type. */
export function sentFrames(opts: ChannelControllerOptions, type: string): unknown[][] {
  return (opts.ws.send as ReturnType<typeof vi.fn>).mock.calls.filter(
    ([frame]) => (frame as { type: string }).type === type,
  );
}
