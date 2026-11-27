// Desktop binding for the HttpClient suite: `platform/desktop`'s HTTP client.
// B7-4 ran the same suite file against the in-place seam in `lib/api.ts` first
// (proving it could fail and pinning today's behaviour), then re-bound it
// here. The legacy binding is deleted with this commit: its export is now
// internal.
import { describe, expect, it, vi } from "vitest";
import type { HttpClient } from "../../../src/platform/contracts/http";
import { describeHttpClientSuite, fetchStub } from "./http.suite";

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
}));

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: fetchMock }));

const mod = await import("../../../src/platform/desktop/http");
const desktopBinding: HttpClient = mod.http;

const { reset, native } = fetchStub(fetchMock);

describeHttpClientSuite(async () => {
  reset();
  return {
    subject: desktopBinding,
    native,
  };
});

describe("desktop HttpClient: redirects", () => {
  it("asks the native client to follow no redirect, keeping the caller's init", async () => {
    reset();
    const signal = new AbortController().signal;
    await desktopBinding.fetch("http://127.0.0.1:1/api/v1/x", {
      method: "POST",
      headers: { Authorization: "Bearer t" },
      signal,
    });
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:1/api/v1/x", {
      method: "POST",
      headers: { Authorization: "Bearer t" },
      signal,
      maxRedirections: 0,
    });
  });

  it("sets the limit when the caller passed no init", async () => {
    reset();
    await desktopBinding.fetch("http://127.0.0.1:1/api/v1/health");
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:1/api/v1/health", {
      maxRedirections: 0,
    });
  });

  it("hands a redirect back as the caller's non-ok reply", async () => {
    const redirect = new Response(null, { status: 302, headers: { Location: "https://x.test/" } });
    native.respondsWith(redirect);
    const res = await desktopBinding.fetch("http://127.0.0.1:1/api/v1/x");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(302);
  });
});
