/**
 * Text and code file preview (roadmap 8.5).
 *
 * A text/plain server attachment with a known source extension renders as a
 * Discord-style preview: the first lines of the file, syntax-coloured, with an
 * expand toggle. The bytes come through the same authenticated fetch the other
 * attachments use, capped at 64 KB; anything that goes wrong becomes the
 * ordinary file chip, never a stuck loading state.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as mocks from "../helpers/attachmentsMocks";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock("@tauri-apps/plugin-http", () => mocks.httpPluginMock(fetchMock));
vi.mock("@lib/net/httpProxy", () => mocks.httpProxyMock());
vi.mock("@lib/logger", () => mocks.loggerMock());
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeFile: vi.fn() }));
vi.mock("@lib/icons", () => mocks.iconsMock());
vi.mock("@lib/prefs/mediaVisibility", () => mocks.mediaVisibilityMock());
vi.mock("../../src/features/messaging/content/media", () => mocks.contentMediaMock());
vi.mock("@stores/auth.store", () => mocks.authStoreMock(() => "session-token"));

import {
  clearAttachmentCaches,
  renderAttachment,
  setServerHost,
} from "../../src/features/messaging/content/attachments";
import {
  TEXT_PREVIEW_CACHE_MAX,
  TEXT_PREVIEW_MAX_LINES,
} from "../../src/features/messaging/textPreview";
import type { Attachment } from "@lib/types";

const MAX = 65536;

function att(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: "a1",
    url: "https://myserver.local:8443/api/v1/files/a1",
    filename: "main.py",
    mime: "text/plain; charset=utf-8",
    size: 100,
    ...overrides,
  };
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function okBody(data: Uint8Array, status = 206): unknown {
  const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return { ok: true, status, arrayBuffer: () => Promise.resolve(copy) };
}

function streamBody(chunks: Uint8Array[], cancel: () => void): unknown {
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: () =>
          Promise.resolve(
            i < chunks.length
              ? { done: false, value: chunks[i++] }
              : { done: true, value: undefined },
          ),
        cancel: () => {
          cancel();
          return Promise.resolve();
        },
      }),
    },
  };
}

const PY = 'def hello():\n    return "hi"  # greet\n';
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

function manyLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
}

beforeEach(() => {
  fetchMock.mockReset();
  clearAttachmentCaches();
  setServerHost("myserver.local:8443");
  document.body.innerHTML = "";
});

describe("text preview", () => {
  it("renders a highlighted preview fetched with Range and the bearer token", async () => {
    fetchMock.mockResolvedValue(okBody(bytes(PY)));
    const el = renderAttachment(att({ size: bytes(PY).length }));
    document.body.appendChild(el);
    await settle();

    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe("http://127.0.0.1:9999/api/v1/files/a1");
    expect(init.headers["Range"]).toBe("bytes=0-65535");
    expect(init.headers["Authorization"]).toBe("Bearer session-token");

    expect(el.classList.contains("msg-textpreview")).toBe(true);
    expect(el.querySelector(".msg-textpreview-code .tok-keyword")?.textContent).toBe("def");
    expect(el.querySelector(".msg-textpreview-code .tok-string")).not.toBeNull();
    expect(el.querySelector(".msg-textpreview-code .tok-comment")).not.toBeNull();
    expect(el.querySelector(".msg-textpreview-lang")?.textContent).toBe("Python");
    expect(el.querySelector(".msg-textpreview-count")?.textContent).toBe("2 lines");
    expect(el.querySelector(".msg-file-name")?.textContent).toBe("main.py");
    expect(el.querySelector(".msg-file-download")).not.toBeNull();
    expect(el.getAttribute("role")).toBe("group");
    expect(el.getAttribute("aria-label")).toBe("Preview of main.py");
  });

  it("labels an unhighlighted extension as Text and counts one line", async () => {
    fetchMock.mockResolvedValue(okBody(bytes("just one line\n")));
    const el = renderAttachment(att({ filename: "notes.txt", size: 14 }));
    await settle();
    expect(el.querySelector(".msg-textpreview-lang")?.textContent).toBe("Text");
    expect(el.querySelector(".msg-textpreview-count")?.textContent).toBe("1 line");
    // Short file: nothing to expand.
    expect(el.querySelector(".msg-textpreview-toggle")).toBeNull();
  });

  it("toggles expanded state with aria-expanded", async () => {
    fetchMock.mockResolvedValue(okBody(bytes(manyLines(42))));
    const el = renderAttachment(att());
    await settle();

    const preview = el;
    const toggle = el.querySelector(".msg-textpreview-toggle") as HTMLButtonElement;
    expect(el.querySelector(".msg-textpreview-count")?.textContent).toBe("42 lines");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("Expand");
    expect(preview.classList.contains("expanded")).toBe(false);

    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toContain("Collapse");
    expect(preview.classList.contains("expanded")).toBe(true);

    const body = el.querySelector(".msg-textpreview-body") as HTMLElement;
    body.scrollTop = 300;
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(preview.classList.contains("expanded")).toBe(false);
    expect(body.scrollTop).toBe(0);
  });

  it.each([
    ["non-ok response", () => fetchMock.mockResolvedValue({ ok: false, status: 403 })],
    ["thrown fetch", () => fetchMock.mockRejectedValue(new Error("network down"))],
  ])("falls back to the file chip on %s", async (_name, arrange) => {
    arrange();
    const el = renderAttachment(att());
    document.body.appendChild(el);
    await settle();
    expect(el.querySelector(".msg-textpreview")).toBeNull();
    expect(document.querySelector(".msg-textpreview")).toBeNull();
    expect(document.querySelector(".msg-file .msg-file-download")).not.toBeNull();
    expect(document.querySelector(".msg-file-name")?.textContent).toBe("main.py");
  });

  it("falls back to the chip when the bytes contain NUL", async () => {
    fetchMock.mockResolvedValue(okBody(new Uint8Array([104, 105, 0, 106])));
    const el = renderAttachment(att());
    document.body.appendChild(el);
    await settle();
    expect(document.querySelector(".msg-textpreview")).toBeNull();
    expect(document.querySelector(".msg-file .msg-file-download")).not.toBeNull();
  });

  it("decodes only 64 KB when the server ignores the range, and says so", async () => {
    const cancel = vi.fn();
    const chunk = bytes("x".repeat(40000));
    fetchMock.mockResolvedValue(streamBody([chunk, chunk, chunk], cancel));
    const el = renderAttachment(att({ size: 120000 }));
    await settle();
    const code = el.querySelector(".msg-textpreview-code") as HTMLElement;
    expect(code.textContent?.length).toBe(MAX);
    expect(cancel).toHaveBeenCalled();
    expect(el.querySelector(".msg-textpreview-count")?.textContent).toBe("1+ line");
    expect(el.querySelector(".msg-textpreview-note")?.textContent).toBe(
      "Showing the first 64 KB. Download the file to see the rest.",
    );
  });

  it("slices an arrayBuffer body at 64 KB when no stream is available", async () => {
    fetchMock.mockResolvedValue(okBody(bytes("y".repeat(100000)), 200));
    const el = renderAttachment(att({ size: 100000 }));
    await settle();
    expect(el.querySelector(".msg-textpreview-code")?.textContent?.length).toBe(MAX);
    expect(el.querySelector(".msg-textpreview-note")).not.toBeNull();
  });

  it("trims a multibyte character cut at the limit", async () => {
    const data = bytes("a".repeat(MAX - 1) + "é");
    fetchMock.mockResolvedValue(okBody(data, 200));
    const el = renderAttachment(att({ size: data.length + 10 }));
    await settle();
    const text = el.querySelector(".msg-textpreview-code")?.textContent ?? "";
    expect(text).not.toContain("�");
    expect(text.length).toBe(MAX - 1);
  });

  it("shows no truncation note when the whole file was fetched", async () => {
    fetchMock.mockResolvedValue(okBody(bytes(PY)));
    const el = renderAttachment(att({ size: bytes(PY).length }));
    await settle();
    expect(el.querySelector(".msg-textpreview-note")).toBeNull();
  });
});

describe("shapes that stay as they were", () => {
  it.each([
    ["an extension off the allowlist", att({ filename: "tool.exe" })],
    ["an unknown extension", att({ filename: "blob.bin" })],
    ["html", att({ filename: "page.html" })],
    ["svg", att({ filename: "pic.svg" })],
    ["xml", att({ filename: "data.xml" })],
    ["a spoiler file", att({ filename: "SPOILER_x.txt" })],
    ["a non-text mime", att({ mime: "application/octet-stream" })],
    ["text/html", att({ mime: "text/html" })],
    ["an external url", att({ url: "https://elsewhere.example/f/main.py" })],
  ])("keeps %s as the plain chip without fetching", async (_name, attachment) => {
    const el = renderAttachment(attachment);
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(el.querySelector(".msg-textpreview")).toBeNull();
    expect(el.classList.contains("msg-file")).toBe(true);
  });

  it("keeps an image on the image shape", () => {
    const el = renderAttachment(att({ filename: "p.png", mime: "image/png" }));
    expect(el.classList.contains("msg-image")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("cache", () => {
  it("renders the second row for the same file synchronously, without a second fetch", async () => {
    fetchMock.mockResolvedValue(okBody(bytes(PY)));
    renderAttachment(att());
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const again = renderAttachment(att());
    expect(again.querySelector(".msg-textpreview-code .tok-keyword")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shares one request between rows rendered while it is in flight", async () => {
    fetchMock.mockResolvedValue(okBody(bytes(PY)));
    const a = renderAttachment(att());
    const b = renderAttachment(att());
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a.querySelector(".msg-textpreview-code")).not.toBeNull();
    expect(b.querySelector(".msg-textpreview-code")).not.toBeNull();
  });

  it("drops a result that resolves after a session reset", async () => {
    let release: (value: unknown) => void = () => {};
    fetchMock.mockReturnValue(new Promise((resolve) => (release = resolve)));
    renderAttachment(att());
    await settle();
    clearAttachmentCaches();
    release(okBody(bytes(PY)));
    await settle();

    fetchMock.mockResolvedValue(okBody(bytes(PY)));
    renderAttachment(att());
    await settle();
    // The stale result was not cached, so the new session asked again.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds the cache", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(okBody(bytes(PY))));
    for (let i = 0; i < TEXT_PREVIEW_CACHE_MAX + 1; i++) {
      renderAttachment(att({ id: `f${i}`, url: `https://myserver.local:8443/api/v1/files/f${i}` }));
      await settle();
    }
    fetchMock.mockClear();
    // The oldest entry was evicted, so it is fetched again.
    renderAttachment(att({ id: "f0", url: "https://myserver.local:8443/api/v1/files/f0" }));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("render cost and accessibility", () => {
  const lines = (el: Element, sel: string): number =>
    (el.querySelector(sel)?.textContent ?? "").split("\n").length;

  it("builds only six lines while collapsed and the rest on Expand", async () => {
    fetchMock.mockResolvedValue(okBody(bytes(manyLines(42))));
    const el = renderAttachment(att({ size: 400 }));
    await settle();
    expect(lines(el, ".msg-textpreview-code")).toBe(6);
    expect(lines(el, ".msg-textpreview-gutter")).toBe(6);
    (el.querySelector(".msg-textpreview-toggle") as HTMLButtonElement).click();
    expect(lines(el, ".msg-textpreview-code")).toBe(42);
    expect(lines(el, ".msg-textpreview-gutter")).toBe(42);
  });

  it("caps Expand at the line limit and says the file continues", async () => {
    const data = bytes("a\n".repeat(5000));
    fetchMock.mockResolvedValue(okBody(data));
    const el = renderAttachment(att({ size: data.length }));
    await settle();
    (el.querySelector(".msg-textpreview-toggle") as HTMLButtonElement).click();
    expect(lines(el, ".msg-textpreview-gutter")).toBe(TEXT_PREVIEW_MAX_LINES);
    expect(el.querySelector(".msg-textpreview-count")?.textContent).toBe("2,000+ lines");
    expect(el.querySelector(".msg-textpreview-note")?.textContent).toContain("2,000 lines");
  });

  it("makes the expanded box focusable and wires aria-controls", async () => {
    fetchMock.mockResolvedValue(okBody(bytes(manyLines(42))));
    const el = renderAttachment(att({ size: 400 }));
    await settle();
    const toggle = el.querySelector(".msg-textpreview-toggle") as HTMLButtonElement;
    const body = el.querySelector(".msg-textpreview-body") as HTMLElement;
    expect(body.id).not.toBe("");
    expect(toggle.getAttribute("aria-controls")).toBe(body.id);
    expect(body.hasAttribute("tabindex")).toBe(false);
    toggle.click();
    expect(body.getAttribute("tabindex")).toBe("0");
    expect(body.getAttribute("aria-label")).toBe("Contents of main.py");
    toggle.click();
    expect(body.hasAttribute("tabindex")).toBe(false);
  });

  it("cancels the stream when read() throws mid-way", async () => {
    const cancel = vi.fn();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () => Promise.reject(new Error("reset")),
          cancel: () => {
            cancel();
            return Promise.resolve();
          },
        }),
      },
    });
    const el = renderAttachment(att());
    document.body.appendChild(el);
    await settle();
    expect(cancel).toHaveBeenCalled();
    expect(document.querySelector(".msg-textpreview")).toBeNull();
  });

  it("keeps an empty file as the plain chip without a request", () => {
    const el = renderAttachment(att({ size: 0 }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(el.classList.contains("msg-textpreview")).toBe(false);
    expect(el.classList.contains("msg-file")).toBe(true);
  });
});

describe("cache edge cases", () => {
  const urlOf = (i: number): string => `https://myserver.local:8443/api/v1/files/f${i}`;

  it("does not cache an old fetch that resolves after a reset and a re-render", async () => {
    let release: (value: unknown) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    renderAttachment(att());
    await settle();
    clearAttachmentCaches();

    fetchMock.mockResolvedValueOnce(okBody(bytes("NEW = 1\n")));
    renderAttachment(att());
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    release(okBody(bytes("OLD = 1\n")));
    await settle();
    const third = renderAttachment(att());
    expect(third.querySelector(".msg-textpreview-code")?.textContent).toContain("NEW");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caches a result that arrives after the row was detached", async () => {
    fetchMock.mockResolvedValue(okBody(bytes(PY)));
    renderAttachment(att()); // never attached, like a recycled row
    await settle();
    const again = renderAttachment(att());
    expect(again.querySelector(".msg-textpreview-code .tok-keyword")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("promotes an entry on read so it outlives older ones", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(okBody(bytes(PY))));
    const make = (i: number): Attachment => att({ id: `f${i}`, url: urlOf(i) });
    for (let i = 0; i < TEXT_PREVIEW_CACHE_MAX; i++) {
      renderAttachment(make(i));
      await settle();
    }
    renderAttachment(make(0)); // read: now the newest
    renderAttachment(make(TEXT_PREVIEW_CACHE_MAX));
    await settle();
    fetchMock.mockClear();
    const kept = renderAttachment(make(0));
    expect(kept.querySelector(".msg-textpreview-code")).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    renderAttachment(make(1)); // the oldest unread entry went
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
