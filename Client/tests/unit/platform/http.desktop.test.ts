// Desktop binding for the HttpClient suite: `platform/desktop`'s HTTP client.
// B7-4 ran the same suite file against the in-place seam in `lib/api.ts` first
// (proving it could fail and pinning today's behaviour), then re-bound it
// here. The legacy binding is deleted with this commit: its export is now
// internal.
import { vi } from "vitest";
import type { HttpClient } from "../../../src/platform/contracts/http";
import { describeHttpClientSuite } from "./http.suite";

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
}));

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: fetchMock }));

const mod = await import("../../../src/platform/desktop/http");
const desktopBinding: HttpClient = mod.http;

const requested: string[] = [];

function reset(): void {
  fetchMock.mockReset();
  requested.length = 0;
  fetchMock.mockImplementation((url: string) => {
    requested.push(url);
    return Promise.resolve(new Response(null, { status: 200 }));
  });
}

describeHttpClientSuite(async () => {
  reset();
  return {
    subject: desktopBinding,
    native: {
      respondsWith(response: Response) {
        reset();
        fetchMock.mockImplementation((url: string) => {
          requested.push(url);
          return Promise.resolve(response);
        });
      },
      failsWith(error: unknown) {
        reset();
        fetchMock.mockRejectedValue(error);
      },
      requested: () => [...requested],
    },
  };
});
