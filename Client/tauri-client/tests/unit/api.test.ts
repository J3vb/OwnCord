import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the Tauri HTTP plugin — vi.hoisted ensures the fn is available when
// vi.mock's factory runs (hoisted above all imports).
const { mockFetch } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: mockFetch,
}));

import { createApiClient, ApiClientError } from "../../src/lib/api";

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    json: () => Promise.resolve(data),
    headers: new Headers(),
  } as unknown as Response;
}

function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return {
    ok: false,
    status,
    statusText: message,
    json: () => Promise.resolve({ error: code, message }),
    headers: new Headers(),
  } as unknown as Response;
}

describe("API Client", () => {
  let api: ReturnType<typeof createApiClient>;
  let onUnauthorized: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch.mockReset();
    onUnauthorized = vi.fn();
    api = createApiClient(
      { host: "localhost:8443", token: "test-token" },
      onUnauthorized,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("API base path uses /api/v1/", () => {
    it("login calls /api/v1/auth/login", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ token: "t", requires_2fa: false }),
      );
      await api.login("user", "pass");
      const url = mockFetch.mock.calls[0]?.[0] as string;
      expect(url).toBe("https://localhost:8443/api/v1/auth/login");
    });

    it("getMessages calls /api/v1/channels/{id}/messages", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ messages: [], has_more: false }),
      );
      await api.getMessages(5);
      const url = mockFetch.mock.calls[0]?.[0] as string;
      expect(url).toBe("https://localhost:8443/api/v1/channels/5/messages");
    });

    it("search calls /api/v1/search", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ results: [] }));
      await api.search("hello");
      const url = mockFetch.mock.calls[0]?.[0] as string;
      expect(url).toContain("https://localhost:8443/api/v1/search");
    });

    it("getHealth calls /api/v1/health", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ status: "ok", version: "1.0.0", uptime: 100 }),
      );
      await api.getHealth();
      const url = mockFetch.mock.calls[0]?.[0] as string;
      expect(url).toBe("https://localhost:8443/api/v1/health");
    });
  });

  describe("auth endpoints", () => {
    it("register sends invite_code", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ user: { id: 1, username: "u" }, token: "t" }, 201),
      );
      await api.register("user", "pass", "invite123");
      const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string);
      expect(body.invite_code).toBe("invite123");
    });

    it("sends Authorization header", async () => {
      mockFetch.mockResolvedValue(jsonResponse({}));
      await api.getMe();
      const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer test-token");
    });
  });

  describe("error handling", () => {
    it("throws ApiClientError on non-ok response", async () => {
      mockFetch.mockResolvedValue(
        errorResponse(403, "FORBIDDEN", "No permission"),
      );
      await expect(api.getMe()).rejects.toThrow(ApiClientError);
      await expect(api.getMe()).rejects.toMatchObject({
        status: 403,
        code: "FORBIDDEN",
      });
    });

    it("calls onUnauthorized on 401", async () => {
      mockFetch.mockResolvedValue(
        errorResponse(401, "UNAUTHORIZED", "Invalid session"),
      );
      await expect(api.getMe()).rejects.toThrow();
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it("does not call onUnauthorized on other errors", async () => {
      mockFetch.mockResolvedValue(
        errorResponse(500, "SERVER_ERROR", "Internal error"),
      );
      await expect(api.getMe()).rejects.toThrow();
      expect(onUnauthorized).not.toHaveBeenCalled();
    });
  });

  describe("cancellation", () => {
    it("passes AbortSignal to fetch", async () => {
      mockFetch.mockResolvedValue(jsonResponse({}));
      const controller = new AbortController();
      await api.getMe(controller.signal);
      expect(mockFetch.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    });
  });

  describe("pagination", () => {
    it("getMessages passes before and limit params", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ messages: [], has_more: false }),
      );
      await api.getMessages(5, { before: 100, limit: 25 });
      const url = mockFetch.mock.calls[0]?.[0] as string;
      expect(url).toContain("before=100");
      expect(url).toContain("limit=25");
    });
  });

  describe("config management", () => {
    it("setConfig updates token", async () => {
      mockFetch.mockResolvedValue(jsonResponse({}));
      api.setConfig({ token: "new-token" });
      await api.getMe();
      const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer new-token");
    });
  });

  describe("user endpoints", () => {
    it("getSessions calls correct endpoint", async () => {
      mockFetch.mockResolvedValue(jsonResponse([]));
      await api.getSessions();
      const url = mockFetch.mock.calls[0]?.[0] as string;
      expect(url).toBe("https://localhost:8443/api/v1/users/me/sessions");
    });

    it("revokeSession calls DELETE with session ID", async () => {
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      await api.revokeSession(42);
      const url = mockFetch.mock.calls[0]?.[0] as string;
      const method = mockFetch.mock.calls[0]?.[1]?.method as string;
      expect(url).toBe("https://localhost:8443/api/v1/users/me/sessions/42");
      expect(method).toBe("DELETE");
    });
  });
});
