/**
 * Video files stream from a server-minted file link (WP 8.11).
 *
 * The renderer asks the server for a link when a video row is built and hands
 * it to the <video> element as its source, so the engine streams with Range
 * requests and shows the first frame before play. These tests pin the contract
 * around that: the link is minted once and reused, a link that stops working
 * is replaced exactly once, a server without links (or a link that will not
 * come back) falls back to the play-button blob path with a visible loading
 * state, and the link is never logged.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock, createObjectURLMock, playMock, logMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  createObjectURLMock: vi.fn(),
  playMock: vi.fn(),
  logMock: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: fetchMock }));
vi.mock("@lib/httpProxy", () => ({
  ensureHttpProxy: () => Promise.resolve("http://127.0.0.1:9999/proxytoken"),
  stopHttpProxy: () => Promise.resolve(),
}));
vi.mock("@lib/logger", () => ({ createLogger: () => logMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeFile: vi.fn() }));
vi.mock("@lib/icons", () => ({
  createIcon: (name: string) => {
    const el = document.createElement("span");
    el.dataset["icon"] = name;
    return el;
  },
}));
vi.mock("@lib/media-visibility", () => ({ observeMedia: vi.fn() }));
vi.mock("../../src/components/message-list/media", () => ({ openImageLightbox: vi.fn() }));
vi.mock("@stores/auth.store", () => ({
  getToken: () => "session-token",
  authStore: { getState: () => ({ uploadPolicy: null }) },
}));

import {
  clearAttachmentCaches,
  fetchMediaAsObjectUrl,
  renderAttachment,
  setServerHost,
} from "../../src/components/message-list/attachments";
import type { Attachment } from "@lib/types";

const ORIGIN = "http://127.0.0.1:9999/proxytoken";

function att(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: "a1",
    url: "https://myserver.local:8443/api/v1/files/a1",
    filename: "clip.mp4",
    mime: "video/mp4",
    size: 4096,
    ...overrides,
  };
}

/** One server response for a link POST. */
function linkResponse(token: string, expiresInMs = 60 * 60 * 1000): unknown {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        path: `/api/v1/files/a1?link=${token}`,
        expires_at: new Date(Date.now() + expiresInMs).toISOString(),
      }),
  };
}

const fileBytes = {
  ok: true,
  status: 200,
  headers: { get: () => "video/mp4" },
  arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
};

/** Route the mock: link POSTs get `links` in turn (the last repeats), file
 *  GETs get the bytes. */
function serve(links: unknown[]): void {
  let n = 0;
  fetchMock.mockImplementation((_url: string, init?: { method?: string }) => {
    if (init?.method === "POST") {
      const response = links[Math.min(n, links.length - 1)];
      n += 1;
      return Promise.resolve(response);
    }
    return Promise.resolve(fileBytes);
  });
}

const posts = (): unknown[][] =>
  fetchMock.mock.calls.filter(([, init]) => (init as { method?: string })?.method === "POST");
const gets = (): unknown[][] =>
  fetchMock.mock.calls.filter(([, init]) => (init as { method?: string })?.method !== "POST");

function mount(attachment: Attachment = att()): { el: HTMLElement; video: HTMLVideoElement } {
  const el = document.body.appendChild(renderAttachment(attachment));
  return { el, video: el.querySelector("video") as HTMLVideoElement };
}

/** Fail the element the way an engine does, with a MediaError code. */
function failVideo(video: HTMLVideoElement, code?: number): void {
  Object.defineProperty(video, "error", {
    value: code === undefined ? null : { code },
    configurable: true,
  });
  video.dispatchEvent(new Event("error"));
}

beforeEach(() => {
  fetchMock.mockReset();
  createObjectURLMock.mockReset();
  createObjectURLMock.mockReturnValue("blob:mock-1");
  URL.createObjectURL = createObjectURLMock;
  URL.revokeObjectURL = vi.fn();
  playMock.mockReset();
  playMock.mockResolvedValue(undefined);
  HTMLMediaElement.prototype.play = playMock;
  Object.values(logMock).forEach((fn) => fn.mockClear());
  clearAttachmentCaches();
  setServerHost("myserver.local:8443");
  document.body.innerHTML = "";
});

describe("video streams from a file link", () => {
  it("mints a link on render and uses it as the player source", async () => {
    serve([linkResponse("tok1")]);
    const { el, video } = mount();

    await vi.waitFor(() => expect(video.src).toContain("link=tok1"));
    expect(video.src).toBe(`${ORIGIN}/api/v1/files/a1?link=tok1`);
    expect(video.getAttribute("preload")).toBe("metadata");
    expect(video.controls).toBe(true);
    expect(el.querySelector(".msg-media-play")).toBeNull();
    expect(el.querySelector(".msg-file-download")).not.toBeNull();

    // One tiny POST, bearer-authenticated through the proxy origin; no file bytes.
    expect(posts()).toHaveLength(1);
    const [url, init] = posts()[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe(`${ORIGIN}/api/v1/files/a1/link`);
    expect(init.headers["Authorization"]).toBe("Bearer session-token");
    expect(gets()).toHaveLength(0);
    expect(createObjectURLMock).not.toHaveBeenCalled();
  });

  it("reuses a held link when the same clip is rendered again", async () => {
    serve([linkResponse("tok1")]);
    const first = mount();
    await vi.waitFor(() => expect(first.video.src).toContain("link=tok1"));
    const second = mount();
    await vi.waitFor(() => expect(second.video.src).toContain("link=tok1"));
    expect(posts()).toHaveLength(1);
  });

  it("shares one request between rows that render before it returns", async () => {
    serve([linkResponse("tok1")]);
    const a = mount();
    const b = mount();
    await vi.waitFor(() => expect(a.video.src).toContain("link=tok1"));
    await vi.waitFor(() => expect(b.video.src).toContain("link=tok1"));
    expect(posts()).toHaveLength(1);
  });

  it("replaces a link that is within five minutes of expiring", async () => {
    serve([linkResponse("old", 4 * 60 * 1000), linkResponse("new")]);
    const first = mount();
    await vi.waitFor(() => expect(first.video.src).toContain("link=old"));
    const second = mount();
    await vi.waitFor(() => expect(second.video.src).toContain("link=new"));
    expect(posts()).toHaveLength(2);
  });

  it("asks again after the attachment caches are cleared", async () => {
    serve([linkResponse("tok1"), linkResponse("tok2")]);
    const first = mount();
    await vi.waitFor(() => expect(first.video.src).toContain("link=tok1"));
    clearAttachmentCaches();
    const second = mount();
    await vi.waitFor(() => expect(second.video.src).toContain("link=tok2"));
  });

  it("never writes the link or its URL to the log", async () => {
    serve([linkResponse("secret-tok"), { ok: false, status: 401 }]);
    const { video } = mount();
    await vi.waitFor(() => expect(video.src).toContain("secret-tok"));
    failVideo(video, 4);
    await vi.waitFor(() => expect(posts()).toHaveLength(2));
    const logged = JSON.stringify(Object.values(logMock).flatMap((fn) => fn.mock.calls));
    expect(logged).not.toContain("secret-tok");
    expect(logged).not.toContain("link=");
  });
});

describe("a link that stops working", () => {
  it("is replaced once, and the clip retries from the fresh link", async () => {
    serve([linkResponse("tok1"), linkResponse("tok2")]);
    const { el, video } = mount();
    await vi.waitFor(() => expect(video.src).toContain("link=tok1"));

    failVideo(video, 4);

    await vi.waitFor(() => expect(video.src).toContain("link=tok2"));
    expect(posts()).toHaveLength(2);
    expect(el.querySelector(".msg-media-play")).toBeNull();
    expect(document.querySelector(".msg-file")).toBeNull();
  });

  it("falls back to the play button when the fresh link fails too, and stops", async () => {
    serve([linkResponse("tok1"), linkResponse("tok2")]);
    const { el, video } = mount();
    await vi.waitFor(() => expect(video.src).toContain("link=tok1"));
    failVideo(video, 4);
    await vi.waitFor(() => expect(video.src).toContain("link=tok2"));

    failVideo(video, 4);

    await vi.waitFor(() => expect(el.querySelector(".msg-media-play")).not.toBeNull());
    expect(video.getAttribute("src")).toBeNull();
    expect(video.controls).toBe(false);
    // Nothing downloads until the viewer presses play (the clip can be 100 MB).
    expect(gets()).toHaveLength(0);
    expect(posts()).toHaveLength(2);
    // A stray error afterwards is the blob path's: no further link request.
    failVideo(video, 4);
    expect(posts()).toHaveLength(2);
  });

  // Edge case 1: the session ends while a clip streams. Every request with the
  // old link is a 403, and so is the re-mint; the player must not loop.
  it("does not loop when the session is gone: one re-mint, then the play button", async () => {
    serve([linkResponse("tok1"), { ok: false, status: 401 }]);
    const { el, video } = mount();
    await vi.waitFor(() => expect(video.src).toContain("link=tok1"));

    failVideo(video, 4);
    await vi.waitFor(() => expect(el.querySelector(".msg-media-play")).not.toBeNull());
    failVideo(video, 4);
    failVideo(video, 2);
    await new Promise((r) => setTimeout(r, 0));

    expect(posts()).toHaveLength(2);
    expect(video.getAttribute("src")).toBeNull();
    // The authenticated download is refused as well: the dimmed player keeps
    // its download button and the play button can be pressed again.
    fetchMock.mockImplementation(() => Promise.resolve({ ok: false, status: 401 }));
    (el.querySelector(".msg-media-play") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(el.classList.contains("msg-media-failed")).toBe(true));
    expect(el.querySelector(".msg-file-download")).not.toBeNull();
    expect((el.querySelector(".msg-media-play") as HTMLButtonElement).disabled).toBe(false);
  });

  it("calls a clip the engine could not decode unplayable, without asking for a link again", async () => {
    serve([linkResponse("tok1"), linkResponse("tok2")]);
    const { video } = mount();
    await vi.waitFor(() => expect(video.src).toContain("link=tok1"));

    failVideo(video, 3);

    expect(document.querySelector("video")).toBeNull();
    const chip = document.querySelector(".msg-file") as HTMLElement;
    expect(chip.querySelector(".msg-file-note")?.textContent).toBe("Can't play this format");
    expect(posts()).toHaveLength(1);
  });

  it("calls a clip unplayable when the blob path cannot decode it either", async () => {
    serve([linkResponse("tok1"), { ok: false, status: 403 }]);
    const { el, video } = mount();
    await vi.waitFor(() => expect(video.src).toContain("link=tok1"));
    failVideo(video, 4);
    await vi.waitFor(() => expect(el.querySelector(".msg-media-play")).not.toBeNull());
    serve([{ ok: false, status: 403 }]);

    (el.querySelector(".msg-media-play") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(video.src).toContain("blob:mock-1"));
    failVideo(video, 4);

    expect(document.querySelector("video")).toBeNull();
    expect(document.querySelector(".msg-file-note")?.textContent).toBe("Can't play this format");
  });
});

describe("a server without file links", () => {
  it.each([404, 405])("answering %i falls back to the play button", async (status) => {
    serve([{ ok: false, status }]);
    const { el, video } = mount();

    await vi.waitFor(() => expect(el.querySelector(".msg-media-play")).not.toBeNull());
    expect(video.getAttribute("src")).toBeNull();
    expect(video.controls).toBe(false);
    expect(el.querySelector(".msg-media-play")?.getAttribute("aria-label")).toBe("Play clip.mp4");
    expect(gets()).toHaveLength(0);
  });

  it("is not asked again for the same clip", async () => {
    serve([{ ok: false, status: 404 }]);
    const first = mount();
    await vi.waitFor(() => expect(first.el.querySelector(".msg-media-play")).not.toBeNull());
    const second = mount();
    await vi.waitFor(() => expect(second.el.querySelector(".msg-media-play")).not.toBeNull());
    expect(posts()).toHaveLength(1);
  });

  it("falls back on a malformed answer or a network failure, and asks again next time", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const first = mount();
    await vi.waitFor(() => expect(first.el.querySelector(".msg-media-play")).not.toBeNull());
    serve([linkResponse("tok1")]);
    const second = mount();
    await vi.waitFor(() => expect(second.video.src).toContain("link=tok1"));
    expect(posts()).toHaveLength(2);
  });

  it("shows a loading state while the clip downloads, then plays it", async () => {
    serve([{ ok: false, status: 404 }]);
    let release!: (value: unknown) => void;
    fetchMock.mockImplementation((_url: string, init?: { method?: string }) =>
      init?.method === "POST"
        ? Promise.resolve({ ok: false, status: 404 })
        : new Promise((resolve) => (release = resolve)),
    );
    const { el, video } = mount();
    await vi.waitFor(() => expect(el.querySelector(".msg-media-play")).not.toBeNull());
    const button = el.querySelector(".msg-media-play") as HTMLButtonElement;

    button.click();

    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("Loading clip.mp4");
    expect(el.getAttribute("aria-busy")).toBe("true");
    expect(button.querySelector("[data-icon='loader']")).not.toBeNull();

    await vi.waitFor(() => expect(gets()).toHaveLength(1));
    release(fileBytes);
    await vi.waitFor(() => expect(video.src).toContain("blob:mock-1"));
    expect(el.hasAttribute("aria-busy")).toBe(false);
    expect(el.querySelector(".msg-media-play")).toBeNull();
    expect(video.controls).toBe(true);
  });

  it("clears the loading state when the download fails, so play can be pressed again", async () => {
    serve([{ ok: false, status: 404 }]);
    const { el } = mount();
    await vi.waitFor(() => expect(el.querySelector(".msg-media-play")).not.toBeNull());
    fetchMock.mockImplementation(() => Promise.resolve({ ok: false, status: 500 }));
    const button = el.querySelector(".msg-media-play") as HTMLButtonElement;

    button.click();
    await vi.waitFor(() => expect(el.classList.contains("msg-media-failed")).toBe(true));

    expect(button.disabled).toBe(false);
    expect(button.hasAttribute("aria-busy")).toBe(false);
    expect(el.hasAttribute("aria-busy")).toBe(false);
    expect(button.getAttribute("aria-label")).toBe("Play clip.mp4");
    expect(button.querySelector("[data-icon='play']")).not.toBeNull();
  });
});

describe("more video formats", () => {
  it.each([
    ["video/3gpp", "clip.3gp"],
    ["video/x-m4v", "clip.m4v"],
    ["video/x-matroska", "clip.mkv"],
    ["video/ogg", "clip.ogv"],
    ["application/octet-stream", "clip.3gp"],
    ["application/octet-stream", "clip.mkv"],
    ["application/octet-stream", "clip.webm"],
  ])("renders %s %s as a player", (mime, filename) => {
    const el = renderAttachment(att({ mime, filename }));
    expect(el.classList.contains("msg-video")).toBe(true);
  });

  it("keeps .avi a download chip", () => {
    const el = renderAttachment(att({ mime: "video/avi", filename: "clip.avi" }));
    expect(el.classList.contains("msg-video")).toBe(false);
    expect(el.classList.contains("msg-file")).toBe(true);
  });

  it.each(["video/3gpp", "video/x-m4v", "video/x-matroska", "video/ogg"])(
    "hands a %s download to the blob path with its own type",
    async (mime) => {
      fetchMock.mockResolvedValue({
        ok: true,
        headers: { get: () => mime },
        arrayBuffer: () => Promise.resolve(new Uint8Array([1]).buffer),
      });
      await fetchMediaAsObjectUrl(`https://myserver.local:8443/api/v1/files/${mime.length}`);
      const blob = createObjectURLMock.mock.calls[0]?.[0] as Blob;
      expect(blob.type).toBe(mime);
    },
  );
});
