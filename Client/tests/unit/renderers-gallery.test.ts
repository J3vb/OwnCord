/**
 * Wiring of a message's image attachments into the lightbox sequence
 * (3A-10c): renderers.ts hands renderAttachment the message's images and the
 * attachment's own index, and a store deletion closes the open viewer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: fetchMock }));
vi.mock("@lib/httpProxy", () => ({
  ensureHttpProxy: () => Promise.resolve("http://127.0.0.1:9999"),
  stopHttpProxy: () => Promise.resolve(),
}));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@lib/icons", () => ({ createIcon: () => document.createElement("span") }));
vi.mock("@lib/media-visibility", () => ({ observeMedia: vi.fn() }));

import { renderMessage } from "../../src/components/message-list/renderers";
import {
  clearAttachmentCaches,
  closeActiveLightbox,
  setServerHost,
} from "../../src/components/message-list/attachments";
import { messagesStore, type Message } from "../../src/stores/messages.store";
import type { MessageListOptions } from "../../src/components/MessageList";

const okImage = {
  ok: true,
  headers: { get: () => "image/png" },
  arrayBuffer: () => Promise.resolve(new Uint8Array([1]).buffer),
};
const att = (id: string, filename: string, mime: string) => ({
  id,
  filename,
  size: 10,
  mime,
  url: `/api/v1/files/${id}`,
});

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 7,
    channelId: 1,
    user: { id: 10, username: "Alice", avatar: null },
    content: "pics",
    replyTo: null,
    attachments: [
      att("a", "a.png", "image/png"),
      att("v", "clip.mp4", "video/mp4"),
      att("b", "b.png", "image/png"),
      att("f", "notes.txt", "text/plain"),
      att("c", "c.png", "image/png"),
    ],
    reactions: [],
    pinned: false,
    editedAt: null,
    deleted: false,
    timestamp: "2025-01-15T12:30:00Z",
    status: "sent",
    correlationId: null,
    errorCode: null,
    ...overrides,
  };
}

const opts = { channelId: 1, channelName: "general", currentUserId: 10 } as MessageListOptions;
const ac = new AbortController();
const counter = (): string | null | undefined =>
  document.querySelector(".image-lightbox-counter")?.textContent;

async function renderRow(msg: Message): Promise<HTMLImageElement[]> {
  const el = renderMessage(msg, false, [msg], opts, ac.signal);
  document.body.appendChild(el);
  let imgs: HTMLImageElement[] = [];
  const count = msg.attachments.filter((a) => a.mime.startsWith("image/")).length;
  await vi.waitFor(() => {
    imgs = [...el.querySelectorAll<HTMLImageElement>(".msg-image img")];
    expect(imgs.length).toBe(count);
  });
  return imgs;
}

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

describe("renderers lightbox sequence", () => {
  it("passes the message's images and the clicked index; videos and files are excluded", async () => {
    const msg = makeMessage();
    messagesStore.setState((prev) => ({ ...prev, messagesByChannel: new Map([[1, [msg]]]) }));
    const imgs = await renderRow(msg);

    imgs[1]!.click(); // b.png, the second image
    await vi.waitFor(() => expect(counter()).toBe("2 of 3"));
    expect(document.querySelector(".image-lightbox")?.getAttribute("aria-label")).toBe("b.png");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(counter()).toBe("3 of 3");
    expect(document.querySelector(".image-lightbox")?.getAttribute("aria-label")).toBe("c.png");
  });

  it("opens a lone image, and an unconfirmed row's images, with no arrows", async () => {
    const lone = makeMessage({ attachments: [att("a", "a.png", "image/png")] });
    const [only] = await renderRow(lone);
    only!.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector(".image-lightbox")).not.toBeNull();
    expect(document.querySelector(".image-lightbox-next")).toBeNull();
    closeActiveLightbox();
    document.body.replaceChildren();

    const pending = makeMessage({ id: 0, status: "pending", correlationId: "c1" });
    const imgs = await renderRow(pending);
    imgs[0]!.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector(".image-lightbox")).not.toBeNull();
    expect(document.querySelector(".image-lightbox-next")).toBeNull();
  });

  it("deleting the message in the store closes the open viewer", async () => {
    const msg = makeMessage();
    messagesStore.setState((prev) => ({ ...prev, messagesByChannel: new Map([[1, [msg]]]) }));
    const imgs = await renderRow(msg);
    imgs[0]!.click();
    await vi.waitFor(() => expect(counter()).toBe("1 of 3"));

    messagesStore.setState((prev) => ({
      ...prev,
      messagesByChannel: new Map([[1, [{ ...msg, deleted: true }]]]),
    }));
    messagesStore.flush();

    expect(document.querySelector(".image-lightbox")).toBeNull();
  });
});
