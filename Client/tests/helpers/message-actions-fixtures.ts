// Shared fixtures for the message action gates and the message right-click
// menu tests: a sent message, list options with spy callbacks, a channel with
// the server's permission verdicts, and a signed-in role.
import { vi } from "vitest";
import type { MessageListOptions } from "../../src/components/MessageList";
import { authStore } from "../../src/stores/auth.store";
import { channelsStore, setRoles, type Channel } from "../../src/stores/channels.store";
import { messagesStore, type Message } from "../../src/stores/messages.store";
import { setConnectionStatus } from "../../src/stores/ui.store";
import { setActiveTimeout } from "../../src/features/safety/store";
import { resetAuthState } from "./storeSeeds";

/** MANAGE_MESSAGES (see lib/types Permission). */
const MANAGE_MESSAGES = 0x10000;

export const ME = 10;
export const OTHER = 11;

export function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 1,
    channelId: 1,
    user: { id: OTHER, username: "alice", avatar: null },
    content: "hello world",
    replyTo: null,
    attachments: [],
    reactions: [],
    pinned: false,
    editedAt: null,
    deleted: false,
    timestamp: "2024-01-15T12:00:00Z",
    status: "sent",
    correlationId: null,
    errorCode: null,
    ...overrides,
  };
}

export function makeOpts(overrides: Partial<MessageListOptions> = {}): MessageListOptions {
  return {
    channelId: 1,
    channelName: "general",
    currentUserId: ME,
    onScrollTop: vi.fn(),
    onReplyClick: vi.fn(),
    onEditClick: vi.fn(),
    onEditSave: vi.fn(() => true),
    onEmptyEdit: vi.fn(),
    onDeleteClick: vi.fn(),
    onReactionClick: vi.fn(),
    onPinClick: vi.fn(),
    ...overrides,
  };
}

export function setChannel(overrides: Partial<Channel> = {}): void {
  const channel: Channel = {
    id: 1,
    name: "general",
    type: "text",
    category: null,
    topic: "",
    position: 0,
    unreadCount: 0,
    mentionCount: 0,
    lastMessageId: null,
    canSend: true,
    slowMode: 0,
    nsfw: false,
    isPrivate: false,
    voiceMaxUsers: 0,
    voiceMaxVideo: 0,
    ...overrides,
  };
  channelsStore.setState((prev) => ({
    ...prev,
    channels: new Map([[channel.id, channel]]),
  }));
}

/** Sign in as a plain member or as a moderator (MANAGE_MESSAGES). */
export function signInAs(role: "member" | "moderator"): void {
  setRoles([
    { id: 2, name: "moderator", color: null, permissions: MANAGE_MESSAGES },
    { id: 3, name: "member", color: null, permissions: 0 },
  ]);
  authStore.setState(() => ({
    token: "tok",
    user: { id: ME, username: "me", avatar: null, role },
    serverName: null,
    motd: null,
    isAuthenticated: true,
  }));
}

/** Back to a connected, signed-out, no-channel, not-timed-out baseline. */
export function resetGateStores(): void {
  channelsStore.setState((prev) => ({ ...prev, channels: new Map(), roles: [] }));
  resetAuthState();
  setConnectionStatus("connected");
  setActiveTimeout(null);
}

/** Flip the developer-mode preference the way Settings does. */
export function setDeveloperMode(on: boolean): void {
  localStorage.setItem("owncord:settings:developerMode", on ? "true" : "false");
  window.dispatchEvent(
    new CustomEvent("owncord:pref-change", { detail: { key: "developerMode" } }),
  );
}

/** Replace the message store with exactly `messages` in channel 1. */
export function seedMessages(messages: Message[]): void {
  messagesStore.setState(() => ({
    messagesByChannel: new Map([[1, messages]]),
    pendingSends: new Map(),
    loadedChannels: new Set(),
    hasMore: new Map(),
    historyLoadState: new Map(),
    detachedChannels: new Set(),
  }));
}
