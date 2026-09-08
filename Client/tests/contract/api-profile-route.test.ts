// Route inventory is generated from the server router, and gendocs drift is a
// CI gate. Execute the real client against that inventory instead of teaching a
// fetch mock to accept whichever path the client currently happens to use.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: mockFetch }));
vi.mock("../../src/lib/httpProxy", () => ({
  ensureHttpProxy: (host: string) => Promise.resolve(`https://${host}`),
}));
import { createApiClient } from "../../src/lib/api";

const apiDocs = readFileSync(path.resolve(__dirname, "../../../docs/api.md"), "utf8");
const routes = new Set(
  [...apiDocs.matchAll(/^\|\s+(GET|PATCH|POST|PUT|DELETE)\s+\|\s+`([^`]+)`\s+\|/gm)].map(
    (match) => `${match[1]} ${match[2]}`,
  ),
);

describe("client profile route matches the server API", () => {
  it("reads authentication and 2FA state from a registered GET endpoint", async () => {
    const profile = { id: 7, username: "member", totp_enabled: true };
    mockFetch.mockImplementation(async (url: string, init: RequestInit) => {
      const registered = routes.has(`${init.method} ${new URL(url).pathname}`);
      return {
        ok: registered,
        status: registered ? 200 : 405,
        statusText: registered ? "OK" : "Method Not Allowed",
        headers: new Headers(),
        json: async () =>
          registered ? profile : { error: "METHOD_NOT_ALLOWED", message: "No GET route" },
      } as Response;
    });
    const api = createApiClient({ host: "owncord.example", token: "member-session" });
    await expect(api.getMe()).resolves.toEqual(profile);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://owncord.example/api/v1/auth/me",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer member-session" }),
      }),
    );
    expect(routes.has("GET /api/v1/users/me")).toBe(false);
  });
});
