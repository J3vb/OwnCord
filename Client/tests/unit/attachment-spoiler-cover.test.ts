// Spoiler attachments in the message list (6.12): covered until revealed, and
// a covered one cannot be opened in the lightbox by click or keyboard.
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
  renderAttachment,
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

function makeMessage(attachments: Message["attachments"]): Message {
  return {
    id: 7,
    channelId: 1,
    user: { id: 10, username: "Alice", avatar: null },
    content: "pics",
    replyTo: null,
    attachments,
    reactions: [],
    pinned: false,
    editedAt: null,
    deleted: false,
    timestamp: "2025-01-15T12:30:00Z",
    status: "sent",
    correlationId: null,
    errorCode: null,
  };
}

const opts = { channelId: 1, channelName: "general", currentUserId: 10 } as MessageListOptions;
const ac = new AbortController();

async function renderRow(msg: Message, imageCount: number): Promise<HTMLElement> {
  const el = renderMessage(msg, false, [msg], opts, ac.signal);
  document.body.appendChild(el);
  await vi.waitFor(() => {
    expect(el.querySelectorAll(".msg-image img").length).toBe(imageCount);
  });
  return el;
}

const lightbox = (): Element | null => document.querySelector(".image-lightbox");

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

describe("spoiler attachment cover", () => {
  it("covers a lone spoiler image, and it cannot be opened by click, Enter or Space", async () => {
    const msg = makeMessage([att("a", "SPOILER_a.png", "image/png")]);
    const el = await renderRow(msg, 1);
    const wrap = el.querySelector<HTMLElement>(".msg-image")!;
    const img = wrap.querySelector("img")!;
    const cover = wrap.querySelector<HTMLButtonElement>(".msg-spoiler-cover")!;

    expect(cover).not.toBeNull();
    expect(cover.getAttribute("aria-label")).toBe("Spoiler — click to reveal");
    expect(cover.textContent).toBe("Spoiler");
    expect(img.hasAttribute("inert")).toBe(true);

    img.click();
    img.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    img.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    img.dispatchEvent(menu);
    await new Promise((r) => setTimeout(r, 20));
    expect(lightbox()).toBeNull();
    expect(menu.defaultPrevented).toBe(true);
    expect(document.querySelector(".image-menu, .context-menu")).toBeNull();
  });

  it("covers a spoiler inside the grid; a plain sibling is not covered", async () => {
    const msg = makeMessage([
      att("a", "a.png", "image/png"),
      att("b", "SPOILER_b.png", "image/png"),
    ]);
    const el = await renderRow(msg, 2);
    const tiles = el.querySelectorAll(".msg-image-grid > .msg-image");
    expect(tiles).toHaveLength(2);
    expect(tiles[0]!.querySelector(".msg-spoiler-cover")).toBeNull();
    expect(tiles[1]!.querySelector(".msg-spoiler-cover")).not.toBeNull();

    tiles[1]!.querySelector("img")!.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(lightbox()).toBeNull();
  });

  it("keeps a spoiler out of the lightbox sequence of its plain siblings", async () => {
    const msg = makeMessage([
      att("a", "a.png", "image/png"),
      att("b", "SPOILER_b.png", "image/png"),
      att("c", "c.png", "image/png"),
    ]);
    messagesStore.setState((prev) => ({ ...prev, messagesByChannel: new Map([[1, [msg]]]) }));
    const el = await renderRow(msg, 3);
    el.querySelectorAll("img")[0]!.click();
    await vi.waitFor(() =>
      expect(document.querySelector(".image-lightbox-counter")?.textContent).toBe("1 of 2"),
    );
  });

  it("reveals on click and on keyboard activation, then opens the lightbox", async () => {
    const msg = makeMessage([att("a", "SPOILER_a.png", "image/png")]);
    const el = await renderRow(msg, 1);
    const wrap = el.querySelector<HTMLElement>(".msg-image")!;
    const cover = wrap.querySelector<HTMLButtonElement>(".msg-spoiler-cover")!;

    // A button's Enter/Space activation arrives as a click.
    cover.click();
    expect(wrap.querySelector(".msg-spoiler-cover")).toBeNull();
    expect(wrap.classList.contains("revealed")).toBe(true);
    const img = wrap.querySelector("img")!;
    expect(img.hasAttribute("inert")).toBe(false);
    expect(lightbox()).toBeNull();

    img.click();
    await vi.waitFor(() => expect(lightbox()).not.toBeNull());
  });

  it("locks media that arrives after the first paint, and covers a video", () => {
    const video = renderAttachment(att("v", "SPOILER_clip.mp4", "video/mp4"));
    expect(video.querySelector(".msg-spoiler-cover")).not.toBeNull();
    expect(video.querySelector("video")!.hasAttribute("inert")).toBe(true);
    const late = document.createElement("img");
    video.appendChild(late);
    return vi.waitFor(() => expect(late.hasAttribute("inert")).toBe(true));
  });

  it("leaves a plain image, a non-media spoiler file and audio uncovered", () => {
    for (const a of [
      att("p", "plain.png", "image/png"),
      att("t", "SPOILER_notes.txt", "text/plain"),
      att("s", "SPOILER_song.mp3", "audio/mpeg"),
    ]) {
      expect(renderAttachment(a).querySelector(".msg-spoiler-cover")).toBeNull();
    }
  });
});
