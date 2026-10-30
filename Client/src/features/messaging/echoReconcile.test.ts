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

    it("never consumes an uploading row with equal content (3A-9)", () => {
      expect(isUnreconciledEcho(row({ status: "uploading" }), echo)).toBe(false);
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

describe("echoNormalize bound", () => {
  it("stops after twenty passes on a string that keeps changing", () => {
    // Each pass removes two layers of entity encoding; 41 layers need 21 passes.
    const deep = `a&${"amp;".repeat(40)}lt;b`;
    expect(echoNormalize(deep)).toBe("a&lt;b");
  });

  it("finishes a string that settles within the bound", () => {
    const settles = `a&${"amp;".repeat(38)}lt;b`;
    expect(echoNormalize(settles)).toBe("a<b");
  });
});

describe("isUnreconciledEcho matching", () => {
  const candidate = row({ id: 9, status: "sent", correlationId: null, content: "hi" });

  it("matches a pending or OFFLINE-failed row with the same author and text", () => {
    expect(isUnreconciledEcho(row({ status: "pending" }), candidate)).toBe(true);
    expect(isUnreconciledEcho(row({ status: "failed", errorCode: "OFFLINE" }), candidate)).toBe(
      true,
    );
  });

  it("never matches a row that is delivered, uploading or failed for another reason", () => {
    expect(isUnreconciledEcho(row({ status: "sent" }), candidate)).toBe(false);
    expect(isUnreconciledEcho(row({ status: "uploading" }), candidate)).toBe(false);
    expect(isUnreconciledEcho(row({ status: "failed", errorCode: "SLOW_MODE" }), candidate)).toBe(
      false,
    );
    expect(isUnreconciledEcho(row({ status: "failed", errorCode: null }), candidate)).toBe(false);
  });

  it("a row that is not awaiting an ack never matches, whatever its error code says", () => {
    expect(isUnreconciledEcho(row({ status: "uploading", errorCode: "OFFLINE" }), candidate)).toBe(
      false,
    );
    expect(isUnreconciledEcho(row({ status: "sent", errorCode: "OFFLINE" }), candidate)).toBe(
      false,
    );
  });

  it("needs a correlation id and the same author", () => {
    expect(isUnreconciledEcho(row({ correlationId: null }), candidate)).toBe(false);
    expect(
      isUnreconciledEcho(row({ user: { id: 2, username: "bob", avatar: null } }), candidate),
    ).toBe(false);
  });

  it("matches text exactly even when sanitising it would change it", () => {
    const literal = "fish &amp; chips";
    expect(isUnreconciledEcho(row({ content: literal }), { ...candidate, content: literal })).toBe(
      true,
    );
  });

  it("matches the server's sanitised form of what was typed, and nothing else", () => {
    expect(
      isUnreconciledEcho(row({ content: "<b>bold</b>" }), { ...candidate, content: "bold" }),
    ).toBe(true);
    expect(isUnreconciledEcho(row({ content: "hi" }), { ...candidate, content: "bye" })).toBe(
      false,
    );
  });

  it("matches by client id alone when the optimistic row has one", () => {
    const optimistic = row({ clientMessageId: "m-1", content: "typed" });
    expect(
      isUnreconciledEcho(optimistic, { ...candidate, clientMessageId: "m-1", content: "other" }),
    ).toBe(true);
    expect(isUnreconciledEcho(optimistic, { ...candidate, clientMessageId: "m-2" })).toBe(false);
    expect(isUnreconciledEcho(optimistic, candidate)).toBe(false);
    expect(
      isUnreconciledEcho(row({ clientMessageId: "m-1", status: "sent" }), {
        ...candidate,
        clientMessageId: "m-1",
      }),
    ).toBe(false);
    expect(
      isUnreconciledEcho(optimistic, {
        ...candidate,
        clientMessageId: "m-1",
        user: { id: 2, username: "bob", avatar: null },
      }),
    ).toBe(false);
  });
});
