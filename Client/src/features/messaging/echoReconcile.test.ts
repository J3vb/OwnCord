import { describe, it, expect } from "vitest";
import { echoNormalize, isUnreconciledEcho } from "./echoReconcile";
import type { Message } from "./messageModel";

function row(overrides: Partial<Message>): Message {
  return {
    id: 0,
    channelId: 1,
    user: { id: 1, username: "me", avatar: null },
    content: "hi",
    replyTo: null,
    attachments: [],
    reactions: [],
    pinned: false,
    editedAt: null,
    deleted: false,
    timestamp: "2026-03-15T10:00:00Z",
    status: "pending",
    correlationId: "c-1",
    errorCode: null,
    ...overrides,
  };
}

describe("echoNormalize", () => {
  it.each([
    ["plain text", "plain text"],
    ["a&lt;b&gt;c", "ac"],
    ["&amp;lt;b&amp;gt;x", "x"],
    ["5 &#60; 6", "5 < 6"],
    ["&#x41;&#x62;", "Ab"],
    ["&quot;q&quot; &#39;s&#39; &apos;a&apos; x&nbsp;y", "\"q\" 's' 'a' x\u00a0y"],
    ["<b>bold</b> text", "bold text"],
    ["<<b>script>", "script>"],
    ["a < b", "a < b"],
    ["&amp;amp;", "&"],
  ])("normalizes %j to %j", (input, expected) => {
    expect(echoNormalize(input)).toBe(expected);
  });
});

describe("isUnreconciledEcho", () => {
  const echo = row({ id: 9, status: "sent", correlationId: null });

  describe("with a stable client message id", () => {
    const own = row({ clientMessageId: "m-1", content: "typed" });
    const withId = row({ id: 9, status: "sent", correlationId: null, clientMessageId: "m-1" });

    it("matches the same author and id whatever the content", () => {
      expect(isUnreconciledEcho(own, { ...withId, content: "other" })).toBe(true);
    });

    it("matches a failed row too", () => {
      expect(isUnreconciledEcho({ ...own, status: "failed", errorCode: "SLOW_MODE" }, withId)).toBe(
        true,
      );
    });

    it("never falls back to text", () => {
      expect(isUnreconciledEcho({ ...own, content: "hi" }, echo)).toBe(false);
    });

    it("rejects a sent row, another author or another id", () => {
      expect(isUnreconciledEcho({ ...own, status: "sent" }, withId)).toBe(false);
      expect(isUnreconciledEcho(own, { ...withId, user: { ...withId.user, id: 2 } })).toBe(false);
      expect(isUnreconciledEcho(own, { ...withId, clientMessageId: "m-2" })).toBe(false);
    });
  });

  describe("by text", () => {
    it("matches a pending row with identical content", () => {
      expect(isUnreconciledEcho(row({}), echo)).toBe(true);
    });

    it("matches an OFFLINE-failed row", () => {
      expect(isUnreconciledEcho(row({ status: "failed", errorCode: "OFFLINE" }), echo)).toBe(true);
    });

    it("matches the server-sanitized echo of what was typed", () => {
      expect(isUnreconciledEcho(row({ content: "<b>hi</b>" }), echo)).toBe(true);
    });

    it.each([
      ["a server-rejected failure", { status: "failed", errorCode: "SLOW_MODE" }],
      ["a failure with no code", { status: "failed", errorCode: null }],
      ["a sent row", { status: "sent" }],
      ["a row with no correlation id", { correlationId: null }],
      ["another author", { user: { id: 2, username: "bob", avatar: null } }],
      ["different content", { content: "bye" }],
    ] as const)("rejects %s", (_, overrides) => {
      expect(isUnreconciledEcho(row(overrides), echo)).toBe(false);
    });
  });
});
