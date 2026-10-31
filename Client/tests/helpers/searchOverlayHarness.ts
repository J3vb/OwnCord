import { vi } from "vitest";
import type { SearchOverlayOptions } from "../../src/components/SearchOverlay";
import type { SearchResultItem } from "../../src/lib/types";
import type { DmChannel } from "../../src/stores/dm.store";

export function makeDmChannel(overrides: Partial<DmChannel> = {}): DmChannel {
  return {
    channelId: 42,
    recipient: { id: 2, username: "bob", avatar: "", status: "online" },
    participants: [{ id: 2, username: "bob", avatar: "", status: "online" }],
    name: "",
    isGroup: false,
    lastMessageId: null,
    lastMessage: "",
    lastMessageAt: "",
    unreadCount: 0,
    mentionCount: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function makeResult(overrides: Partial<SearchResultItem> = {}): SearchResultItem {
  return {
    message_id: 1,
    channel_id: 42,
    channel_name: "general",
    user: { id: 1, username: "alice", avatar: null },
    content: "hello world",
    timestamp: "2026-01-15T12:00:00Z",
    ...overrides,
  };
}

export function makeOptions(overrides: Partial<SearchOverlayOptions> = {}): SearchOverlayOptions {
  return {
    onSearch: vi.fn().mockResolvedValue({ results: [] }),
    onSelectResult: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}
