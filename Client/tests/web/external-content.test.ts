/**
 * The browser external-content broker asks the server that served the page
 * (`/api/v1/external/*`) with the page's saved session, and maps its answers
 * onto the broker contract. Runs in the `web` project.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { externalContent } from "../../src/platform/browser/externalContent";
import type { ExternalImageHandle } from "../../src/platform/contracts/externalContent";

const KEY = `owncord:credential:${location.host}`;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

describe("browser external-content broker", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.setItem(KEY, JSON.stringify({ username: "alice", token: "tok-1" }));
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("asks the server for a preview with the saved session", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        ok: true,
        value: {
          title: "Hello",
          description: null,
          site_name: "Example",
          image: "abc123",
          image_width: 320,
        },
      }),
    );
    const result = await externalContent.preview("p", "https://example.com/a?b=1");
    expect(result).toEqual({
      ok: true,
      value: {
        title: "Hello",
        description: null,
        siteName: "Example",
        image: "abc123",
        imageWidth: 320,
      },
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `/api/v1/external/preview?url=${encodeURIComponent("https://example.com/a?b=1")}`,
    );
    expect(init.headers).toEqual({ Authorization: "Bearer tok-1" });
    expect(init.credentials).toBe("omit");
  });

  it("passes the server's refusal through, and anything unknown as unavailable", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, failure: "blocked-destination" }));
    await expect(externalContent.preview("p", "https://10.0.0.1/")).resolves.toEqual({
      ok: false,
      failure: "blocked-destination",
    });
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, failure: "made-up" }));
    await expect(externalContent.preview("p", "https://x/")).resolves.toEqual({
      ok: false,
      failure: "unavailable",
    });
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 429 }));
    await expect(externalContent.preview("p", "https://x/")).resolves.toEqual({
      ok: false,
      failure: "unavailable",
    });
    fetchMock.mockRejectedValueOnce(new TypeError("network down"));
    await expect(externalContent.preview("p", "https://x/")).resolves.toEqual({
      ok: false,
      failure: "unavailable",
    });
  });

  it("fetches an image by handle or url and hands back its bytes", async () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    fetchMock.mockResolvedValue(
      new Response(gif, { status: 200, headers: { "Content-Type": "image/gif" } }),
    );
    const byHandle = await externalContent.image("p", { handle: "h1" as ExternalImageHandle });
    expect(byHandle.ok).toBe(true);
    if (byHandle.ok) expect(new Uint8Array(await byHandle.value.arrayBuffer())).toEqual(gif);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/external/image?handle=h1");

    await externalContent.image("p", { url: "https://cdn.example/x.gif" });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `/api/v1/external/image?url=${encodeURIComponent("https://cdn.example/x.gif")}`,
    );
  });

  it("maps an image refusal to its failure", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, failure: "expired-handle" }));
    await expect(
      externalContent.image("p", { handle: "gone" as ExternalImageHandle }),
    ).resolves.toEqual({ ok: false, failure: "expired-handle" });
  });

  it("fetches nothing without a saved session", async () => {
    localStorage.clear();
    await expect(externalContent.preview("p", "https://x/")).resolves.toEqual({
      ok: false,
      failure: "unavailable",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
