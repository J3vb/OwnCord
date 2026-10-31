import { afterEach, beforeEach, vi, type Mock } from "vitest";
import type { MessageListOptions } from "../../src/components/MessageList";
import {
  clearAttachmentCaches,
  closeActiveLightbox,
  setServerHost,
} from "../../src/features/messaging/content/attachments";
import { messagesStore, type Message } from "../../src/stores/messages.store";
import { buildMessage } from "./messageFactory";

/** A fetch Response carrying a one-byte PNG. */
export const okImage = {
  ok: true,
  headers: { get: () => "image/png" },
  arrayBuffer: () => Promise.resolve(new Uint8Array([1]).buffer),
};

export const att = (id: string, filename: string, mime: string) => ({
  id,
  filename,
  size: 10,
  mime,
  url: `/api/v1/files/${id}`,
});

export const listOpts = {
  channelId: 1,
  channelName: "general",
  currentUserId: 10,
} as MessageListOptions;

/** Message 7 from Alice (id 10) in channel 1, with `content` "pics" unless overridden. */
export function makeAttachmentMessage(overrides: Partial<Message> = {}): Message {
  return buildMessage(
    { id: 7, content: "pics", ...overrides },
    { user: { id: 10, username: "Alice", avatar: null }, timestamp: "2025-01-15T12:30:00Z" },
  );
}

/**
 * Per-test setup for rows that render server images through `fetchMock`:
 * cleared caches, numbered blob: URLs, a local server host and an empty
 * message store; the lightbox and the body are cleaned up afterwards.
 */
export function useImageRowEnv(fetchMock: Mock): void {
  beforeEach(() => {
    clearAttachmentCaches();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(okImage);
    let n = 0;
    URL.createObjectURL = vi.fn(() => `blob:img-${++n}`);
    URL.revokeObjectURL = vi.fn();
    setServerHost("localhost:8080");
    messagesStore.setState((prev) => ({ ...prev, messagesByChannel: new Map() }));
  });

  afterEach(() => {
    closeActiveLightbox();
    document.body.replaceChildren();
    setServerHost("");
  });
}
