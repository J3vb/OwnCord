import { describe, expect, it } from "vitest";
import type { Message } from "./messageModel";
import type { MessageResponse } from "../../lib/types";

// The module is loaded inside the test, so the constants it builds at load are
// the ones this test exercises.
describe("history refetch row comparison", () => {
  it("fields only a live row carries do not make a refetched row look changed", async () => {
    const { reduceSetMessages } = await import("./historyWindows");
    const { INITIAL_STATE } = await import("./messageModel");
    const me = { id: 1, username: "me", avatar: null };
    const cached: Message = {
      id: 4,
      channelId: 1,
      user: { ...me, role: "admin", display_name: "Me!" } as Message["user"],
      content: "hi",
      replyTo: null,
      attachments: [],
      reactions: [],
      pinned: false,
      editedAt: null,
      deleted: false,
      timestamp: "2026-03-15T10:00:00Z",
      status: "sent",
      correlationId: null,
      clientMessageId: "m-4",
      errorCode: null,
    };
    const fetched: MessageResponse = {
      id: 4,
      channel_id: 1,
      user: me,
      content: "hi",
      reply_to: null,
      attachments: [],
      reactions: [],
      pinned: false,
      edited_at: null,
      deleted: false,
      timestamp: "2026-03-15T10:00:00Z",
    };
    const prev = { ...INITIAL_STATE, messagesByChannel: new Map([[1, [cached]]]) };
    const next = reduceSetMessages(prev, 1, [fetched], false);
    expect(next.messagesByChannel.get(1)?.[0]).toBe(cached);
  });

  it("a real change to the same row is still picked up", async () => {
    const { reduceSetMessages } = await import("./historyWindows");
    const { INITIAL_STATE } = await import("./messageModel");
    const me = { id: 1, username: "me", avatar: null };
    const cached: Message = {
      id: 4,
      channelId: 1,
      user: me,
      content: "hi",
      replyTo: null,
      attachments: [],
      reactions: [],
      pinned: false,
      editedAt: null,
      deleted: false,
      timestamp: "2026-03-15T10:00:00Z",
      status: "sent",
      correlationId: null,
      errorCode: null,
    };
    const prev = { ...INITIAL_STATE, messagesByChannel: new Map([[1, [cached]]]) };
    const fetched: MessageResponse = {
      id: 4,
      channel_id: 1,
      user: me,
      content: "edited",
      reply_to: null,
      attachments: [],
      reactions: [],
      pinned: false,
      edited_at: "2026-03-15T10:05:00Z",
      deleted: false,
      timestamp: "2026-03-15T10:00:00Z",
    };
    const next = reduceSetMessages(prev, 1, [fetched], false);
    expect(next.messagesByChannel.get(1)?.[0]?.content).toBe("edited");
  });
});
