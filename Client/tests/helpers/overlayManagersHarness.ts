import { vi } from "vitest";
import { createPinnedPanelController as createPinnedPanelControllerRaw } from "@pages/main-page/OverlayManagers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// An open panel watches the shared stores, so every controller a test opens is
// closed afterwards or it would keep reacting to the next test's store writes.
export const openPinnedControllers: Array<{ cleanup(): void }> = [];

export const createPinnedPanelController: typeof createPinnedPanelControllerRaw = (o) => {
  const controller = createPinnedPanelControllerRaw(o);
  openPinnedControllers.push(controller);
  return controller;
};

export function makeInviteResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    code: "abc123xyz",
    url: "https://example.com/abc123xyz",
    max_uses: 10,
    use_count: 3,
    expires_at: null,
    ...overrides,
  };
}

export function makeMockApi(overrides: Record<string, unknown> = {}) {
  return {
    getInvites: vi.fn().mockResolvedValue([makeInviteResponse()]),
    createInvite: vi.fn().mockResolvedValue(makeInviteResponse({ code: "new123" })),
    revokeInvite: vi.fn().mockResolvedValue(undefined),
    getPins: vi.fn().mockResolvedValue({
      messages: [
        { id: 1, user: { username: "Alice" }, content: "Pinned msg", created_at: "2024-01-01" },
      ],
    }),
    unpinMessage: vi.fn().mockResolvedValue(undefined),
    search: vi
      .fn()
      .mockResolvedValue({ results: [{ channel_id: 1, message_id: 10, content: "hello" }] }),
    ...overrides,
  };
}
