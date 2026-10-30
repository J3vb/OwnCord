/**
 * Inline media players for video/audio attachments.
 *
 * The property under test is the renderer's *shape decision*: which MIME types
 * become a real player, which stay a download chip, and that the player's
 * source goes through the same authenticated fetch images use (the files
 * endpoint is permission-checked, so an unauthenticated <video src> would 401).
 * Nothing is downloaded until the viewer presses play (DP-16, D2 (a)).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock, saveMock, writeFileMock, createObjectURLMock, revokeObjectURLMock, playMock } =
  vi.hoisted(() => ({
    fetchMock: vi.fn(),
    saveMock: vi.fn(),
    writeFileMock: vi.fn(),
    createObjectURLMock: vi.fn(),
    revokeObjectURLMock: vi.fn(),
    playMock: vi.fn(),
  }));

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: fetchMock }));
vi.mock("@lib/net/httpProxy", () => ({
  ensureHttpProxy: () => Promise.resolve("http://127.0.0.1:9999"),
  stopHttpProxy: () => Promise.resolve(),
}));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: saveMock }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeFile: writeFileMock }));
vi.mock("@lib/icons", () => ({ createIcon: () => document.createElement("span") }));
vi.mock("@lib/prefs/mediaVisibility", () => ({ observeMedia: vi.fn() }));
vi.mock("../../src/components/message-list/media", () => ({ openImageLightbox: vi.fn() }));
vi.mock("@stores/auth.store", () => ({
  getToken: () => "session-token",
  authStore: { getState: () => ({ uploadPolicy: null }) },
}));

import {
  clearAttachmentCaches,
  fetchMediaAsObjectUrl,
  isAudioMime,
  isVideoAttachment,
  isVideoMime,
  renderAttachment,
  setServerHost,
} from "../../src/components/message-list/attachments";
import type { Attachment } from "@lib/types";

/** Press the play button that stands in for the player until it is wanted.
 *  A video shows it only once its link request has come back empty. */
async function pressPlay(el: HTMLElement): Promise<void> {
  await vi.waitFor(() => expect(el.querySelector(".msg-media-play")).not.toBeNull());
  (el.querySelector(".msg-media-play") as HTMLButtonElement).click();
}

/** A server without file links (the link POST answers 404) whose file route
 *  answers `fileResponse`: the blob path these tests cover. */
function serveBlob(fileResponse: unknown): void {
  fetchMock.mockImplementation((_url: string, init?: { method?: string }) =>
    Promise.resolve(init?.method === "POST" ? { ok: false, status: 404 } : fileResponse),
  );
}

/** The calls that fetched the file itself, not a link for it. */
function fileCalls(): unknown[][] {
  return fetchMock.mock.calls.filter(
    ([, init]) => (init as { method?: string })?.method !== "POST",
  );
}

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
  // jsdom implements no playback.
  playMock.mockReset();
  playMock.mockResolvedValue(undefined);
  HTMLMediaElement.prototype.play = playMock;
  clearAttachmentCaches();
  setServerHost("myserver.local:8443");
  document.body.innerHTML = "";
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

  it("accepts QuickTime, which Chromium's demuxers read", () => {
    expect(isVideoMime("video/quicktime")).toBe(true);
    expect(isVideoMime("video/x-m4v")).toBe(true);
    expect(isVideoMime("video/x-matroska")).toBe(true);
    expect(isVideoMime("video/3gpp")).toBe(true);
  });

  it("rejects unknown containers rather than handing them to a player", () => {
    expect(isVideoMime("video/x-msvideo")).toBe(false);
    expect(isVideoMime("video/x-flv")).toBe(false);
    expect(isAudioMime("audio/flac")).toBe(false);
  });

  it("never matches SVG or other image types", () => {
    expect(isVideoMime("image/svg+xml")).toBe(false);
    expect(isAudioMime("image/svg+xml")).toBe(false);
    expect(isVideoMime("image/png")).toBe(false);
  });
});

describe("isVideoAttachment", () => {
  it("trusts a video MIME whatever the filename", () => {
    expect(isVideoAttachment({ mime: "video/mp4", filename: "clip" })).toBe(true);
  });

  // A .mov uploaded before the server learned QuickTime was stored as
  // application/octet-stream; its extension is all that says it is a video.
  it.each(["clip.mov", "clip.MOV"])("treats an untyped %s as a video", (filename) => {
    expect(isVideoAttachment({ mime: "application/octet-stream", filename })).toBe(true);
    expect(isVideoAttachment({ mime: "", filename })).toBe(true);
  });

  it.each(["clip.mp4", "clip.m4v", "clip.webm", "clip.mkv", "clip.3gp", "clip.ogv"])(
    "treats an untyped %s as a video",
    (filename) => {
      expect(isVideoAttachment({ mime: "application/octet-stream", filename })).toBe(true);
    },
  );

  it("does not let an extension override a real non-video type", () => {
    expect(isVideoAttachment({ mime: "text/plain", filename: "clip.mov" })).toBe(false);
    expect(isVideoAttachment({ mime: "image/svg+xml", filename: "clip.mp4" })).toBe(false);
  });

  it("keeps .avi a download: the engines do not read it", () => {
    expect(isVideoAttachment({ mime: "application/octet-stream", filename: "clip.avi" })).toBe(
      false,
    );
    expect(isVideoAttachment({ mime: "video/avi", filename: "clip.avi" })).toBe(false);
  });

  it("leaves an untyped file with another extension on the chip", () => {
    expect(isVideoAttachment({ mime: "application/octet-stream", filename: "clip.avi" })).toBe(
      false,
    );
    expect(isVideoAttachment({ mime: "application/octet-stream", filename: "mov" })).toBe(false);
  });
});

describe("renderAttachment — video", () => {
  it.each([
    ["video/quicktime", "clip.mov"],
    ["application/octet-stream", "clip.mov"],
    ["video/webm", "clip.webm"],
  ])("renders %s %s as a player", (mime, filename) => {
    const el = renderAttachment(att({ mime, filename }));
    expect(el.classList.contains("msg-video")).toBe(true);
    expect(el.querySelector("video")).not.toBeNull();
  });

  /** Render a video, press play and wait for its source to arrive. */
  async function playedVideo(): Promise<HTMLVideoElement> {
    serveBlob({
      ok: true,
      headers: { get: () => "video/quicktime" },
      arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
    });
    const el = document.body.appendChild(
      renderAttachment(att({ mime: "video/quicktime", filename: "clip.mov", size: 2048 })),
    );
    const video = el.querySelector("video") as HTMLVideoElement;
    await pressPlay(el);
    await vi.waitFor(() => expect(video.src).toContain("blob:mock-1"));
    return video;
  }

  function expectUnplayableChip(): void {
    expect(document.querySelector("video")).toBeNull();
    const chip = document.querySelector(".msg-file") as HTMLElement;
    expect(chip).not.toBeNull();
    expect(chip.querySelector(".msg-file-name")?.textContent).toBe("clip.mov");
    expect(chip.querySelector(".msg-file-download")).not.toBeNull();
    expect(chip.querySelector(".msg-file-note")?.textContent).toBe("Can't play this format");
  }

  it("swaps a player the engine cannot decode for the download chip", async () => {
    const video = await playedVideo();
    video.dispatchEvent(new Event("error"));
    expectUnplayableChip();
  });

  // A codec the engine lacks (HEVC, ProRes) or an audio-only file typed as
  // video loads metadata with no picture: it keeps playing as audio.
  it("switches a player with no picture to the audio player and keeps playing", async () => {
    const video = await playedVideo();
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(document.querySelector("video")).toBeNull();
    const row = document.querySelector(".msg-audio") as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.querySelector(".msg-file-name")?.textContent).toBe("clip.mov");
    expect(row.querySelector(".msg-file-download")).not.toBeNull();
    expect(row.querySelector(".msg-file-note")?.textContent).toBe(
      "Video picture cannot be shown on this device",
    );
    const audio = row.querySelector("audio") as HTMLAudioElement;
    expect(audio.hidden).toBe(false);
    expect(audio.controls).toBe(true);
    expect(audio.src).toContain("blob:mock-1");
    expect(row.querySelector(".msg-media-play")).toBeNull();
  });

  it("resumes playback on the audio player when the video was playing", async () => {
    const video = await playedVideo();
    Object.defineProperty(video, "paused", { value: false });
    playMock.mockClear();
    video.dispatchEvent(new Event("loadedmetadata"));
    const audio = document.querySelector(".msg-audio audio");
    expect(playMock).toHaveBeenCalledTimes(1);
    expect(playMock.mock.contexts[0]).toBe(audio);
  });

  it("moves focus to the download button when the chip replaces a focused player", async () => {
    const video = await playedVideo();
    (document.querySelector(".msg-video .msg-file-download") as HTMLElement).focus();
    video.dispatchEvent(new Event("error"));
    expect(document.activeElement).toBe(document.querySelector(".msg-file .msg-file-download"));
  });

  it("moves focus to the download button when the audio row replaces a focused video", async () => {
    const video = await playedVideo();
    (document.querySelector(".msg-video .msg-file-download") as HTMLElement).focus();
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(document.activeElement).toBe(document.querySelector(".msg-audio .msg-file-download"));
  });

  it("leaves focus alone when the swap happens while nothing in the player has it", async () => {
    const video = await playedVideo();
    video.dispatchEvent(new Event("error"));
    expect(document.activeElement).toBe(document.body);
  });

  it("sizes a player to the clip's real ratio once metadata loads", async () => {
    const video = await playedVideo();
    Object.defineProperty(video, "videoWidth", { value: 1080 });
    Object.defineProperty(video, "videoHeight", { value: 1920 });
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(video.style.aspectRatio.replace(/\s/g, "")).toBe("1080/1920");
    // Scaled into the 400x300 box: 300 tall, so 169 wide, no black bars.
    expect(video.style.width).toBe("169px");
  });

  it("never scales a small clip up", async () => {
    const video = await playedVideo();
    Object.defineProperty(video, "videoWidth", { value: 320 });
    Object.defineProperty(video, "videoHeight", { value: 240 });
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(video.style.width).toBe("320px");
  });

  it("widens a tiny clip so its controls fit", async () => {
    const video = await playedVideo();
    Object.defineProperty(video, "videoWidth", { value: 40 });
    Object.defineProperty(video, "videoHeight", { value: 40 });
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(video.style.width).toBe("120px");
    expect(video.style.aspectRatio.replace(/\s/g, "")).toBe("40/40");
  });

  it("letterboxes a very tall clip instead of passing the box height", async () => {
    const video = await playedVideo();
    Object.defineProperty(video, "videoWidth", { value: 100 });
    Object.defineProperty(video, "videoHeight", { value: 10000 });
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(video.style.width).toBe("120px");
    expect(video.style.aspectRatio.replace(/\s/g, "")).toBe("120/300");
  });

  it("caps a wide clip at the box width", async () => {
    const video = await playedVideo();
    Object.defineProperty(video, "videoWidth", { value: 1920 });
    Object.defineProperty(video, "videoHeight", { value: 1080 });
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(video.style.width).toBe("400px");
  });

  it("keeps a played clip's shape when the row is rebuilt", async () => {
    const video = await playedVideo();
    Object.defineProperty(video, "videoWidth", { value: 1080 });
    Object.defineProperty(video, "videoHeight", { value: 1920 });
    video.dispatchEvent(new Event("loadedmetadata"));

    const rebuilt = renderAttachment(att({ mime: "video/quicktime", filename: "clip.mov" }));
    const again = rebuilt.querySelector("video") as HTMLVideoElement;
    expect(again.style.width).toBe("169px");
    expect(again.style.aspectRatio.replace(/\s/g, "")).toBe("1080/1920");
  });

  it("sizes a player from server dimensions before anything is fetched", () => {
    const el = renderAttachment(att({ mime: "video/mp4", width: 480, height: 480 }));
    const video = el.querySelector("video") as HTMLVideoElement;
    expect(video.style.width).toBe("300px");
    expect(video.style.aspectRatio.replace(/\s/g, "")).toBe("480/480");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the CSS placeholder when the size is unknown", () => {
    const el = renderAttachment(att({ mime: "video/mp4" }));
    const video = el.querySelector("video") as HTMLVideoElement;
    expect(video.style.width).toBe("");
    expect(video.style.aspectRatio).toBe("");
  });

  it("keeps a player whose video decodes", async () => {
    const video = await playedVideo();
    Object.defineProperty(video, "videoWidth", { value: 1280 });
    Object.defineProperty(video, "videoHeight", { value: 720 });
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(document.querySelector("video")).toBe(video);
    expect(document.querySelector(".msg-file")).toBeNull();
  });

  it("falls back to a labelled play button when the server has no file links", async () => {
    serveBlob({ ok: false, status: 403 });
    const el = renderAttachment(att({ mime: "video/mp4", filename: "clip.mp4" }));

    expect(el.classList.contains("msg-video")).toBe(true);
    // Shares the image box, so a video is capped to the same max dimensions.
    expect(el.classList.contains("msg-image")).toBe(true);
    const video = el.querySelector("video");
    expect(video).not.toBeNull();
    expect(video?.getAttribute("preload")).toBe("metadata");
    // Native controls are inert without a source, so they appear with it.
    expect(video?.controls).toBe(false);
    await vi.waitFor(() => expect(el.querySelector(".msg-media-play")).not.toBeNull());
    expect(el.querySelector(".msg-media-play")?.getAttribute("aria-label")).toBe("Play clip.mp4");
    expect(el.querySelector(".msg-file-download")).not.toBeNull();
  });

  it("downloads nothing until play is pressed", async () => {
    serveBlob({
      ok: true,
      headers: { get: () => "video/mp4" },
      arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
    });

    const el = document.body.appendChild(
      renderAttachment(att({ mime: "video/mp4", filename: "clip.mp4" })),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(fileCalls()).toHaveLength(0);

    await pressPlay(el);

    const video = el.querySelector("video") as HTMLVideoElement;
    await vi.waitFor(() => {
      expect(video.src).toContain("blob:mock-1");
    });
    expect(fileCalls()).toHaveLength(1);
    expect(video.controls).toBe(true);
    expect(playMock).toHaveBeenCalledTimes(1);
    expect(el.querySelector(".msg-media-play")).toBeNull();
  });

  it("sources the player from the authenticated fetch, not the raw URL", async () => {
    serveBlob({
      ok: true,
      headers: { get: () => "video/mp4" },
      arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
    });

    const el = renderAttachment(att({ mime: "video/webm", filename: "clip.webm" }));
    const video = el.querySelector("video") as HTMLVideoElement;
    await pressPlay(el);

    await vi.waitFor(() => {
      expect(video.src).toContain("blob:mock-1");
    });

    // Server-bound: routed through the cert-pinned proxy origin with the
    // session bearer token attached.
    const [url, init] = fileCalls()[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe("http://127.0.0.1:9999/api/v1/files/a1");
    expect(init.headers["Authorization"]).toBe("Bearer session-token");
  });

  it("marks the wrapper failed (keeping the download button) when the fetch fails", async () => {
    serveBlob({ ok: false, status: 403 });

    const el = renderAttachment(att({ mime: "video/mp4", filename: "clip.mp4" }));
    await pressPlay(el);

    await vi.waitFor(() => {
      expect(el.classList.contains("msg-media-failed")).toBe(true);
    });
    expect(el.querySelector("video")?.src).toBe("");
    expect(el.querySelector(".msg-file-download")).not.toBeNull();
    // Play stays, so pressing it again retries.
    expect((el.querySelector(".msg-media-play") as HTMLButtonElement).disabled).toBe(false);
  });

  it("reuses one download when the same attachment is rendered twice", async () => {
    serveBlob({
      ok: true,
      headers: { get: () => "video/mp4" },
      arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
    });

    const first = renderAttachment(att({ mime: "video/mp4" }));
    await pressPlay(first);
    await vi.waitFor(() => {
      expect((first.querySelector("video") as HTMLVideoElement).src).toContain("blob:");
    });
    const second = renderAttachment(att({ mime: "video/mp4" }));
    await pressPlay(second);
    await vi.waitFor(() => {
      expect((second.querySelector("video") as HTMLVideoElement).src).toContain("blob:");
    });

    // One refused link request (cached, so not repeated) and one download.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fileCalls()).toHaveLength(1);
    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
  });

  it("revokes cached blob URLs when the attachment caches are cleared", async () => {
    serveBlob({
      ok: true,
      headers: { get: () => "video/mp4" },
      arrayBuffer: () => Promise.resolve(new Uint8Array([1]).buffer),
    });

    const el = renderAttachment(att({ mime: "video/mp4" }));
    await pressPlay(el);
    await vi.waitFor(() => {
      expect((el.querySelector("video") as HTMLVideoElement).src).toContain("blob:");
    });

    clearAttachmentCaches();
    expect(revokeObjectURLMock).toHaveBeenCalledWith("blob:mock-1");
  });

  it("evicts the oldest blob (FIFO) once the media cache cap is exceeded", async () => {
    let nextBlobId = 0;
    createObjectURLMock.mockImplementation(() => `blob:mock-${++nextBlobId}`);
    serveBlob({
      ok: true,
      headers: { get: () => "video/mp4" },
      arrayBuffer: () => Promise.resolve(new Uint8Array([1]).buffer),
    });

    // One more than the cap (20) — the first URL fetched must be evicted (and
    // its blob revoked) to make room for the last one, without ever growing
    // past the cap.
    const urls = Array.from(
      { length: 21 },
      (_, i) => `https://myserver.local:8443/api/v1/files/clip-${i}`,
    );
    for (const url of urls) {
      await fetchMediaAsObjectUrl(url);
    }

    expect(revokeObjectURLMock).toHaveBeenCalledWith("blob:mock-1");
    expect(revokeObjectURLMock).toHaveBeenCalledTimes(1);

    // The evicted URL is gone from the cache — fetching it again re-downloads
    // rather than reusing a stale entry.
    fetchMock.mockClear();
    await fetchMediaAsObjectUrl(urls[0]!);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The most recently fetched entry is still cached (no refetch).
    fetchMock.mockClear();
    await fetchMediaAsObjectUrl(urls[urls.length - 1]!);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("renderAttachment — audio", () => {
  it("renders an inline <audio> row with filename, size, play and download", async () => {
    const el = renderAttachment(
      att({ mime: "audio/mpeg", filename: "voice-note.mp3", size: 1536 }),
    );

    expect(el.classList.contains("msg-audio")).toBe(true);
    const audio = el.querySelector("audio");
    expect(audio).not.toBeNull();
    // The player appears with its source; until then the play button stands in.
    expect(audio?.hidden).toBe(true);
    expect(audio?.getAttribute("preload")).toBe("metadata");
    expect(el.querySelector(".msg-media-play")?.getAttribute("aria-label")).toBe(
      "Play voice-note.mp3",
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(el.querySelector(".msg-file-name")?.textContent).toBe("voice-note.mp3");
    expect(el.querySelector(".msg-file-size")?.textContent).toBe("1.5 KB");
    expect(el.querySelector(".msg-file-download")).not.toBeNull();
    expect(el.querySelector("video")).toBeNull();
  });

  it("sets the player source from the authenticated fetch", async () => {
    serveBlob({
      ok: true,
      headers: { get: () => "audio/wav" },
      arrayBuffer: () => Promise.resolve(new Uint8Array([1]).buffer),
    });

    const el = document.body.appendChild(
      renderAttachment(att({ mime: "audio/wav", filename: "sound.wav" })),
    );
    const audio = el.querySelector("audio") as HTMLAudioElement;
    await pressPlay(el);

    await vi.waitFor(() => {
      expect(audio.src).toContain("blob:mock-1");
    });
    expect(audio.hidden).toBe(false);
    expect(audio.controls).toBe(true);
    expect(playMock).toHaveBeenCalledTimes(1);
  });

  it("does not start a player whose row left the document while downloading", async () => {
    let respond!: (value: unknown) => void;
    fetchMock.mockReturnValue(new Promise((resolve) => (respond = resolve)));

    const el = document.body.appendChild(
      renderAttachment(att({ mime: "audio/wav", filename: "sound.wav" })),
    );
    const audio = el.querySelector("audio") as HTMLAudioElement;
    await pressPlay(el);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    el.remove();
    respond({
      ok: true,
      headers: { get: () => "audio/wav" },
      arrayBuffer: () => Promise.resolve(new Uint8Array([1]).buffer),
    });

    await vi.waitFor(() => {
      expect(audio.src).toContain("blob:mock-1");
    });
    expect(audio.hidden).toBe(false);
    expect(audio.controls).toBe(true);
    expect(playMock).not.toHaveBeenCalled();
  });
});

describe("renderAttachment — unhandled types still get a chip", () => {
  it.each([
    ["application/zip", "archive.zip"],
    ["image/svg+xml", "diagram.svg"],
    ["video/x-msvideo", "movie.avi"],
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
