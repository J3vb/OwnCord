// Browser binding for the HttpClient suite (6.13c): the browser platform's
// HTTP client over the page's own `fetch`. The same suite runs against the
// desktop client in `http.desktop.test.ts`.
import { afterAll, describe, expect, it, vi } from "vitest";
import type { HttpClient } from "../../../src/platform/contracts/http";
import { http } from "../../../src/platform/browser/http";
import { describeHttpClientSuite, fetchStub } from "./http.suite";

const browserBinding: HttpClient = http;
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const { reset, native } = fetchStub(fetchMock, () => vi.stubGlobal("fetch", fetchMock));

afterAll(() => {
  vi.unstubAllGlobals();
});

describeHttpClientSuite(async () => {
  reset();
  return {
    subject: browserBinding,
    native,
  };
});

describe("browser http", () => {
  it("hands the request options to fetch unchanged", async () => {
    reset();
    const init: RequestInit = { method: "POST", headers: { Authorization: "Bearer t" } };
    await browserBinding.fetch("/api/v1/health", init);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/health", init);
  });

  it("has no upload progress to report, and an unsubscribe that is safe to call", () => {
    const handler = vi.fn();
    const unsubscribe = browserBinding.onUploadProgress(handler);
    expect(() => unsubscribe()).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });
});
