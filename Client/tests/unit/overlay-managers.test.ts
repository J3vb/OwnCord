import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { setMembers } from "@stores/members.store";

// ---------------------------------------------------------------------------
// Mocks (vi.hoisted so they're available in vi.mock factories)
// ---------------------------------------------------------------------------

const {
  mockLogError,
  mockInviteManagerMount,
  mockInviteManagerDestroy,
  mockPinnedMessagesMount,
  mockPinnedMessagesDestroy,
  mockPinnedSetPins,
  mockPinnedRemovePin,
  mockPinnedSetOnUnpin,
  mockShowToast,
  mockQuickSwitcherMount,
  mockQuickSwitcherDestroy,
  mockSearchOverlayMount,
  mockSearchOverlayDestroy,
  mockSetActiveChannel,
  mockSetMessagePinned,
  mockCanManageInvites,
  mockMe,
} = vi.hoisted(() => ({
  mockMe: { value: "me" },
  mockCanManageInvites: { value: true },
  mockLogError: vi.fn(),
  mockInviteManagerMount: vi.fn(),
  mockInviteManagerDestroy: vi.fn(),
  mockPinnedMessagesMount: vi.fn(),
  mockPinnedMessagesDestroy: vi.fn(),
  mockPinnedSetPins: vi.fn(),
  mockPinnedRemovePin: vi.fn(),
  mockPinnedSetOnUnpin: vi.fn(),
  mockShowToast: vi.fn(),
  mockQuickSwitcherMount: vi.fn(),
  mockQuickSwitcherDestroy: vi.fn(),
  mockSearchOverlayMount: vi.fn(),
  mockSearchOverlayDestroy: vi.fn(),
  mockSetActiveChannel: vi.fn(),
  mockSetMessagePinned: vi.fn(),
}));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLogError,
  }),
}));

vi.mock("@components/QuickSwitcher", () => ({
  createQuickSwitcher: vi.fn(() => ({
    mount: mockQuickSwitcherMount,
    destroy: mockQuickSwitcherDestroy,
  })),
}));

vi.mock("@components/InviteManager", () => ({
  createInviteManager: vi.fn(() => ({
    mount: mockInviteManagerMount,
    destroy: mockInviteManagerDestroy,
  })),
}));

vi.mock("@components/PinnedMessages", () => ({
  createPinnedMessages: vi.fn(() => ({
    mount: mockPinnedMessagesMount,
    destroy: mockPinnedMessagesDestroy,
    setPins: mockPinnedSetPins,
    removePin: mockPinnedRemovePin,
    setOnUnpin: mockPinnedSetOnUnpin,
  })),
}));

vi.mock("@components/SearchOverlay", () => ({
  createSearchOverlay: vi.fn(() => ({
    mount: mockSearchOverlayMount,
    destroy: mockSearchOverlayDestroy,
  })),
}));

// B9-7: channel 99 is labelled NSFW and not acknowledged. Real stores, so the
// controller's live subscriptions run.
vi.mock("@stores/channels.store", async () => {
  const { createStore } = await import("@lib/store");
  return {
    setActiveChannel: mockSetActiveChannel,
    // navigateToChannel (the switcher's pick path) also clears the badge.
    clearUnread: vi.fn(),
    channelsStore: createStore({
      channels: new Map<number, Record<string, unknown>>([
        [99, { nsfw: true }],
        [3, { id: 3, name: "voice-lobby", type: "voice" }],
        [4, { id: 4, name: "general", type: "text" }],
        [42, { id: 42, name: "pins", type: "text", canPin: true }],
      ]),
    }),
  };
});

vi.mock("@stores/messages.store", async () => {
  const { createStore } = await import("@lib/store");
  return {
    messagesStore: createStore({ pinRevision: new Map<number, number>() }),
    setMessagePinned: mockSetMessagePinned,
  };
});

vi.mock("@stores/auth.store", () => ({
  authStore: { getState: () => ({ user: { username: mockMe.value } }) },
}));

vi.mock("@lib/permissions", () => ({
  canManageInvites: () => mockCanManageInvites.value,
}));

vi.mock("@lib/ui/toast", () => ({
  initToast: vi.fn(),
  teardownToast: vi.fn(),
  showToast: mockShowToast,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { createQuickSwitcher } from "@components/QuickSwitcher";
import { createInviteManager } from "@components/InviteManager";
import { createPinnedMessages } from "@components/PinnedMessages";
import { createSearchOverlay } from "@components/SearchOverlay";
import { channelsStore } from "@stores/channels.store";
import { messagesStore } from "@stores/messages.store";
import { membersStore } from "@stores/members.store";
import { uiStore, setConnectionStatus } from "@stores/ui.store";
import {
  mapInviteResponse,
  mapToPinnedMessage,
  createQuickSwitcherManager,
  createInviteManagerController,
  createPinnedPanelController as createPinnedPanelControllerRaw,
  createSearchOverlayController,
} from "@pages/main-page/OverlayManagers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// An open panel watches the shared stores, so every controller a test opens is
// closed afterwards or it would keep reacting to the next test's store writes.
const openPinnedControllers: Array<{ cleanup(): void }> = [];
const createPinnedPanelController: typeof createPinnedPanelControllerRaw = (o) => {
  const controller = createPinnedPanelControllerRaw(o);
  openPinnedControllers.push(controller);
  return controller;
};

function makeInviteResponse(overrides: Record<string, unknown> = {}) {
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

function makeMockApi(overrides: Record<string, unknown> = {}) {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createInviteManagerController", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
    vi.clearAllMocks();
  });

  afterEach(() => {
    root.remove();
  });

  it("opens invite manager and mounts to root", async () => {
    const api = makeMockApi();

    const controller = createInviteManagerController({
      api: api as never,
      getRoot: () => root,
    });

    await controller.open();

    expect(createInviteManager).toHaveBeenCalledOnce();
    expect(mockInviteManagerMount).toHaveBeenCalledWith(root);
  });

  it("filters out revoked invites before handing the list to InviteManager", async () => {
    // Redemption enforces `revoked = 0` server-side (UseInviteAtomic), so a
    // revoked invite rendered like a live one hands out a code that always
    // fails. The list endpoint deliberately still includes revoked invites
    // (for admin visibility elsewhere), so the client must filter here.
    const api = makeMockApi({
      getInvites: vi
        .fn()
        .mockResolvedValue([
          makeInviteResponse({ code: "live1", max_uses: null, creator_username: "me" }),
          makeInviteResponse({ code: "dead1", revoked: true }),
        ]),
    });

    const controller = createInviteManagerController({
      api: api as never,
      getRoot: () => root,
    });

    await controller.open();

    const opts = (createInviteManager as Mock).mock.calls[0]![0] as {
      invites: Array<{ code: string }>;
    };
    expect(opts.invites.map((i) => i.code)).toEqual(["live1"]);
  });

  it("filters out expired invites so Copy cannot hand out a dead code (F4)", async () => {
    const api = makeMockApi({
      getInvites: vi.fn().mockResolvedValue([
        makeInviteResponse({
          code: "live1",
          max_uses: null,
          creator_username: "me",
          expires_at: "2099-01-01T00:00:00Z",
        }),
        makeInviteResponse({ code: "expired1", expires_at: "2000-01-01T00:00:00Z" }),
      ]),
    });

    const controller = createInviteManagerController({
      api: api as never,
      getRoot: () => root,
    });

    await controller.open();

    const opts = (createInviteManager as Mock).mock.calls[0]![0] as {
      invites: Array<{ code: string }>;
    };
    expect(opts.invites.map((i) => i.code)).toEqual(["live1"]);
  });

  it("onRevokeInvite catches API error and re-throws for component handling", async () => {
    const api = makeMockApi({
      revokeInvite: vi.fn().mockRejectedValue(new Error("network error")),
    });

    const controller = createInviteManagerController({
      api: api as never,
      getRoot: () => root,
    });

    await controller.open();

    // Extract the onRevokeInvite callback passed to InviteManager
    const opts = (createInviteManager as Mock).mock.calls[0]![0] as {
      onRevokeInvite: (code: string) => Promise<void>;
    };

    // The callback should re-throw so InviteManager's catch prevents optimistic removal
    await expect(opts.onRevokeInvite("abc123xyz")).rejects.toThrow("network error");

    // Controller should log the error with context
    expect(mockLogError).toHaveBeenCalled();
  });

  it("onRevokeInvite succeeds normally when API works", async () => {
    const api = makeMockApi();

    const controller = createInviteManagerController({
      api: api as never,
      getRoot: () => root,
    });

    await controller.open();

    const opts = (createInviteManager as Mock).mock.calls[0]![0] as {
      onRevokeInvite: (code: string) => Promise<void>;
    };

    await expect(opts.onRevokeInvite("abc123xyz")).resolves.toBeUndefined();
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it("opening with no live invite creates exactly one (7 days, no limit) and features it", async () => {
    const api = makeMockApi({
      getInvites: vi.fn().mockResolvedValue([]),
      createInvite: vi.fn().mockResolvedValue(makeInviteResponse({ code: "fresh1" })),
    });
    const controller = createInviteManagerController({ api: api as never, getRoot: () => root });
    await controller.open();
    expect(api.createInvite).toHaveBeenCalledTimes(1);
    expect(api.createInvite).toHaveBeenCalledWith({ expires_in_hours: 168, max_uses: 0 });
    const opts = (createInviteManager as Mock).mock.calls[0]![0] as {
      invites: Array<{ code: string }>;
      featuredCode: string;
    };
    expect(opts.featuredCode).toBe("fresh1");
    expect(opts.invites.map((i) => i.code)).toEqual(["fresh1"]);
  });

  it("opening with a live invite creates none and features the newest live one", async () => {
    const api = makeMockApi({
      getInvites: vi.fn().mockResolvedValue([
        makeInviteResponse({
          id: 1,
          code: "old",
          max_uses: null,
          creator_username: "me",
          created_at: "2026-01-01T00:00:00Z",
        }),
        makeInviteResponse({
          id: 2,
          code: "newer",
          max_uses: null,
          creator_username: "me",
          created_at: "2026-02-01T00:00:00Z",
        }),
        // expires within 24 h: not live for this purpose
        makeInviteResponse({
          id: 3,
          code: "soon",
          max_uses: null,
          creator_username: "me",
          created_at: "2026-03-01T00:00:00Z",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      ]),
    });
    const controller = createInviteManagerController({ api: api as never, getRoot: () => root });
    await controller.open();
    expect(api.createInvite).not.toHaveBeenCalled();
    const opts = (createInviteManager as Mock).mock.calls[0]![0] as { featuredCode: string };
    expect(opts.featuredCode).toBe("newer");
  });

  it("another member's live invite and my own limited invite do not count as the fresh link", async () => {
    const api = makeMockApi({
      getInvites: vi
        .fn()
        .mockResolvedValue([
          makeInviteResponse({ id: 1, code: "theirs", max_uses: null, creator_username: "other" }),
          makeInviteResponse({ id: 2, code: "limited", max_uses: 1, creator_username: "me" }),
        ]),
      createInvite: vi.fn().mockResolvedValue(makeInviteResponse({ code: "mine-new" })),
    });
    const controller = createInviteManagerController({ api: api as never, getRoot: () => root });
    await controller.open();
    expect(api.createInvite).toHaveBeenCalledTimes(1);
    const opts = (createInviteManager as Mock).mock.calls[0]![0] as { featuredCode: string };
    expect(opts.featuredCode).toBe("mine-new");
  });

  it("a failed create-on-open still opens the manager with the list and toasts the reason", async () => {
    const api = makeMockApi({
      getInvites: vi
        .fn()
        .mockResolvedValue([makeInviteResponse({ code: "theirs", creator_username: "other" })]),
      createInvite: vi.fn().mockRejectedValue(new Error("Invite limit reached")),
    });
    const controller = createInviteManagerController({ api: api as never, getRoot: () => root });
    await controller.open();
    expect(api.createInvite).toHaveBeenCalledTimes(1);
    const opts = (createInviteManager as Mock).mock.calls[0]![0] as {
      invites: Array<{ code: string }>;
      featuredCode: string | null;
    };
    expect(opts.featuredCode).toBeNull();
    expect(opts.invites.map((i) => i.code)).toEqual(["theirs"]);
    expect(mockShowToast).toHaveBeenCalledWith("Invite limit reached", "error");
    controller.cleanup();
  });

  it("does not open or create anything without MANAGE_INVITES", async () => {
    mockCanManageInvites.value = false;
    try {
      const api = makeMockApi({ getInvites: vi.fn().mockResolvedValue([]) });
      const controller = createInviteManagerController({ api: api as never, getRoot: () => root });
      await controller.open();
      expect(api.getInvites).not.toHaveBeenCalled();
      expect(api.createInvite).not.toHaveBeenCalled();
    } finally {
      mockCanManageInvites.value = true;
    }
  });

  it("a load failure shows an inline Retry that reloads", async () => {
    const getInvites = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue([makeInviteResponse()]);
    const api = makeMockApi({ getInvites });
    const controller = createInviteManagerController({ api: api as never, getRoot: () => root });
    await controller.open();
    const retry = [...root.querySelectorAll("button")].find((b) => b.textContent === "Retry");
    expect(retry).toBeDefined();
    retry!.click();
    await vi.waitFor(() => expect(createInviteManager).toHaveBeenCalledOnce());
    expect(getInvites).toHaveBeenCalledTimes(2);
    expect(root.textContent).not.toContain("Retry");
    controller.cleanup();
  });

  it("shows the inline error, not a duplicate toast, when open fails to load invites", async () => {
    const api = makeMockApi({
      getInvites: vi.fn().mockRejectedValue(new Error("load failed")),
    });

    const controller = createInviteManagerController({
      api: api as never,
      getRoot: () => root,
    });

    await controller.open();

    expect(mockShowToast).not.toHaveBeenCalled();
    expect(root.textContent).toContain("Failed to load invites");
    controller.cleanup();
  });
});

describe("createPinnedPanelController", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const c of openPinnedControllers.splice(0)) c.cleanup();
    root.remove();
  });

  it("toggles pinned panel open and mounts to root", async () => {
    const api = makeMockApi();

    const controller = createPinnedPanelController({
      api: api as never,
      getRoot: () => root,

      getCurrentChannelId: () => 42,
    });

    await controller.toggle();

    expect(createPinnedMessages).toHaveBeenCalledOnce();
    expect(mockPinnedMessagesMount).toHaveBeenCalledWith(root);
  });

  it("open() opens a closed panel and never closes or rebuilds an open one", async () => {
    const api = makeMockApi();
    const controller = createPinnedPanelController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 42,
    });

    await controller.open();
    expect(createPinnedMessages).toHaveBeenCalledOnce();
    expect(mockPinnedMessagesMount).toHaveBeenCalledOnce();

    await controller.open();
    await controller.open();
    expect(createPinnedMessages).toHaveBeenCalledOnce();
    expect(mockPinnedMessagesDestroy).not.toHaveBeenCalled();
    expect(api.getPins).toHaveBeenCalledOnce();

    // toggle still closes it, and open() then reopens it.
    await controller.toggle();
    expect(mockPinnedMessagesDestroy).toHaveBeenCalledOnce();
    await controller.open();
    expect(createPinnedMessages).toHaveBeenCalledTimes(2);
  });

  it("concurrent open() calls fetch once", async () => {
    const api = makeMockApi();
    const controller = createPinnedPanelController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 42,
    });
    await Promise.all([controller.open(), controller.open()]);
    expect(api.getPins).toHaveBeenCalledOnce();
    expect(createPinnedMessages).toHaveBeenCalledOnce();
  });

  it("does not open, fetch or toast behind an NSFW consent gate", async () => {
    const api = makeMockApi();
    const controller = createPinnedPanelController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 99,
    });

    await controller.toggle();

    expect(api.getPins).not.toHaveBeenCalled();
    expect(createPinnedMessages).not.toHaveBeenCalled();
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it("closeFor closes the panel only for the channel it was opened for", async () => {
    let current = 42;
    const controller = createPinnedPanelController({
      api: makeMockApi() as never,
      getRoot: () => root,
      getCurrentChannelId: () => current,
    });

    await controller.toggle();
    current = 7;
    controller.closeFor(7);
    expect(mockPinnedMessagesDestroy).not.toHaveBeenCalled();

    controller.closeFor(42);
    expect(mockPinnedMessagesDestroy).toHaveBeenCalledOnce();
  });

  it("omits onUnpin when the viewer cannot pin (F1)", async () => {
    // A plain member must not be offered an unpin the server (MANAGE_MESSAGES)
    // would refuse; the panel is read-only for them.
    const api = makeMockApi();
    const controller = createPinnedPanelController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 42,
      canPin: () => false,
    });

    await controller.toggle();

    const opts = (createPinnedMessages as Mock).mock.calls[0]![0] as {
      onUnpin?: (msgId: number) => void;
    };
    expect(opts.onUnpin).toBeUndefined();
  });

  it("onUnpin catches API error, shows toast, and does NOT close the panel", async () => {
    const api = makeMockApi({
      unpinMessage: vi.fn().mockRejectedValue(new Error("unpin failed")),
    });

    const controller = createPinnedPanelController({
      api: api as never,
      getRoot: () => root,

      getCurrentChannelId: () => 42,
      canPin: () => true,
    });

    await controller.toggle();

    // Extract onUnpin callback passed to PinnedMessages
    const opts = (createPinnedMessages as Mock).mock.calls[0]![0] as {
      onUnpin: (msgId: number) => void;
    };

    // Call onUnpin — it should handle the error internally
    opts.onUnpin(1);

    // Wait for the async error handling to complete
    await vi.waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith("Failed to unpin message", "error");
    });

    // Panel should NOT have been destroyed (still open)
    expect(mockPinnedMessagesDestroy).not.toHaveBeenCalled();
  });

  it("onUnpin removes the card in place on success and keeps the panel open", async () => {
    const api = makeMockApi();

    const controller = createPinnedPanelController({
      api: api as never,
      getRoot: () => root,

      getCurrentChannelId: () => 42,
      canPin: () => true,
    });

    await controller.toggle();

    const opts = (createPinnedMessages as Mock).mock.calls[0]![0] as {
      onUnpin: (msgId: number) => void;
    };

    opts.onUnpin(1);

    // Wait for the async success handling to complete
    await vi.waitFor(() => {
      expect(mockPinnedRemovePin).toHaveBeenCalledWith(1);
    });

    // The store's `pinned` flag is the row's only local authority until the
    // chat_pinned broadcast — without this the row still says "Unpin" after a
    // panel unpin, and re-clicking it calls unpinMessage on an unpinned message.
    expect(mockSetMessagePinned).toHaveBeenCalledWith(42, 1, false);

    // The panel stays open (jump-to-message is what closes it).
    expect(mockPinnedMessagesDestroy).not.toHaveBeenCalled();

    // No error toast should be shown
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  describe("live updates while open", () => {
    const pin = (id: number, content: string) => ({
      id,
      user: { id: 1, username: "Alice" },
      content,
      created_at: "2024-01-01",
    });

    beforeEach(() => {
      vi.useFakeTimers();
      messagesStore.setState(() => ({ pinRevision: new Map<number, number>() }) as never);
      channelsStore.setState(
        (prev) =>
          ({
            channels: new Map(prev.channels).set(42, {
              id: 42,
              name: "pins",
              type: "text",
              canPin: true,
            } as never),
          }) as never,
      );
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const bumpPins = (channelId: number): void => {
      messagesStore.setState(
        (prev) =>
          ({
            pinRevision: new Map(prev.pinRevision).set(
              channelId,
              (prev.pinRevision?.get(channelId) ?? 0) + 1,
            ),
          }) as never,
      );
      messagesStore.flush();
    };

    async function openPanel(api: ReturnType<typeof makeMockApi>, canPin = () => true) {
      const controller = createPinnedPanelController({
        api: api as never,
        getRoot: () => root,
        getCurrentChannelId: () => 42,
        canPin,
      });
      await controller.toggle();
      return controller;
    }

    it("refetches the channel's pins once, debounced, after pin changes", async () => {
      const api = makeMockApi();
      await openPanel(api);
      expect(api.getPins).toHaveBeenCalledTimes(1);

      api.getPins.mockResolvedValue({ messages: [pin(7, "fresh")] });
      bumpPins(42);
      bumpPins(42);
      await vi.advanceTimersByTimeAsync(200);
      expect(api.getPins).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(100);
      expect(api.getPins).toHaveBeenCalledTimes(2);
      expect(mockPinnedSetPins).toHaveBeenCalledOnce();
      const shown = mockPinnedSetPins.mock.calls[0]![0] as Array<{ id: number }>;
      expect(shown.map((p) => p.id)).toEqual([7]);
    });

    it("refetches once when the connection returns, with the panel's abort signal", async () => {
      const api = makeMockApi();
      const controller = await openPanel(api);
      expect(api.getPins.mock.calls[0]).toHaveLength(1);

      setConnectionStatus("reconnecting");
      uiStore.flush();
      await vi.advanceTimersByTimeAsync(500);
      expect(api.getPins).toHaveBeenCalledTimes(1);

      setConnectionStatus("connected");
      uiStore.flush();
      await vi.advanceTimersByTimeAsync(300);
      expect(api.getPins).toHaveBeenCalledTimes(2);
      const signal = api.getPins.mock.calls[1]![1] as AbortSignal;
      expect(signal.aborted).toBe(false);
      expect(mockPinnedSetPins).toHaveBeenCalledOnce();

      controller.cleanup();
      expect(signal.aborted).toBe(true);
      setConnectionStatus("reconnecting");
      setConnectionStatus("connected");
      uiStore.flush();
      await vi.advanceTimersByTimeAsync(500);
      expect(api.getPins).toHaveBeenCalledTimes(2);
    });

    it("ignores a pin change in another channel", async () => {
      const api = makeMockApi();
      await openPanel(api);
      bumpPins(7);
      await vi.advanceTimersByTimeAsync(500);
      expect(api.getPins).toHaveBeenCalledTimes(1);
      expect(mockPinnedSetPins).not.toHaveBeenCalled();
    });

    it("drops a refetch response that lands after the panel closed", async () => {
      const api = makeMockApi();
      const controller = await openPanel(api);
      let resolveLate: (v: unknown) => void = () => {};
      api.getPins.mockReturnValue(new Promise((r) => (resolveLate = r)));
      bumpPins(42);
      await vi.advanceTimersByTimeAsync(300);
      expect(api.getPins).toHaveBeenCalledTimes(2);

      controller.cleanup();
      resolveLate({ messages: [pin(8, "late")] });
      await vi.advanceTimersByTimeAsync(0);
      expect(mockPinnedSetPins).not.toHaveBeenCalled();
    });

    it("stops watching once closed: no timer, no refetch", async () => {
      const api = makeMockApi();
      const controller = await openPanel(api);
      bumpPins(42);
      controller.cleanup();
      await vi.advanceTimersByTimeAsync(500);
      bumpPins(42);
      await vi.advanceTimersByTimeAsync(500);
      expect(api.getPins).toHaveBeenCalledTimes(1);
    });

    it("withdraws Unpin when the channel's canPin turns off and offers it again when it returns", async () => {
      const api = makeMockApi();
      let allowed = true;
      await openPanel(api, () => allowed);

      allowed = false;
      channelsStore.setState(
        (prev) =>
          ({
            channels: new Map(prev.channels).set(42, {
              id: 42,
              type: "text",
              canPin: false,
            } as never),
          }) as never,
      );
      channelsStore.flush();
      expect(mockPinnedSetOnUnpin).toHaveBeenLastCalledWith(undefined);

      allowed = true;
      channelsStore.setState(
        (prev) =>
          ({
            channels: new Map(prev.channels).set(42, {
              id: 42,
              type: "text",
              canPin: true,
            } as never),
          }) as never,
      );
      channelsStore.flush();
      expect(mockPinnedSetOnUnpin).toHaveBeenLastCalledWith(expect.any(Function));
    });

    it("re-evaluates the permission when the viewer's role revision changes", async () => {
      const api = makeMockApi();
      let allowed = false;
      await openPanel(api, () => allowed);
      expect(mockPinnedSetOnUnpin).not.toHaveBeenCalled();

      allowed = true;
      setMembers([]);
      membersStore.flush();
      expect(mockPinnedSetOnUnpin).toHaveBeenLastCalledWith(expect.any(Function));
    });
  });

  it("onJumpToMessage forwards the panel's own channel id (captured at open time), not just the message id", async () => {
    const api = makeMockApi();
    const mockScrollToMessage = vi.fn().mockReturnValue(true);

    const controller = createPinnedPanelController({
      api: api as never,
      getRoot: () => root,

      getCurrentChannelId: () => 42,
      onJumpToMessage: mockScrollToMessage,
    });

    await controller.toggle();

    const opts = (createPinnedMessages as Mock).mock.calls[0]![0] as {
      onJumpToMessage: (msgId: number) => void;
    };

    opts.onJumpToMessage(1);

    // A caller juggling several channels (ChatArea re-reads currentChannelId
    // live at click time) needs the panel's own channel, not whatever
    // channel happens to be active when the click lands.
    expect(mockScrollToMessage).toHaveBeenCalledWith(42, 1);
    expect(mockPinnedMessagesDestroy).toHaveBeenCalled();
  });

  it("closes and delegates even for a message outside the loaded window", async () => {
    const api = makeMockApi();
    const mockJump = vi.fn();

    const controller = createPinnedPanelController({
      api: api as never,
      getRoot: () => root,

      getCurrentChannelId: () => 42,
      onJumpToMessage: mockJump,
    });

    await controller.toggle();

    const opts = (createPinnedMessages as Mock).mock.calls[0]![0] as {
      onJumpToMessage: (msgId: number) => void;
    };

    opts.onJumpToMessage(999);

    // The jumper fetches the around-window for an unloaded target and reports
    // its own failures, so the panel no longer second-guesses it with a
    // "not in loaded window" toast — it just gets out of the way.
    expect(mockJump).toHaveBeenCalledWith(42, 999);
    expect(mockPinnedMessagesDestroy).toHaveBeenCalled();
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it("shows toast when toggle fails to load pins", async () => {
    const api = makeMockApi({
      getPins: vi.fn().mockRejectedValue(new Error("load failed")),
    });

    const controller = createPinnedPanelController({
      api: api as never,
      getRoot: () => root,

      getCurrentChannelId: () => 42,
    });

    await controller.toggle();

    expect(mockShowToast).toHaveBeenCalledWith("Failed to load pinned messages", "error");
  });

  it("does nothing when root is null", async () => {
    const api = makeMockApi();

    const controller = createPinnedPanelController({
      api: api as never,
      getRoot: () => null,
      getCurrentChannelId: () => 42,
    });

    await controller.toggle();

    expect(createPinnedMessages).not.toHaveBeenCalled();
  });

  it("does nothing when channelId is null", async () => {
    const api = makeMockApi();

    const controller = createPinnedPanelController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => null,
    });

    await controller.toggle();

    expect(createPinnedMessages).not.toHaveBeenCalled();
  });

  it("toggle closes panel when already open", async () => {
    const api = makeMockApi();

    const controller = createPinnedPanelController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 42,
    });

    await controller.toggle();
    expect(mockPinnedMessagesMount).toHaveBeenCalledOnce();

    // Toggle again should close
    await controller.toggle();
    expect(mockPinnedMessagesDestroy).toHaveBeenCalled();
  });

  it("cleanup closes panel if open", async () => {
    const api = makeMockApi();

    const controller = createPinnedPanelController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 42,
    });

    await controller.toggle();
    controller.cleanup();

    expect(mockPinnedMessagesDestroy).toHaveBeenCalled();
  });

  it("does not mount a second panel from a double-click while getPins is in flight", async () => {
    let resolvePins: (value: { messages: unknown[] }) => void;
    const pending = new Promise<{ messages: unknown[] }>((resolve) => {
      resolvePins = resolve;
    });
    const api = makeMockApi({ getPins: vi.fn().mockReturnValue(pending) });

    const controller = createPinnedPanelController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 42,
    });

    const first = controller.toggle();
    const second = controller.toggle(); // fires while getPins is still pending

    resolvePins!({ messages: [] });
    await Promise.all([first, second]);

    expect(mockPinnedMessagesMount).toHaveBeenCalledOnce();
    expect(api.getPins).toHaveBeenCalledOnce();
  });

  it("a cleanup while getPins is in flight cancels the open, and a later toggle still opens", async () => {
    let resolvePins: (value: { messages: unknown[] }) => void;
    const pending = new Promise<{ messages: unknown[] }>((resolve) => {
      resolvePins = resolve;
    });
    const api = makeMockApi({
      getPins: vi.fn().mockReturnValueOnce(pending).mockResolvedValue({ messages: [] }),
    });

    const controller = createPinnedPanelController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 42,
    });

    const opening = controller.toggle();
    controller.cleanup(); // e.g. the narrow-width drawer opening over it
    resolvePins!({ messages: [] });
    await opening;

    expect(createPinnedMessages).not.toHaveBeenCalled();
    expect(mockPinnedMessagesMount).not.toHaveBeenCalled();

    await controller.toggle();
    expect(mockPinnedMessagesMount).toHaveBeenCalledOnce();
  });

  it("re-checks getRoot after the getPins() await and does not mount on a torn-down page", async () => {
    // Same teardown-during-fetch race as InviteManagerController.open (OC-0055):
    // toggle() must not mount on the pre-await root once the page has torn
    // down while getPins() was in flight.
    const api = makeMockApi();
    let calls = 0;
    const getRoot = vi.fn(() => {
      calls++;
      return calls === 1 ? root : null;
    });

    const controller = createPinnedPanelController({
      api: api as never,
      getRoot,
      getCurrentChannelId: () => 42,
    });

    await controller.toggle();

    expect(createPinnedMessages).not.toHaveBeenCalled();
    expect(mockPinnedMessagesMount).not.toHaveBeenCalled();
  });

  it("cleanup is safe when no panel is open", () => {
    const api = makeMockApi();

    const controller = createPinnedPanelController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 42,
    });

    // Should not throw
    controller.cleanup();
    expect(mockPinnedMessagesDestroy).not.toHaveBeenCalled();
  });

  it("onJumpToMessage closes panel when no callback is provided", async () => {
    const api = makeMockApi();

    const controller = createPinnedPanelController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 42,
      // no onJumpToMessage provided
    });

    await controller.toggle();

    const opts = (createPinnedMessages as Mock).mock.calls[0]![0] as {
      onJumpToMessage: (msgId: number) => void;
    };

    opts.onJumpToMessage(1);

    // Without a callback, should just close the panel
    expect(mockPinnedMessagesDestroy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// mapInviteResponse
// ---------------------------------------------------------------------------

describe("mapInviteResponse", () => {
  it("maps a basic invite response with use_count", () => {
    const result = mapInviteResponse({
      id: 1,
      code: "abc123",
      url: "https://example.com/abc123",
      max_uses: 10,
      use_count: 3,
      expires_at: "2024-12-31",
    });

    expect(result.code).toBe("abc123");
    expect(result.uses).toBe(3);
    expect(result.maxUses).toBe(10);
    expect(result.expiresAt).toBe("2024-12-31");
    expect(result.createdBy).toBe("unknown");
    // created_at is distinct from expires_at now (F4).
    expect(result.createdAt).toBe("");
  });

  it("uses the server's creator_username and created_at (F4)", () => {
    const result = mapInviteResponse({
      id: 1,
      code: "abc",
      url: "https://example.com/abc",
      max_uses: 5,
      use_count: 0,
      expires_at: "2099-01-01T00:00:00Z",
      revoked: false,
      created_at: "2026-01-01T00:00:00Z",
      creator_username: "Alice",
    });
    expect(result.createdBy).toBe("Alice");
    expect(result.createdAt).toBe("2026-01-01T00:00:00Z");
    expect(result.expiresAt).toBe("2099-01-01T00:00:00Z");
  });

  it("falls back to the legacy nested created_by username", () => {
    const raw = {
      id: 1,
      code: "abc",
      url: "https://example.com/abc",
      max_uses: 5,
      use_count: 0,
      expires_at: null,
      created_by: { username: "Alice" },
    };

    const result = mapInviteResponse(raw as never);
    expect(result.createdBy).toBe("Alice");
  });

  it("falls back to 'unknown' when created_by has no username", () => {
    const raw = {
      id: 1,
      code: "abc",
      url: "https://example.com/abc",
      max_uses: 5,
      use_count: 0,
      expires_at: null,
      created_by: {},
    };

    const result = mapInviteResponse(raw as never);
    expect(result.createdBy).toBe("unknown");
  });

  it("falls back to 'unknown' when created_by is not an object", () => {
    const raw = {
      id: 1,
      code: "abc",
      url: "https://example.com/abc",
      max_uses: 5,
      use_count: 0,
      expires_at: null,
      created_by: "string-value",
    };

    const result = mapInviteResponse(raw as never);
    expect(result.createdBy).toBe("unknown");
  });

  it("uses 'uses' extra field when use_count is undefined", () => {
    const raw = {
      id: 1,
      code: "abc",
      url: "https://example.com/abc",
      max_uses: 5,
      use_count: undefined,
      expires_at: null,
      uses: 7,
    };

    const result = mapInviteResponse(raw as never);
    expect(result.uses).toBe(7);
  });

  it("defaults uses to 0 when neither use_count nor uses is present", () => {
    const raw = {
      id: 1,
      code: "abc",
      url: "https://example.com/abc",
      max_uses: 5,
      use_count: undefined,
      expires_at: null,
    };

    const result = mapInviteResponse(raw as never);
    expect(result.uses).toBe(0);
  });

  it("uses empty string for createdAt when expires_at is null", () => {
    const raw = {
      id: 1,
      code: "abc",
      url: "https://example.com/abc",
      max_uses: 5,
      use_count: 0,
      expires_at: null,
    };

    const result = mapInviteResponse(raw as never);
    expect(result.createdAt).toBe("");
  });
});

// ---------------------------------------------------------------------------
// mapToPinnedMessage
// ---------------------------------------------------------------------------

describe("mapToPinnedMessage", () => {
  afterEach(() => {
    setMembers([]);
  });

  it("maps a pinned message with created_at", () => {
    const result = mapToPinnedMessage({
      id: 1,
      user: { id: 101, username: "Alice", avatar: null },
      content: "Hello",
      created_at: "2024-01-01",
    });

    expect(result.id).toBe(1);
    expect(result.author).toBe("Alice");
    expect(result.content).toBe("Hello");
    expect(result.timestamp).toBe("2024-01-01");
    expect(result.avatarColor).toMatch(/^hsl\(\d+, 55%, 55%\)$/);
  });

  it("carries the author's avatar from the payload", () => {
    const result = mapToPinnedMessage({
      id: 1,
      user: { id: 101, username: "Alice", avatar: "/api/v1/files/abc" },
      content: "Hello",
    });

    expect(result.avatar).toBe("/api/v1/files/abc");
  });

  it("prefers the live membersStore avatar over the payload's", () => {
    setMembers([
      {
        id: 101,
        username: "alice",
        avatar: "/api/v1/files/new",
        role: "member",
        status: "online",
      },
    ]);

    const result = mapToPinnedMessage({
      id: 1,
      user: { id: 101, username: "alice", avatar: "/api/v1/files/old" },
      content: "Hello",
    });

    expect(result.avatar).toBe("/api/v1/files/new");
  });

  it("falls back to timestamp when created_at is undefined", () => {
    const result = mapToPinnedMessage({
      id: 2,
      user: { id: 102, username: "Bob", avatar: null },
      content: "World",
      timestamp: "2024-02-15",
    });

    expect(result.timestamp).toBe("2024-02-15");
  });

  it("falls back to empty string when neither created_at nor timestamp is set", () => {
    const result = mapToPinnedMessage({
      id: 3,
      user: { id: 103, username: "Charlie", avatar: null },
      content: "No timestamp",
    });

    expect(result.timestamp).toBe("");
  });

  it("generates deterministic avatar color for same username", () => {
    const a = mapToPinnedMessage({
      id: 1,
      user: { id: 101, username: "Alice", avatar: null },
      content: "",
    });
    const b = mapToPinnedMessage({
      id: 2,
      user: { id: 101, username: "Alice", avatar: null },
      content: "",
    });

    expect(a.avatarColor).toBe(b.avatarColor);
  });

  it("generates different colors for different usernames", () => {
    const a = mapToPinnedMessage({
      id: 1,
      user: { id: 101, username: "Alice", avatar: null },
      content: "",
    });
    const b = mapToPinnedMessage({
      id: 2,
      user: { id: 102, username: "Bob", avatar: null },
      content: "",
    });

    // Not guaranteed to be different in theory, but these specific names will differ
    expect(a.avatarColor).not.toBe(b.avatarColor);
  });

  it("renders the live membersStore nickname, not the raw payload username", () => {
    setMembers([
      {
        id: 101,
        username: "bob",
        avatar: null,
        role: "member",
        status: "online",
        display_name: "Bobby",
      },
    ]);

    const result = mapToPinnedMessage({
      id: 1,
      user: { id: 101, username: "bob", avatar: null },
      content: "Hello",
    });

    expect(result.author).toBe("Bobby");
    // Avatar hue stays keyed off the raw username, stable across renames.
    expect(result.avatarColor).toBe(
      mapToPinnedMessage({
        id: 2,
        user: { id: 999, username: "bob", avatar: null },
        content: "",
      }).avatarColor,
    );
  });
});

// ---------------------------------------------------------------------------
// createQuickSwitcherManager
// ---------------------------------------------------------------------------

describe("createQuickSwitcherManager", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
    vi.clearAllMocks();
  });

  afterEach(() => {
    root.remove();
  });

  it("opens quick switcher on Ctrl+K", async () => {
    const manager = createQuickSwitcherManager(() => root);
    const cleanup = manager.attach();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    await vi.dynamicImportSettled();

    expect(createQuickSwitcher).toHaveBeenCalledOnce();
    expect(mockQuickSwitcherMount).toHaveBeenCalledWith(root);

    cleanup();
  });

  it("a held Ctrl+K opens the switcher once and auto-repeat does not close it", async () => {
    const manager = createQuickSwitcherManager(() => root);
    const cleanup = manager.attach();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    await vi.dynamicImportSettled();
    for (let i = 0; i < 3; i++) {
      const repeat = new KeyboardEvent("keydown", {
        key: "k",
        ctrlKey: true,
        repeat: true,
        cancelable: true,
      });
      document.dispatchEvent(repeat);
      expect(repeat.defaultPrevented).toBe(true);
    }
    await vi.dynamicImportSettled();

    expect(createQuickSwitcher).toHaveBeenCalledOnce();
    expect(mockQuickSwitcherDestroy).not.toHaveBeenCalled();

    cleanup();
  });

  it("an auto-repeating Ctrl+K alone never opens the switcher", async () => {
    const manager = createQuickSwitcherManager(() => root);
    const cleanup = manager.attach();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, repeat: true }));
    await vi.dynamicImportSettled();

    expect(createQuickSwitcher).not.toHaveBeenCalled();
    cleanup();
  });

  it("closes quick switcher on second Ctrl+K", async () => {
    const manager = createQuickSwitcherManager(() => root);
    const cleanup = manager.attach();

    // Open
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    await vi.dynamicImportSettled();
    expect(createQuickSwitcher).toHaveBeenCalledOnce();

    // Close
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    await vi.dynamicImportSettled();
    expect(mockQuickSwitcherDestroy).toHaveBeenCalled();

    cleanup();
  });

  it("opens on Ctrl+K from the focused composer, but not while a modal is open", async () => {
    const manager = createQuickSwitcherManager(() => root);
    const cleanup = manager.attach();

    const modal = document.createElement("div");
    modal.className = "modal-overlay visible";
    document.body.appendChild(modal);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    await vi.dynamicImportSettled();
    expect(createQuickSwitcher).not.toHaveBeenCalled();
    modal.remove();

    const composer = document.createElement("textarea");
    document.body.appendChild(composer);
    composer.focus();
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }),
    );
    await vi.dynamicImportSettled();
    expect(createQuickSwitcher).toHaveBeenCalledOnce();

    composer.remove();
    cleanup();
  });

  it("opens quick switcher on Meta+K (macOS)", async () => {
    const manager = createQuickSwitcherManager(() => root);
    const cleanup = manager.attach();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
    await vi.dynamicImportSettled();

    expect(createQuickSwitcher).toHaveBeenCalledOnce();

    cleanup();
  });

  it("does not open on plain K key without modifier", async () => {
    const manager = createQuickSwitcherManager(() => root);
    const cleanup = manager.attach();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k" }));
    await vi.dynamicImportSettled();

    expect(createQuickSwitcher).not.toHaveBeenCalled();

    cleanup();
  });

  it("does nothing when root is null", async () => {
    const manager = createQuickSwitcherManager(() => null);
    const cleanup = manager.attach();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    await vi.dynamicImportSettled();

    expect(createQuickSwitcher).not.toHaveBeenCalled();

    cleanup();
  });

  it("cleanup removes the keydown listener and closes", async () => {
    const manager = createQuickSwitcherManager(() => root);
    const cleanup = manager.attach();

    // Open first
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    await vi.dynamicImportSettled();
    expect(createQuickSwitcher).toHaveBeenCalledOnce();

    // Cleanup
    cleanup();

    // Verify destroy was called
    expect(mockQuickSwitcherDestroy).toHaveBeenCalled();

    // After cleanup, Ctrl+K should not open a new instance
    vi.clearAllMocks();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    await vi.dynamicImportSettled();
    expect(createQuickSwitcher).not.toHaveBeenCalled();
  });

  it("onSelectChannel callback sets active channel", async () => {
    const manager = createQuickSwitcherManager(() => root);
    const cleanup = manager.attach();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    await vi.dynamicImportSettled();

    // Extract the onSelectChannel callback
    const opts = (createQuickSwitcher as Mock).mock.calls[0]![0] as {
      onSelectChannel: (channelId: number) => void;
    };

    opts.onSelectChannel(42);
    expect(mockSetActiveChannel).toHaveBeenCalledWith(42);

    cleanup();
  });

  it("joins voice instead of setting the active channel for a voice row (F8)", async () => {
    const join = vi.fn();
    const manager = createQuickSwitcherManager(() => root, undefined, join);
    const cleanup = manager.attach();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    await vi.dynamicImportSettled();

    const opts = (createQuickSwitcher as Mock).mock.calls[0]![0] as {
      onSelectChannel: (channelId: number) => void;
    };
    opts.onSelectChannel(3);

    expect(join).toHaveBeenCalledWith(3);
    expect(mockSetActiveChannel).not.toHaveBeenCalled();

    cleanup();
  });

  it("sets the active channel for a text row (F8)", async () => {
    const join = vi.fn();
    const manager = createQuickSwitcherManager(() => root, undefined, join);
    const cleanup = manager.attach();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    await vi.dynamicImportSettled();

    const opts = (createQuickSwitcher as Mock).mock.calls[0]![0] as {
      onSelectChannel: (channelId: number) => void;
    };
    opts.onSelectChannel(4);

    expect(mockSetActiveChannel).toHaveBeenCalledWith(4);
    expect(join).not.toHaveBeenCalled();

    cleanup();
  });

  it("onClose callback resets instance so re-open works", async () => {
    const manager = createQuickSwitcherManager(() => root);
    const cleanup = manager.attach();

    // Open
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    await vi.dynamicImportSettled();
    expect(createQuickSwitcher).toHaveBeenCalledOnce();

    // Simulate component calling onClose directly
    const opts = (createQuickSwitcher as Mock).mock.calls[0]![0] as {
      onClose: () => void;
    };
    opts.onClose();

    // Re-open should work
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    await vi.dynamicImportSettled();
    expect(createQuickSwitcher).toHaveBeenCalledTimes(2);

    cleanup();
  });

  it("does not open a second instance if already open", async () => {
    const manager = createQuickSwitcherManager(() => root);
    const cleanup = manager.attach();

    // Open
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    await vi.dynamicImportSettled();

    // Simulate trying to open from external code — the instance check should prevent it
    // The attach() function only exposes Ctrl+K, and the toggle logic handles this
    expect(createQuickSwitcher).toHaveBeenCalledOnce();

    cleanup();
  });

  it("opens on Ctrl+K with CapsLock on (KeyboardEvent.key reports uppercase 'K')", async () => {
    // OC-0150: `e.key` reflects CapsLock/Shift state. A case-sensitive `=== "k"`
    // check means CapsLock (or Ctrl+Shift+K) silently does nothing.
    const manager = createQuickSwitcherManager(() => root);
    const cleanup = manager.attach();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "K", ctrlKey: true }));
    await vi.dynamicImportSettled();

    expect(createQuickSwitcher).toHaveBeenCalledOnce();

    cleanup();
  });

  it("does not open on AltGr+K (Windows reports AltGr as ctrlKey+altKey)", async () => {
    // OC-0150: without an altKey exclusion, AltGr-produced characters on
    // non-US layouts get swallowed by an unwanted preventDefault().
    const manager = createQuickSwitcherManager(() => root);
    const cleanup = manager.attach();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, altKey: true }));
    await vi.dynamicImportSettled();

    expect(createQuickSwitcher).not.toHaveBeenCalled();

    cleanup();
  });

  it("does not open while isSuspended() reports true (e.g. settings overlay open)", async () => {
    // OC-0150: every other global shortcut honours isSuspended; the quick
    // switcher never got the guard, so it could stack on top of Settings.
    const manager = createQuickSwitcherManager(
      () => root,
      () => true,
    );
    const cleanup = manager.attach();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    await vi.dynamicImportSettled();

    expect(createQuickSwitcher).not.toHaveBeenCalled();

    cleanup();
  });
});

// ---------------------------------------------------------------------------
// createInviteManagerController (additional coverage)
// ---------------------------------------------------------------------------

describe("createInviteManagerController (additional)", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
    vi.clearAllMocks();
  });

  afterEach(() => {
    root.remove();
  });

  it("does nothing when root is null", async () => {
    const api = makeMockApi();

    const controller = createInviteManagerController({
      api: api as never,
      getRoot: () => null,
    });

    await controller.open();

    expect(createInviteManager).not.toHaveBeenCalled();
  });

  it("does not open a second time if already open", async () => {
    const api = makeMockApi();

    const controller = createInviteManagerController({
      api: api as never,
      getRoot: () => root,
    });

    await controller.open();
    await controller.open();

    expect(createInviteManager).toHaveBeenCalledOnce();
  });

  it("does not mount a second overlay from a double-click while getInvites is in flight", async () => {
    // `instance` is only assigned after the await, so a synchronous
    // `instance !== null` guard alone lets a second call in while the first
    // is still fetching — this is the concurrent case the sequential test
    // above does not exercise.
    let resolveInvites: (value: unknown[]) => void;
    const pending = new Promise<unknown[]>((resolve) => {
      resolveInvites = resolve;
    });
    const api = makeMockApi({ getInvites: vi.fn().mockReturnValue(pending) });

    const controller = createInviteManagerController({
      api: api as never,
      getRoot: () => root,
    });

    const first = controller.open();
    const second = controller.open(); // fires while getInvites is still pending

    resolveInvites!([makeInviteResponse()]);
    await Promise.all([first, second]);

    expect(createInviteManager).toHaveBeenCalledOnce();
    expect(api.getInvites).toHaveBeenCalledOnce();
  });

  it("a cleanup while getInvites is in flight leaves the manager unmounted", async () => {
    let resolveInvites: (value: unknown[]) => void;
    const pending = new Promise<unknown[]>((resolve) => {
      resolveInvites = resolve;
    });
    const api = makeMockApi({ getInvites: vi.fn().mockReturnValue(pending) });

    const controller = createInviteManagerController({
      api: api as never,
      getRoot: () => root,
    });

    const opening = controller.open();
    controller.cleanup();
    resolveInvites!([makeInviteResponse()]);
    await opening;

    expect(createInviteManager).not.toHaveBeenCalled();
  });

  it("cleanup destroys instance when open", async () => {
    const api = makeMockApi();

    const controller = createInviteManagerController({
      api: api as never,
      getRoot: () => root,
    });

    await controller.open();
    controller.cleanup();

    expect(mockInviteManagerDestroy).toHaveBeenCalled();
  });

  it("cleanup is safe when not open", () => {
    const api = makeMockApi();

    const controller = createInviteManagerController({
      api: api as never,
      getRoot: () => root,
    });

    // Should not throw
    controller.cleanup();
    expect(mockInviteManagerDestroy).not.toHaveBeenCalled();
  });

  it("onCreateInvite callback creates and maps an invite", async () => {
    const api = makeMockApi();

    const controller = createInviteManagerController({
      api: api as never,
      getRoot: () => root,
    });

    await controller.open();

    const opts = (createInviteManager as Mock).mock.calls[0]![0] as {
      onCreateInvite: (p: { expiresInHours: number; maxUses: number }) => Promise<unknown>;
    };

    const result = await opts.onCreateInvite({ expiresInHours: 24, maxUses: 5 });
    expect(api.createInvite).toHaveBeenCalledWith({ expires_in_hours: 24, max_uses: 5 });
    expect((result as { code: string }).code).toBe("new123");
  });

  it("onCopyLink copies an invite link to clipboard", async () => {
    const api = makeMockApi({ getConfig: vi.fn().mockReturnValue({ host: "chat.example.com" }) });
    const mockWriteText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText: mockWriteText },
    });

    const controller = createInviteManagerController({
      api: api as never,
      getRoot: () => root,
    });

    await controller.open();

    const opts = (createInviteManager as Mock).mock.calls[0]![0] as {
      onCopyLink: (code: string) => void;
    };

    opts.onCopyLink("test-code");
    expect(mockWriteText).toHaveBeenCalledWith("owncord://invite/test-code?host=chat.example.com");
  });

  describe("onCopyLink builds a shareable owncord:// link", () => {
    async function openAndGetCopy(host: string | undefined) {
      const api = makeMockApi({ getConfig: vi.fn().mockReturnValue({ host }) });
      const controller = createInviteManagerController({
        api: api as never,
        getRoot: () => root,
      });
      await controller.open();
      const opts = (createInviteManager as Mock).mock.calls[0]![0] as {
        onCopyLink: (code: string) => void;
      };
      return opts.onCopyLink;
    }

    it("writes owncord://invite/<code>?host=<encoded host> and toasts success", async () => {
      const mockWriteText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText: mockWriteText } });
      const copy = await openAndGetCopy("chat.example.com:8443");

      copy("ABCD");

      expect(mockWriteText).toHaveBeenCalledWith(
        "owncord://invite/ABCD?host=chat.example.com%3A8443",
      );
      await vi.waitFor(() => {
        expect(mockShowToast).toHaveBeenCalledWith("Invite link copied", "success");
      });
    });

    it("falls back to owncord://invite/<code> when no host is known", async () => {
      const mockWriteText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText: mockWriteText } });
      const copy = await openAndGetCopy(undefined);

      copy("ABCD");

      expect(mockWriteText).toHaveBeenCalledWith("owncord://invite/ABCD");
    });

    it("shows the error toast when the clipboard write is refused", async () => {
      const mockWriteText = vi.fn().mockRejectedValue(new Error("denied"));
      Object.assign(navigator, { clipboard: { writeText: mockWriteText } });
      const copy = await openAndGetCopy("chat.example.com:8443");

      copy("ABCD");

      await vi.waitFor(() => {
        expect(mockShowToast).toHaveBeenCalledWith("Couldn't copy the invite link", "error");
      });
    });
  });

  it("onClose callback destroys instance and allows re-open", async () => {
    const api = makeMockApi();

    const controller = createInviteManagerController({
      api: api as never,
      getRoot: () => root,
    });

    await controller.open();

    const opts = (createInviteManager as Mock).mock.calls[0]![0] as {
      onClose: () => void;
    };

    opts.onClose();
    expect(mockInviteManagerDestroy).toHaveBeenCalled();

    // Should be able to re-open
    vi.clearAllMocks();
    await controller.open();
    expect(createInviteManager).toHaveBeenCalledOnce();
  });

  it("onError logs and shows toast", async () => {
    const api = makeMockApi();

    const controller = createInviteManagerController({
      api: api as never,
      getRoot: () => root,
    });

    await controller.open();

    const opts = (createInviteManager as Mock).mock.calls[0]![0] as {
      onError: (message: string) => void;
    };

    opts.onError("Something went wrong");
    expect(mockLogError).toHaveBeenCalledWith("Something went wrong");
    expect(mockShowToast).toHaveBeenCalledWith("Something went wrong", "error");
  });

  it("re-checks getRoot after the getInvites() await and does not mount on a torn-down page", async () => {
    // Root is live when open() starts but the page tears down (MainPage.destroy
    // nulls its root) while getInvites() is still in flight. open() must not
    // resurrect the overlay on the stale, detached root it captured before the
    // await — that leaves a document-level keydown listener with no teardown
    // path (OC-0055).
    const api = makeMockApi();
    let calls = 0;
    const getRoot = vi.fn(() => {
      calls++;
      return calls === 1 ? root : null;
    });

    const controller = createInviteManagerController({
      api: api as never,
      getRoot,
    });

    await controller.open();

    expect(createInviteManager).not.toHaveBeenCalled();
    expect(mockInviteManagerMount).not.toHaveBeenCalled();
  });

  it("onRevokeInvite passes invite code directly to API", async () => {
    const api = makeMockApi();

    const controller = createInviteManagerController({
      api: api as never,
      getRoot: () => root,
    });

    await controller.open();

    const opts = (createInviteManager as Mock).mock.calls[0]![0] as {
      onRevokeInvite: (code: string) => Promise<void>;
    };

    await expect(opts.onRevokeInvite("abc123xyz")).resolves.toBeUndefined();
    expect(api.revokeInvite).toHaveBeenCalledWith("abc123xyz");
  });
});

// ---------------------------------------------------------------------------
// createSearchOverlayController
// ---------------------------------------------------------------------------

describe("createSearchOverlayController", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
    vi.clearAllMocks();
  });

  afterEach(() => {
    root.remove();
  });

  it("opens search overlay and mounts to root", async () => {
    const api = makeMockApi();

    const controller = createSearchOverlayController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 5,
    });

    controller.open();
    await vi.dynamicImportSettled();

    expect(createSearchOverlay).toHaveBeenCalledOnce();
    expect(mockSearchOverlayMount).toHaveBeenCalledWith(root);
  });

  it("offers only a server-wide search behind an NSFW consent gate", async () => {
    const controller = createSearchOverlayController({
      api: makeMockApi() as never,
      getRoot: () => root,
      getCurrentChannelId: () => 99,
    });

    controller.open();
    await vi.dynamicImportSettled();

    expect(vi.mocked(createSearchOverlay).mock.calls[0]![0].currentChannelId).toBeUndefined();
  });

  it("does nothing when root is null", async () => {
    const api = makeMockApi();

    const controller = createSearchOverlayController({
      api: api as never,
      getRoot: () => null,
      getCurrentChannelId: () => 5,
    });

    controller.open();
    await vi.dynamicImportSettled();

    expect(createSearchOverlay).not.toHaveBeenCalled();
  });

  it("does not open a second instance if already open", async () => {
    const api = makeMockApi();

    const controller = createSearchOverlayController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 5,
    });

    controller.open();
    await vi.dynamicImportSettled();
    controller.open();
    await vi.dynamicImportSettled();

    expect(createSearchOverlay).toHaveBeenCalledOnce();
  });

  it("passes currentChannelId as undefined when null", async () => {
    const api = makeMockApi();

    const controller = createSearchOverlayController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => null,
    });

    controller.open();
    await vi.dynamicImportSettled();

    const opts = (createSearchOverlay as Mock).mock.calls[0]![0] as {
      currentChannelId: number | undefined;
    };

    expect(opts.currentChannelId).toBeUndefined();
  });

  it("onSearch calls api.search newest-first and passes the page cursor through", async () => {
    const api = makeMockApi();

    const controller = createSearchOverlayController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 5,
    });

    controller.open();
    await vi.dynamicImportSettled();

    const opts = (createSearchOverlay as Mock).mock.calls[0]![0] as {
      onSearch: (
        query: string,
        chId: number | undefined,
        signal?: AbortSignal,
        before?: number,
      ) => Promise<{ results: unknown[] }>;
    };

    const resp = await opts.onSearch("hello", 5, undefined, 42);
    expect(api.search).toHaveBeenCalledWith(
      "hello",
      { channelId: 5, sort: "recent", before: 42 },
      undefined,
    );
    expect(resp.results).toEqual([{ channel_id: 1, message_id: 10, content: "hello" }]);
  });

  it("onSearch re-throws AbortError", async () => {
    const abortError = new DOMException("Aborted", "AbortError");
    const api = makeMockApi({
      search: vi.fn().mockRejectedValue(abortError),
    });

    const controller = createSearchOverlayController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 5,
    });

    controller.open();
    await vi.dynamicImportSettled();

    const opts = (createSearchOverlay as Mock).mock.calls[0]![0] as {
      onSearch: (
        query: string,
        chId: number | undefined,
        signal?: AbortSignal,
      ) => Promise<unknown[]>;
    };

    await expect(opts.onSearch("test", 5)).rejects.toThrow("Aborted");
    // Should NOT show toast for abort errors
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it("onSearch shows toast and re-throws on non-abort error", async () => {
    const api = makeMockApi({
      search: vi.fn().mockRejectedValue(new Error("network failure")),
    });

    const controller = createSearchOverlayController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 5,
    });

    controller.open();
    await vi.dynamicImportSettled();

    const opts = (createSearchOverlay as Mock).mock.calls[0]![0] as {
      onSearch: (
        query: string,
        chId: number | undefined,
        signal?: AbortSignal,
      ) => Promise<unknown[]>;
    };

    await expect(opts.onSearch("test", 5)).rejects.toThrow("network failure");
    expect(mockShowToast).toHaveBeenCalledWith("Search failed", "error");
    expect(mockLogError).toHaveBeenCalled();
  });

  it("onSelectResult hands the whole jump to onJumpToMessage", async () => {
    const api = makeMockApi();
    const mockJump = vi.fn();

    const controller = createSearchOverlayController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 5,
      onJumpToMessage: mockJump,
    });

    controller.open();
    await vi.dynamicImportSettled();

    const opts = (createSearchOverlay as Mock).mock.calls[0]![0] as {
      onSelectResult: (result: { channel_id: number; message_id: number }) => void;
    };

    opts.onSelectResult({ channel_id: 3, message_id: 42 });

    expect(mockJump).toHaveBeenCalledWith(3, 42);
    // The jumper owns the channel switch too, so the around-window fetch it
    // may need is sequenced after the switch instead of racing it.
    expect(mockSetActiveChannel).not.toHaveBeenCalled();
  });

  it("onSelectResult does not second-guess the jumper with a toast", async () => {
    const api = makeMockApi();
    const mockJump = vi.fn();

    const controller = createSearchOverlayController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 5,
      onJumpToMessage: mockJump,
    });

    controller.open();
    await vi.dynamicImportSettled();

    const opts = (createSearchOverlay as Mock).mock.calls[0]![0] as {
      onSelectResult: (result: { channel_id: number; message_id: number }) => void;
    };

    opts.onSelectResult({ channel_id: 3, message_id: 999 });

    // A hit outside the loaded page is now a fetch, not a dead end.
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it("onSelectResult works without onJumpToMessage callback", async () => {
    const api = makeMockApi();

    const controller = createSearchOverlayController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 5,
      // no onJumpToMessage
    });

    controller.open();
    await vi.dynamicImportSettled();

    const opts = (createSearchOverlay as Mock).mock.calls[0]![0] as {
      onSelectResult: (result: { channel_id: number; message_id: number }) => void;
    };

    // Should not throw
    opts.onSelectResult({ channel_id: 3, message_id: 42 });
    expect(mockSetActiveChannel).toHaveBeenCalledWith(3);
  });

  it("onClose closes overlay and allows re-open", async () => {
    const api = makeMockApi();

    const controller = createSearchOverlayController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 5,
    });

    controller.open();
    await vi.dynamicImportSettled();

    const opts = (createSearchOverlay as Mock).mock.calls[0]![0] as {
      onClose: () => void;
    };

    opts.onClose();
    expect(mockSearchOverlayDestroy).toHaveBeenCalled();

    // Re-open should work
    vi.clearAllMocks();
    controller.open();
    await vi.dynamicImportSettled();
    expect(createSearchOverlay).toHaveBeenCalledOnce();
  });

  it("cleanup destroys instance when open", async () => {
    const api = makeMockApi();

    const controller = createSearchOverlayController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 5,
    });

    controller.open();
    await vi.dynamicImportSettled();
    controller.cleanup();

    expect(mockSearchOverlayDestroy).toHaveBeenCalled();
  });

  it("cleanup is safe when not open", () => {
    const api = makeMockApi();

    const controller = createSearchOverlayController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => 5,
    });

    // Should not throw
    controller.cleanup();
    expect(mockSearchOverlayDestroy).not.toHaveBeenCalled();
  });
});
