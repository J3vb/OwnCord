/**
 * Inline media players for video/audio attachments.
 *
 * The property under test is the renderer's *shape decision*: which MIME types
 * become a real player, which stay a download chip, and that the player's
 * source goes through the same authenticated fetch images use (the files
 * endpoint is permission-checked, so an unauthenticated <video src> would 401).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock, saveMock, writeFileMock, createObjectURLMock, revokeObjectURLMock } = vi.hoisted(
  () => ({
    fetchMock: vi.fn(),
    saveMock: vi.fn(),
    writeFileMock: vi.fn(),
    createObjectURLMock: vi.fn(),
    revokeObjectURLMock: vi.fn(),
  }),
);

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: fetchMock }));
vi.mock("@lib/httpProxy", () => ({
  ensureHttpProxy: () => Promise.resolve("http://127.0.0.1:9999"),
  stopHttpProxy: () => Promise.resolve(),
}));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: saveMock }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeFile: writeFileMock }));
vi.mock("@lib/icons", () => ({ createIcon: () => document.createElement("span") }));
vi.mock("@lib/media-visibility", () => ({ observeMedia: vi.fn() }));
vi.mock("../../src/components/message-list/media", () => ({ openImageLightbox: vi.fn() }));
vi.mock("@stores/auth.store", () => ({ getToken: () => "session-token" }));

import {
  clearAttachmentCaches,
  isAudioMime,
  isVideoMime,
  renderAttachment,
  setServerHost,
} from "../../src/components/message-list/attachments";
import type { Attachment } from "@lib/types";

function att(overrides: Partial<Attachment> & Pick<Attachment, "mime">): Attachment {
  return {
    id: "a1",
    url: "https://myserver.local:8443/api/v1/files/a1",
    filename: "clip.bin",
    size: 4096,
    ...overrides,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  createObjectURLMock.mockReset();
  revokeObjectURLMock.mockReset();
  createObjectURLMock.mockReturnValue("blob:mock-1");
  // Patch the object-URL statics onto the real URL constructor — replacing the
  // whole global would break `new URL(...)`, which isSafeUrl relies on.
  URL.createObjectURL = createObjectURLMock;
  URL.revokeObjectURL = revokeObjectURLMock;
  clearAttachmentCaches();
  setServerHost("myserver.local:8443");
});

describe("isVideoMime / isAudioMime", () => {
  it("accepts the containers a <video> element can actually play", () => {
    expect(isVideoMime("video/mp4")).toBe(true);
    expect(isVideoMime("video/webm")).toBe(true);
    expect(isVideoMime("video/ogg")).toBe(true);
  });

  it("accepts the common audio containers and their aliases", () => {
    for (const mime of ["audio/mpeg", "audio/mp3", "audio/ogg", "audio/wav", "audio/x-wav"]) {
      expect(isAudioMime(mime)).toBe(true);
    }
  });

  it("ignores codec parameters and casing", () => {
    expect(isVideoMime('VIDEO/MP4; codecs="avc1.42E01E"')).toBe(true);
    expect(isAudioMime("Audio/Mpeg")).toBe(true);
  });

  it("rejects unknown containers rather than handing them to a player", () => {
    expect(isVideoMime("video/x-matroska")).toBe(false);
    expect(isVideoMime("video/quicktime")).toBe(false);
    expect(isAudioMime("audio/flac")).toBe(false);
  });

  it("never matches SVG or other image types", () => {
    expect(isVideoMime("image/svg+xml")).toBe(false);
    expect(isAudioMime("image/svg+xml")).toBe(false);
    expect(isVideoMime("image/png")).toBe(false);
  });
});

describe("renderAttachment — video", () => {
  it("renders an inline <video> with controls and metadata preload", () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: () => "video/mp4" },
      arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
    });

    const el = renderAttachment(att({ mime: "video/mp4", filename: "clip.mp4" }));

    expect(el.classList.contains("msg-video")).toBe(true);
    // Shares the image box, so a video is capped to the same max dimensions.
    expect(el.classList.contains("msg-image")).toBe(true);
    const video = el.querySelector("video");
    expect(video).not.toBeNull();
    expect(video?.controls).toBe(true);
    expect(video?.getAttribute("preload")).toBe("metadata");
    expect(el.querySelector(".msg-file-download")).not.toBeNull();
  });

  it("sources the player from the authenticated fetch, not the raw URL", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: () => "video/mp4" },
      arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
    });

    const el = renderAttachment(att({ mime: "video/webm", filename: "clip.webm" }));
    const video = el.querySelector("video") as HTMLVideoElement;

    await vi.waitFor(() => {
      expect(video.src).toContain("blob:mock-1");
    });

    // Server-bound: routed through the cert-pinned proxy origin with the
    // session bearer token attached.
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe("http://127.0.0.1:9999/api/v1/files/a1");
    expect(init.headers["Authorization"]).toBe("Bearer session-token");
  });

  it("marks the wrapper failed (keeping the download button) when the fetch fails", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 });

    const el = renderAttachment(att({ mime: "video/mp4", filename: "clip.mp4" }));

    await vi.waitFor(() => {
      expect(el.classList.contains("msg-media-failed")).toBe(true);
    });
    expect(el.querySelector("video")?.src).toBe("");
    expect(el.querySelector(".msg-file-download")).not.toBeNull();
  });

  it("reuses one download when the same attachment is rendered twice", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: () => "video/mp4" },
      arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
    });

    const first = renderAttachment(att({ mime: "video/mp4" }));
    await vi.waitFor(() => {
      expect((first.querySelector("video") as HTMLVideoElement).src).toContain("blob:");
    });
    const second = renderAttachment(att({ mime: "video/mp4" }));
    await vi.waitFor(() => {
      expect((second.querySelector("video") as HTMLVideoElement).src).toContain("blob:");
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
  });

  it("revokes cached blob URLs when the attachment caches are cleared", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: () => "video/mp4" },
      arrayBuffer: () => Promise.resolve(new Uint8Array([1]).buffer),
    });

    const el = renderAttachment(att({ mime: "video/mp4" }));
    await vi.waitFor(() => {
      expect((el.querySelector("video") as HTMLVideoElement).src).toContain("blob:");
    });

    clearAttachmentCaches();
    expect(revokeObjectURLMock).toHaveBeenCalledWith("blob:mock-1");
  });
});

describe("renderAttachment — audio", () => {
  it("renders an inline <audio> row with filename, size, and download", () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: () => "audio/mpeg" },
      arrayBuffer: () => Promise.resolve(new Uint8Array([1]).buffer),
    });

    const el = renderAttachment(
      att({ mime: "audio/mpeg", filename: "voice-note.mp3", size: 1536 }),
    );

    expect(el.classList.contains("msg-audio")).toBe(true);
    const audio = el.querySelector("audio");
    expect(audio).not.toBeNull();
    expect(audio?.controls).toBe(true);
    expect(audio?.getAttribute("preload")).toBe("metadata");
    expect(el.querySelector(".msg-file-name")?.textContent).toBe("voice-note.mp3");
    expect(el.querySelector(".msg-file-size")?.textContent).toBe("1.5 KB");
    expect(el.querySelector(".msg-file-download")).not.toBeNull();
    expect(el.querySelector("video")).toBeNull();
  });

  it("sets the player source from the authenticated fetch", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: () => "audio/wav" },
      arrayBuffer: () => Promise.resolve(new Uint8Array([1]).buffer),
    });

    const el = renderAttachment(att({ mime: "audio/wav", filename: "sound.wav" }));
    const audio = el.querySelector("audio") as HTMLAudioElement;

    await vi.waitFor(() => {
      expect(audio.src).toContain("blob:mock-1");
    });
  });
});

describe("renderAttachment — unhandled types still get a chip", () => {
  it.each([
    ["application/zip", "archive.zip"],
    ["image/svg+xml", "diagram.svg"],
    ["video/x-matroska", "movie.mkv"],
    ["audio/flac", "track.flac"],
    ["text/plain", "notes.txt"],
  ])("%s renders the download chip, not a player", (mime, filename) => {
    const el = renderAttachment(att({ mime, filename }));

    expect(el.querySelector("video")).toBeNull();
    expect(el.querySelector("audio")).toBeNull();
    expect(el.classList.contains("msg-file")).toBe(true);
    expect(el.querySelector(".msg-file-name")?.textContent).toBe(filename);
    expect(el.querySelector(".msg-file-download")).not.toBeNull();
  });

  it("falls back to the chip for a media MIME behind an unsafe URL", () => {
    const el = renderAttachment(att({ mime: "video/mp4", url: "javascript:alert(1)" }));

    expect(el.querySelector("video")).toBeNull();
    expect(el.classList.contains("msg-file")).toBe(true);
  });
});
