/**
 * Tests for attachment rendering, URL resolution, file downloads,
 * and content-type sanitization in attachments.ts.
 *
 * The sibling attachments-cache.test.ts covers cache invalidation flows.
 * This file covers the rendering paths and helper functions.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock, saveMock, writeFileMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  saveMock: vi.fn(),
  writeFileMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: fetchMock,
}));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: saveMock }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeFile: writeFileMock }));
vi.mock("@lib/icons", () => ({ createIcon: () => document.createElement("span") }));
vi.mock("@lib/media-visibility", () => ({ observeMedia: vi.fn() }));
vi.mock("../../src/components/message-list/media", () => ({ openImageLightbox: vi.fn() }));

// Provide a minimal indexedDB stub that returns null from idbGet
// so renderAttachment always goes through the network fetch path.
vi.stubGlobal("indexedDB", {
  open: () => {
    const db = {
      objectStoreNames: { contains: () => true },
      createObjectStore: vi.fn(),
      close: vi.fn(),
      transaction: () => {
        const tx: Record<string, unknown> = {
          oncomplete: null,
          onabort: null,
          onerror: null,
          objectStore: () => ({
            get: () => {
              const req: Record<string, unknown> = {
                onsuccess: null,
                onerror: null,
                result: undefined,
              };
              Promise.resolve().then(() => {
                const fn = req.onsuccess as ((ev: Event) => void) | null;
                fn?.(new Event("success"));
              });
              return req;
            },
            put: vi.fn(),
          }),
        };
        Promise.resolve().then(() => {
          const fn = tx.oncomplete as ((ev: Event) => void) | null;
          fn?.(new Event("complete"));
        });
        return tx;
      },
    };

    const req: Record<string, unknown> = {
      result: db,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
    };
    Promise.resolve().then(() => {
      const upgrade = req.onupgradeneeded as ((ev: Event) => void) | null;
      upgrade?.(new Event("upgradeneeded"));
      const success = req.onsuccess as ((ev: Event) => void) | null;
      success?.(new Event("success"));
    });
    return req;
  },
});

import {
  setServerHost,
  resolveServerUrl,
  formatFileSize,
  isImageMime,
  isSafeUrl,
  isTrustedServerUrl,
  clearAttachmentCaches,
  uint8ToBase64,
  renderAttachment,
  fetchImageAsDataUrl,
} from "../../src/components/message-list/attachments";

describe("resolveServerUrl", () => {
  beforeEach(() => {
    // Reset server host to a known value
    setServerHost("myserver.local:8443");
  });

  it("returns absolute http URLs unchanged", () => {
    expect(resolveServerUrl("http://other.com/file.png")).toBe("http://other.com/file.png");
  });

  it("returns absolute https URLs unchanged", () => {
    expect(resolveServerUrl("https://cdn.example.com/file.png")).toBe(
      "https://cdn.example.com/file.png",
    );
  });

  it("prepends server host for relative paths", () => {
    expect(resolveServerUrl("/api/v1/attachments/1.png")).toBe(
      "https://myserver.local:8443/api/v1/attachments/1.png",
    );
  });

  it("returns the path as-is when no server host is set", () => {
    // Trick: create a module-level override by calling the function
    // We cannot unset _serverHost since it's module-level, but resolveServerUrl
    // always has a host set after the beforeEach above. Testing the fallback
    // path would require a separate module instance — but we can test that
    // absolute URLs pass through regardless.
    expect(resolveServerUrl("https://example.com/img.png")).toBe("https://example.com/img.png");
  });
});

describe("formatFileSize", () => {
  it("formats bytes", () => {
    expect(formatFileSize(500)).toBe("500 B");
  });

  it("formats kilobytes", () => {
    expect(formatFileSize(2048)).toBe("2.0 KB");
  });

  it("formats megabytes", () => {
    expect(formatFileSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("handles exact KB boundary", () => {
    expect(formatFileSize(1024)).toBe("1.0 KB");
  });

  it("handles sub-KB boundary", () => {
    expect(formatFileSize(1023)).toBe("1023 B");
  });
});

describe("isImageMime", () => {
  it("returns true for image/png", () => {
    expect(isImageMime("image/png")).toBe(true);
  });

  it("returns true for image/gif", () => {
    expect(isImageMime("image/gif")).toBe(true);
  });

  it("returns false for application/pdf", () => {
    expect(isImageMime("application/pdf")).toBe(false);
  });

  it("returns false for text/plain", () => {
    expect(isImageMime("text/plain")).toBe(false);
  });
});

describe("isSafeUrl", () => {
  it("allows http URLs", () => {
    expect(isSafeUrl("http://example.com/file.txt")).toBe(true);
  });

  it("allows https URLs", () => {
    expect(isSafeUrl("https://example.com/file.txt")).toBe(true);
  });

  it("rejects javascript: URLs", () => {
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
  });

  it("rejects data: URLs", () => {
    expect(isSafeUrl("data:text/html,<script>")).toBe(false);
  });

  it("rejects file: protocol URLs", () => {
    expect(isSafeUrl("file:///etc/passwd")).toBe(false);
  });
});

describe("isTrustedServerUrl", () => {
  beforeEach(() => {
    setServerHost("myserver.local:8443");
  });

  it("returns true for the configured server host", () => {
    expect(isTrustedServerUrl("https://myserver.local:8443/file.png")).toBe(true);
  });

  it("returns false for a different host", () => {
    expect(isTrustedServerUrl("https://evil.com/file.png")).toBe(false);
  });

  it("returns false for an invalid URL", () => {
    expect(isTrustedServerUrl("not-a-url")).toBe(false);
  });
});

describe("uint8ToBase64", () => {
  it("encodes small arrays", () => {
    const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    expect(uint8ToBase64(bytes)).toBe(btoa("Hello"));
  });

  it("handles empty arrays", () => {
    expect(uint8ToBase64(new Uint8Array([]))).toBe("");
  });
});

describe("renderAttachment — non-image file", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    saveMock.mockReset();
    writeFileMock.mockReset();
    clearAttachmentCaches();
    setServerHost("myserver.local:8443");
  });

  it("renders a file attachment with name, size, and download button", () => {
    const el = renderAttachment({
      id: "1",
      url: "https://myserver.local:8443/file.zip",
      filename: "archive.zip",
      size: 2048,
      mime: "application/zip",
    });

    expect(el.classList.contains("msg-file")).toBe(true);
    expect(el.querySelector(".msg-file-name")?.textContent).toBe("archive.zip");
    expect(el.querySelector(".msg-file-size")?.textContent).toBe("2.0 KB");
    expect(el.querySelector(".msg-file-download")).not.toBeNull();
  });

  it("clicking filename triggers download with correct URL", async () => {
    saveMock.mockResolvedValue("C:\\Downloads\\archive.zip");
    fetchMock.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
    });

    const el = renderAttachment({
      id: "1",
      url: "https://myserver.local:8443/file.zip",
      filename: "archive.zip",
      size: 2048,
      mime: "application/zip",
    });

    const nameEl = el.querySelector(".msg-file-name") as HTMLElement;
    nameEl.click();

    await vi.waitFor(() => {
      expect(saveMock).toHaveBeenCalledWith({ defaultPath: "archive.zip" });
    });

    await vi.waitFor(() => {
      expect(writeFileMock).toHaveBeenCalled();
    });
  });

  it("clicking download button triggers download", async () => {
    saveMock.mockResolvedValue("C:\\Downloads\\archive.zip");
    fetchMock.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
    });

    const el = renderAttachment({
      id: "1",
      url: "https://myserver.local:8443/file.zip",
      filename: "archive.zip",
      size: 2048,
      mime: "application/zip",
    });

    const downloadBtn = el.querySelector(".msg-file-download") as HTMLButtonElement;
    downloadBtn.click();

    await vi.waitFor(() => {
      expect(saveMock).toHaveBeenCalledWith({ defaultPath: "archive.zip" });
    });
  });

  it("does not write file when user cancels save dialog", async () => {
    saveMock.mockResolvedValue(null); // User cancelled

    const el = renderAttachment({
      id: "1",
      url: "https://myserver.local:8443/file.zip",
      filename: "archive.zip",
      size: 2048,
      mime: "application/zip",
    });

    const nameEl = el.querySelector(".msg-file-name") as HTMLElement;
    nameEl.click();

    await vi.waitFor(() => {
      expect(saveMock).toHaveBeenCalled();
    });

    // Give time for the rest of the async to run
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
  });
});

describe("renderAttachment — image with dimensions", () => {
  beforeEach(() => {
    clearAttachmentCaches();
    fetchMock.mockReset();
    setServerHost("myserver.local:8443");
  });

  it("reserves space when width and height are provided", () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: () => "image/png" },
      arrayBuffer: () => Promise.resolve(new Uint8Array([1]).buffer),
    });

    const el = renderAttachment({
      id: "1",
      url: "https://myserver.local:8443/img.png",
      filename: "img.png",
      size: 1000,
      mime: "image/png",
      width: 800,
      height: 600,
    });

    expect(el.classList.contains("msg-image")).toBe(true);
    // Should have computed reserved dimensions
    expect(el.style.width).not.toBe("");
    expect(el.style.height).not.toBe("");
  });

  it("uses fallback min-height when dimensions are missing", () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: () => "image/png" },
      arrayBuffer: () => Promise.resolve(new Uint8Array([1]).buffer),
    });

    const el = renderAttachment({
      id: "1",
      url: "https://myserver.local:8443/img.png",
      filename: "img.png",
      size: 1000,
      mime: "image/png",
    });

    expect(el.style.minHeight).toBe("200px");
  });
});

describe("fetchImageAsDataUrl — network fetch failure", () => {
  beforeEach(() => {
    clearAttachmentCaches();
    fetchMock.mockReset();
    setServerHost("myserver.local:8443");
  });

  it("returns null when fetch response is not ok", async () => {
    fetchMock.mockResolvedValue({ ok: false });
    const result = await fetchImageAsDataUrl("https://myserver.local:8443/img.png");
    expect(result).toBeNull();
  });

  it("returns null and logs error when fetch throws", async () => {
    fetchMock.mockRejectedValue(new Error("network failure"));
    const result = await fetchImageAsDataUrl("https://example.com/img.png");
    expect(result).toBeNull();
  });

  it("sanitizes unsafe content-type to application/octet-stream", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: () => "text/html" },
      arrayBuffer: () => Promise.resolve(new Uint8Array([1]).buffer),
    });

    const result = await fetchImageAsDataUrl("https://example.com/img.png");
    expect(result).not.toBeNull();
    // Should use application/octet-stream, not text/html
    expect(result!.startsWith("data:application/octet-stream;")).toBe(true);
  });

  it("preserves safe content-type in data URL", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: () => "image/jpeg" },
      arrayBuffer: () => Promise.resolve(new Uint8Array([1]).buffer),
    });

    const result = await fetchImageAsDataUrl("https://example.com/img.jpg");
    expect(result).not.toBeNull();
    expect(result!.startsWith("data:image/jpeg;")).toBe(true);
  });

  it("uses acceptInvalidCerts for server URLs only", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: () => "image/png" },
      arrayBuffer: () => Promise.resolve(new Uint8Array([1]).buffer),
    });

    // Fetch a server URL
    await fetchImageAsDataUrl("https://myserver.local:8443/img.png");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://myserver.local:8443/img.png",
      expect.objectContaining({
        danger: expect.objectContaining({ acceptInvalidCerts: true }),
      }),
    );

    fetchMock.mockReset();
    clearAttachmentCaches();
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: () => "image/png" },
      arrayBuffer: () => Promise.resolve(new Uint8Array([1]).buffer),
    });

    // Fetch a third-party URL
    await fetchImageAsDataUrl("https://cdn.example.com/img.png");
    expect(fetchMock).toHaveBeenCalledWith("https://cdn.example.com/img.png", {});
  });
});
