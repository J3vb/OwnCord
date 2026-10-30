import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (vi.hoisted so they're available in vi.mock factories)
// ---------------------------------------------------------------------------

export const {
  mockLogError,
  mockInviteManagerMount,
  mockInviteManagerDestroy,
  mockPinnedMessagesMount,
  mockPinnedMessagesDestroy,
  mockPinnedSetPins,
  mockPinnedRemovePin,
  mockPinnedSetOnUnpin,
  mockShowToast,
  mockQuickSwitcherMount,
  mockQuickSwitcherDestroy,
  mockSearchOverlayMount,
  mockSearchOverlayDestroy,
  mockSetActiveChannel,
  mockSetMessagePinned,
  mockCanManageInvites,
  mockMe,
} = {
  mockMe: { value: "me" },
  mockCanManageInvites: { value: true },
  mockLogError: vi.fn(),
  mockInviteManagerMount: vi.fn(),
  mockInviteManagerDestroy: vi.fn(),
  mockPinnedMessagesMount: vi.fn(),
  mockPinnedMessagesDestroy: vi.fn(),
  mockPinnedSetPins: vi.fn(),
  mockPinnedRemovePin: vi.fn(),
  mockPinnedSetOnUnpin: vi.fn(),
  mockShowToast: vi.fn(),
  mockQuickSwitcherMount: vi.fn(),
  mockQuickSwitcherDestroy: vi.fn(),
  mockSearchOverlayMount: vi.fn(),
  mockSearchOverlayDestroy: vi.fn(),
  mockSetActiveChannel: vi.fn(),
  mockSetMessagePinned: vi.fn(),
};

export function loggerMock() {
  return {
    createLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: mockLogError,
    }),
  };
}

export function quickSwitcherMock() {
  return {
    createQuickSwitcher: vi.fn(() => ({
      mount: mockQuickSwitcherMount,
      destroy: mockQuickSwitcherDestroy,
    })),
  };
}

export function inviteManagerMock() {
  return {
    createInviteManager: vi.fn(() => ({
      mount: mockInviteManagerMount,
      destroy: mockInviteManagerDestroy,
    })),
  };
}

export function pinnedMessagesMock() {
  return {
    createPinnedMessages: vi.fn(() => ({
      mount: mockPinnedMessagesMount,
      destroy: mockPinnedMessagesDestroy,
      setPins: mockPinnedSetPins,
      removePin: mockPinnedRemovePin,
      setOnUnpin: mockPinnedSetOnUnpin,
    })),
  };
}

export function searchOverlayMock() {
  return {
    createSearchOverlay: vi.fn(() => ({
      mount: mockSearchOverlayMount,
      destroy: mockSearchOverlayDestroy,
    })),
  };
}

// B9-7: channel 99 is labelled NSFW and not acknowledged. Real stores, so the
// controller's live subscriptions run.
export async function channelsStoreMock() {
  const { createStore } = await import("@lib/store");
  return {
    setActiveChannel: mockSetActiveChannel,
    // navigateToChannel (the switcher's pick path) also clears the badge.
    clearUnread: vi.fn(),
    channelsStore: createStore({
      channels: new Map<number, Record<string, unknown>>([
        [99, { nsfw: true }],
        [3, { id: 3, name: "voice-lobby", type: "voice" }],
        [4, { id: 4, name: "general", type: "text" }],
        [42, { id: 42, name: "pins", type: "text", canPin: true }],
      ]),
    }),
  };
}

export async function messagesStoreMock() {
  const { createStore } = await import("@lib/store");
  return {
    messagesStore: createStore({ pinRevision: new Map<number, number>() }),
    setMessagePinned: mockSetMessagePinned,
  };
}

export function authStoreMock() {
  return {
    authStore: { getState: () => ({ user: { username: mockMe.value } }) },
  };
}

export function permissionsMock() {
  return {
    canManageInvites: () => mockCanManageInvites.value,
  };
}

export function uiToastMock() {
  return {
    initToast: vi.fn(),
    teardownToast: vi.fn(),
    showToast: mockShowToast,
  };
}
