// Legacy binding for the HttpClient suite: today's plugin `fetch`, reached
// through `lib/api.ts`'s `httpClient` seam, wrapped with no cast against the
// contract. B7-4 re-runs `http.suite.ts` against `platform/desktop` instead
// of this file.
//
// `api.ts` builds its REST client on `ensureHttpProxy` and the session scope,
// neither of which this seam test exercises; the mocks below keep the module
// import inert the same way the existing api unit tests do.
import { vi } from "vitest";
import type { HttpClient } from "../../../src/platform/contracts/http";
import { describeHttpClientSuite } from "./http.suite";

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
}));

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: fetchMock }));
vi.mock("@lib/httpProxy", () => ({ ensureHttpProxy: vi.fn() }));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const mod = await import("../../../src/lib/api");
const legacy: HttpClient = mod.httpClient;

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
    subject: legacy,
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
