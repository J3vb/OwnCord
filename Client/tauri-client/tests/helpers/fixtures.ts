/**
 * Test data factories for OwnCord protocol types.
 * Every factory returns a new object with sensible defaults.
 * Pass partial overrides to customize individual fields.
 */

import type {
  MessageResponse,
  MemberResponse,
  ReadyChannel,
  ReactionSummary,
  VoiceStatePayload,
  ReadyMember,
  ReadyVoiceState,
  ReadyRole,
  ReadyPayload,
  ChatMessagePayload,
  MessageUser,
  Attachment,
} from "@lib/types";

// ---------------------------------------------------------------------------
// Atomic factories
// ---------------------------------------------------------------------------

/** Create a MessageResponse with sensible defaults. */
export function makeMessage(
  overrides?: Partial<MessageResponse>,
): MessageResponse {
  return {
    id: 1,
    channel_id: 1,
    user: { id: 1, username: "testuser", avatar: null },
    content: "Hello, world!",
    reply_to: null,
    attachments: [],
    reactions: [],
    pinned: false,
    edited_at: null,
    deleted: false,
    timestamp: "2026-03-15T12:00:00Z",
    ...overrides,
  };
}

/** Create a MemberResponse with sensible defaults. */
export function makeMember(
  overrides?: Partial<MemberResponse>,
): MemberResponse {
  return {
    id: 1,
    username: "testuser",
    avatar: null,
    role: "member",
    status: "online",
    ...overrides,
  };
}

/** Create a ReadyChannel with sensible defaults. */
export function makeChannel(
  overrides?: Partial<ReadyChannel>,
): ReadyChannel {
  return {
    id: 1,
    name: "general",
    type: "text",
    category: "Text Channels",
    position: 0,
    unread_count: 0,
    last_message_id: undefined,
    ...overrides,
  };
}

/** Create a ReactionSummary with sensible defaults. */
export function makeReaction(
  overrides?: Partial<ReactionSummary>,
): ReactionSummary {
  return {
    emoji: "👍",
    count: 1,
    me: false,
    ...overrides,
  };
}

/** Create a VoiceStatePayload with sensible defaults. */
export function makeVoiceState(
  overrides?: Partial<VoiceStatePayload>,
): VoiceStatePayload {
  return {
    channel_id: 3,
    user_id: 1,
    username: "testuser",
    muted: false,
    deafened: false,
    speaking: false,
    camera: false,
    screenshare: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Composite factories
// ---------------------------------------------------------------------------

/** Create a MessageUser with sensible defaults. */
export function makeMessageUser(
  overrides?: Partial<MessageUser>,
): MessageUser {
  return {
    id: 1,
    username: "testuser",
    avatar: null,
    ...overrides,
  };
}

/** Create an Attachment with sensible defaults. */
export function makeAttachment(
  overrides?: Partial<Attachment>,
): Attachment {
  return {
    id: "att-1",
    filename: "image.png",
    size: 1024,
    mime: "image/png",
    url: "/uploads/image.png",
    ...overrides,
  };
}

/** Create a ChatMessagePayload (WS wire format) with sensible defaults. */
export function makeChatMessagePayload(
  overrides?: Partial<ChatMessagePayload>,
): ChatMessagePayload {
  return {
    id: 1,
    channel_id: 1,
    user: { id: 1, username: "testuser", avatar: null },
    content: "Hello, world!",
    reply_to: null,
    attachments: [],
    timestamp: "2026-03-15T12:00:00Z",
    ...overrides,
  };
}

/** Create a ReadyMember with sensible defaults. */
export function makeReadyMember(
  overrides?: Partial<ReadyMember>,
): ReadyMember {
  return {
    id: 1,
    username: "testuser",
    avatar: null,
    role: "member",
    status: "online",
    ...overrides,
  };
}

/** Create a ReadyVoiceState with sensible defaults. */
export function makeReadyVoiceState(
  overrides?: Partial<ReadyVoiceState>,
): ReadyVoiceState {
  return {
    channel_id: 3,
    user_id: 1,
    muted: false,
    deafened: false,
    ...overrides,
  };
}

/** Create a ReadyRole with sensible defaults. */
export function makeReadyRole(
  overrides?: Partial<ReadyRole>,
): ReadyRole {
  return {
    id: 1,
    name: "Member",
    color: null,
    permissions: 0x3,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Full ready payload fixture
// ---------------------------------------------------------------------------

/** Create a full ReadyPayload fixture for integration tests. */
export function makeReadyPayload(
  overrides?: Partial<ReadyPayload>,
): ReadyPayload {
  return {
    channels: [
      makeChannel({ id: 1, name: "general", type: "text", position: 0, unread_count: 3, last_message_id: 100 }),
      makeChannel({ id: 2, name: "random", type: "text", position: 1, unread_count: 0, last_message_id: 50 }),
      makeChannel({ id: 3, name: "Voice Chat", type: "voice", category: "Voice Channels", position: 0 }),
    ],
    members: [
      makeReadyMember({ id: 1, username: "admin", role: "admin", status: "online" }),
      makeReadyMember({ id: 2, username: "user1", role: "member", status: "online" }),
    ],
    voice_states: [
      makeReadyVoiceState({ user_id: 1, channel_id: 3 }),
    ],
    roles: [
      makeReadyRole({ id: 1, name: "Owner", color: "#e74c3c", permissions: 0x7FFFFFFF }),
      makeReadyRole({ id: 2, name: "Admin", color: "#f1c40f", permissions: 0x3FFFFFFF }),
      makeReadyRole({ id: 3, name: "Member", color: null, permissions: 0x3 }),
    ],
    ...overrides,
  };
}
