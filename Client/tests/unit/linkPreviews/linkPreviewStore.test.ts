import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async () => (await import("../helpers/ws-mocks")).tauriCoreMock());
vi.mock("@tauri-apps/api/event", async () =>
  (await import("../helpers/ws-mocks")).tauriEventMock(),
);

import { eventHandlers, emitTauriEvent } from "../helpers/ws-mocks";
import { useWsClientFixture } from "../../helpers/wsClientFixture";
import { authOkFrame, openSocket } from "../../helpers/wsSuiteHarness";
import type { createWsClient } from "../../../src/lib/ws";
import {
  addMessage,
  getChannelMessages,
  messagesStore,
  resetMessagesStore,
  setChannelLoading,
  setMessages,
} from "../../../src/stores/messages.store";
import { handleMessageLinkPreviews } from "../../../src/features/messaging/wsHandlers";
import { compareContentVersion, mergeMessageLinkPreviews } from "../../../src/lib/linkPreviewState";
import { resetServerCapabilities } from "../../../src/lib/net/serverCapabilities";
import { runSessionResets } from "../../../src/lib/net/sessionRegistry";
import type { LinkPreviewCard, MessageResponse } from "../../../src/lib/types";

const CARD_A: LinkPreviewCard = { url: "https://example.com/a", title: "A" };
const CARD_B: LinkPreviewCard = { url: "https://example.com/a", title: "B" };

function chat(id: number, timestamp = "2026-11-13T10:15:30Z") {
  return {
    id,
    channel_id: 1,
    user: { id: 2, username: "bob", avatar: null },
    content: "see https://example.com/a",
    reply_to: null,
    attachments: [],
    timestamp,
  };
}

function frame(id: number, version: string, link_previews: readonly LinkPreviewCard[]) {
  return { message_id: id, channel_id: 1, content_version: version, link_previews };
}

function row(id: number) {
  return getChannelMessages(1).find((m) => m.id === id);
}

function historyRow(id: number, extra: Partial<MessageResponse> = {}): MessageResponse {
  return {
    ...chat(id),
    reactions: [],
    pinned: false,
    edited_at: null,
    deleted: false,
    ...extra,
  } as MessageResponse;
}

beforeEach(() => {
  resetMessagesStore();
  resetServerCapabilities();
});

describe("message_link_previews content_version ordering", () => {
  it("keeps cards for a newer version when an older frame arrives later", () => {
    addMessage(chat(5));
    handleMessageLinkPreviews(frame(5, "2026-11-13 10:15:40", [CARD_B]));
    handleMessageLinkPreviews(frame(5, "2026-11-13 10:15:30", [CARD_A]));
    expect(row(5)?.linkPreviews).toEqual([CARD_B]);
    expect(row(5)?.linkPreviewsVersion).toBe("2026-11-13 10:15:40");
  });

  it("replaces the cards when the frame has the same version", () => {
    addMessage(chat(5));
    handleMessageLinkPreviews(frame(5, "2026-11-13 10:15:30", [CARD_A]));
    handleMessageLinkPreviews(frame(5, "2026-11-13 10:15:30", [CARD_B]));
    expect(row(5)?.linkPreviews).toEqual([CARD_B]);
  });

  it("clears the cards on an empty list but keeps the row a server row", () => {
    addMessage(chat(5));
    handleMessageLinkPreviews(frame(5, "2026-11-13 10:15:30", [CARD_A]));
    handleMessageLinkPreviews(frame(5, "2026-11-13 10:16:00", []));
    expect(row(5)?.linkPreviews).toEqual([]);
  });

  it("ignores a frame for a message that is not loaded", () => {
    const before = messagesStore.getState();
    handleMessageLinkPreviews(frame(99, "2026-11-13 10:15:30", [CARD_A]));
    expect(messagesStore.getState()).toBe(before);
  });

  it("orders a SQLite-style version against an RFC 3339 one by instant", () => {
    expect(compareContentVersion("2026-11-13 10:15:30", "2026-11-13T10:15:30Z")).toBe(0);
    expect(compareContentVersion("2026-11-13 10:15:31", "2026-11-13T10:15:30Z")).toBeGreaterThan(0);
    expect(compareContentVersion("2026-11-13 10:15:29", "2026-11-13T10:15:30+00:00")).toBeLessThan(
      0,
    );
  });
});

describe("history rows and held cards", () => {
  it("keeps the cards of a history row", () => {
    setMessages(1, [historyRow(7, { link_previews: [CARD_A] })], false);
    expect(row(7)?.linkPreviews).toEqual([CARD_A]);
    expect(row(7)?.linkPreviewsVersion).toBe("2026-11-13T10:15:30Z");
  });

  it("a history row with no cards holds none", () => {
    setMessages(1, [historyRow(7)], false);
    expect(row(7)?.linkPreviews).toBeUndefined();
  });

  it("a page fetched before a newer frame does not take the cards back", () => {
    setMessages(1, [historyRow(7)], false);
    handleMessageLinkPreviews(frame(7, "2026-11-13 10:15:30", [CARD_A]));
    // A second read of the same window, answered without cards (backfill pending at read time).
    setMessages(1, [historyRow(7)], false);
    expect(row(7)?.linkPreviews).toEqual([CARD_A]);
  });

  it("an edit newer than the held cards drops them from the merged row", () => {
    addMessage(chat(1));
    handleMessageLinkPreviews(frame(1, "2026-11-13 10:15:30", [CARD_A]));
    const held = row(1)!;
    // A copy read from history without cards, as the server omits an empty list.
    const { linkPreviews: _cards, linkPreviewsVersion: _version, ...bare } = held;
    const edited = { ...bare, editedAt: "2026-11-13T10:20:00Z" };
    expect(mergeMessageLinkPreviews(held, edited).linkPreviews).toBeUndefined();
    expect(mergeMessageLinkPreviews(held, bare).linkPreviews).toEqual([CARD_A]);
  });
});

describe("frames that arrive before the page that holds their row", () => {
  it("a frame between setChannelLoading and the install shows on the installed row", () => {
    setChannelLoading(1);
    // The backfill frame beats the in-flight history page: the row is not loaded yet.
    handleMessageLinkPreviews(frame(7, "2026-11-13T10:15:30Z", [CARD_A]));
    expect(row(7)).toBeUndefined();
    setMessages(1, [historyRow(7)], false);
    expect(row(7)?.linkPreviews).toEqual([CARD_A]);
  });

  it("an older frame replayed onto a page that already has newer cards changes nothing", () => {
    setChannelLoading(1);
    handleMessageLinkPreviews(frame(7, "2026-11-13 10:15:30", [CARD_A]));
    setMessages(
      1,
      [historyRow(7, { link_previews: [CARD_B, CARD_A], edited_at: "2026-11-13T10:16:00Z" })],
      false,
    );
    expect(row(7)?.linkPreviews).toEqual([CARD_B, CARD_A]);
  });

  it("on the same version a page with fewer cards does not replace a frame's fuller list", () => {
    setMessages(1, [historyRow(7)], false);
    handleMessageLinkPreviews(frame(7, "2026-11-13 10:15:30", [CARD_A, CARD_B]));
    setMessages(1, [historyRow(7, { link_previews: [CARD_A] })], false);
    expect(row(7)?.linkPreviews).toEqual([CARD_A, CARD_B]);
  });

  it("a frame older than the row's own edit is dropped even when the row holds no cards", () => {
    setMessages(1, [historyRow(7, { edited_at: "2026-11-13T10:20:00Z" })], false);
    handleMessageLinkPreviews(frame(7, "2026-11-13 10:15:30", [CARD_A]));
    expect(row(7)?.linkPreviews).toBeUndefined();
  });
});

describe("a reconnect or server switch", () => {
  it("forgets the cards with the session", () => {
    addMessage(chat(5));
    handleMessageLinkPreviews(frame(5, "2026-11-13 10:15:30", [CARD_A]));
    runSessionResets("server_switch");

    expect(getChannelMessages(1)).toEqual([]);
    // A late frame for the old server's message finds nothing to write to.
    handleMessageLinkPreviews(frame(5, "2026-11-13 10:15:40", [CARD_B]));
    expect(getChannelMessages(1)).toEqual([]);
  });
});

describe("generation isolation on the socket", () => {
  let client: ReturnType<typeof createWsClient>;
  useWsClientFixture((created) => {
    client = created;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a frame from a superseded connection attempt never reaches the store", async () => {
    // The dispatcher subscribes exactly this way (features/messaging/wsHandlers routes).
    client.on("message_link_previews", handleMessageLinkPreviews);
    await openSocket(client);
    const staleHandlers = [...(eventHandlers.get("ws-message") ?? [])];
    expect(staleHandlers.length).toBeGreaterThan(0);

    // A newer attempt supersedes it, and the new session loads the same message id.
    await openSocket(client, { host: "other.example:8443", token: "t2" });
    emitTauriEvent("ws-message", authOkFrame());
    addMessage(chat(5));

    const stale = JSON.stringify({
      type: "message_link_previews",
      seq: 1,
      payload: frame(5, "2026-11-13 10:15:30", [CARD_A]),
    });
    for (const handler of staleHandlers) handler({ payload: stale });

    expect(row(5)?.linkPreviews).toBeUndefined();

    // The live attempt's own frame is applied.
    emitTauriEvent("ws-message", stale);
    expect(row(5)?.linkPreviews).toEqual([CARD_A]);
  });
});
