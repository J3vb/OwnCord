// A voice message in the message list (WP 8.9): an attachment with a waveform
// and a length renders as the player whatever MIME the server sniffed, the row
// carries no empty text line, nothing downloads before the first play, and the
// upload carries the two voice query params.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: fetchMock }));
vi.mock("@lib/net/httpProxy", () => ({
  ensureHttpProxy: () => Promise.resolve("http://127.0.0.1:9999"),
  stopHttpProxy: () => Promise.resolve(),
}));
vi.mock("@lib/prefs/mediaVisibility", () => ({ observeMedia: vi.fn() }));

import { renderMessage } from "../../src/components/message-list/renderers";
import {
  clearAttachmentCaches,
  renderAttachment,
  setServerHost,
} from "../../src/features/messaging/content/attachments";
import { createApiClient } from "../../src/lib/api";
import { encodeWaveform } from "../../src/features/voice-messages/waveform";
import { messagesStore, type Message } from "../../src/stores/messages.store";
import type { MessageListOptions } from "../../src/components/MessageList";

const waveform = encodeWaveform(Uint8Array.from({ length: 64 }, (_, i) => i * 4));
const voice = {
  id: "v1",
  filename: "voice-message.webm",
  size: 900,
  mime: "video/webm",
  url: "/api/v1/files/v1",
  duration_ms: 12_000,
  waveform,
};

function makeMessage(content: string, attachments: Message["attachments"]): Message {
  return {
    id: 7,
    channelId: 1,
    user: { id: 10, username: "Alice", avatar: null },
    content,
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

beforeEach(() => {
  clearAttachmentCaches();
  fetchMock.mockReset();
  URL.createObjectURL = vi.fn(() => "blob:voice");
  URL.revokeObjectURL = vi.fn();
  setServerHost("localhost:8080");
  messagesStore.setState((prev) => ({ ...prev, messagesByChannel: new Map() }));
});

afterEach(() => {
  document.body.replaceChildren();
  setServerHost("");
});

describe("voice message rendering", () => {
  it("renders the player for a video/webm attachment, without fetching", () => {
    const node = renderAttachment(voice);
    expect(node.classList.contains("msg-voice")).toBe(true);
    expect(node.querySelector("video")).toBeNull();
    expect(node.querySelectorAll(".msg-voice-bar")).toHaveLength(64);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps rendering an attachment without voice metadata as before", () => {
    const { duration_ms: _d, waveform: _w, ...plain } = voice;
    const node = renderAttachment({ ...plain, mime: "audio/ogg" });
    expect(node.classList.contains("msg-voice")).toBe(false);
    expect(node.classList.contains("msg-audio")).toBe(true);
  });

  it("fetches through the authenticated media path on the first play only", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: () => "audio/webm" },
      arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2]).buffer),
    });
    const node = renderAttachment(voice);
    document.body.appendChild(node);
    const audio = node.querySelector("audio")!;
    audio.play = vi.fn(async () => {});
    node.querySelector<HTMLButtonElement>(".msg-voice-play")!.click();
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(audio.getAttribute("src")).toBe("blob:voice");
  });

  it("renders no empty text line for a message that is only a voice message", () => {
    const el = renderMessage(makeMessage("", [voice]), false, [], opts, ac.signal);
    expect(el.querySelector(".msg-voice")).not.toBeNull();
    expect(el.querySelector(".msg-text")).toBeNull();
  });

  it("still renders the text of a voice message that has some", () => {
    const el = renderMessage(makeMessage("listen", [voice]), false, [], opts, ac.signal);
    expect(el.querySelector(".msg-text")?.textContent).toBe("listen");
  });
});

describe("voice upload query", () => {
  it("passes both voice params, or neither", async () => {
    const send = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve({ id: "u", url: "/f", filename: "a", size: 1, mime: "x" }),
      headers: new Headers(),
    });
    fetchMock.mockImplementation(send);
    const api = createApiClient({ host: "localhost:8443", token: "tok" });
    const file = new File(["x"], "voice-message.webm", { type: "audio/webm" });
    await api.uploadFile(file, undefined, undefined, { durationMs: 2_000, waveform: "AQID-_8" });
    expect(send.mock.calls[0]![0]).toBe(
      "http://127.0.0.1:9999/api/v1/uploads?voice_duration_ms=2000&voice_waveform=AQID-_8",
    );
    await api.uploadFile(file);
    expect(send.mock.calls[1]![0]).toBe("http://127.0.0.1:9999/api/v1/uploads");
  });
});
