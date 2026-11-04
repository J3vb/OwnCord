import { describe, it, expect, vi, beforeEach } from "vitest";
import * as mocks from "../../helpers/overlayManagersMocks";
import { createInviteManager } from "@components/InviteManager";
import { mapInviteResponse, createInviteManagerController } from "@pages/main-page/OverlayManagers";
import {
  type CopyLinkOpts,
  type FeaturedCodeOpts,
  firstCallOpts,
  type InviteListOpts,
  makeInviteResponse,
  makeMockApi,
  type RevokeInviteOpts,
} from "../../helpers/overlayManagersHarness";
import { useMountContainer } from "../../helpers/mountContainer";

vi.mock("@lib/logger", () => mocks.loggerMock());
vi.mock("@components/QuickSwitcher", () => mocks.quickSwitcherMock());
vi.mock("@components/InviteManager", () => mocks.inviteManagerMock());
vi.mock("@components/PinnedMessages", () => mocks.pinnedMessagesMock());
vi.mock("@components/SearchOverlay", () => mocks.searchOverlayMock());
vi.mock("@stores/channels.store", () => mocks.channelsStoreMock());
vi.mock("@stores/messages.store", () => mocks.messagesStoreMock());
vi.mock("@stores/auth.store", () => mocks.authStoreMock());
vi.mock("@lib/permissions", () => mocks.permissionsMock());
vi.mock("@lib/ui/toast", () => mocks.uiToastMock());

const {
  mockLogError,
  mockInviteManagerMount,
  mockInviteManagerDestroy,
  mockShowToast,
  mockCanManageInvites,
} = mocks;

let root: HTMLDivElement;
useMountContainer((container) => {
  root = container;
});

beforeEach(() => {
  vi.clearAllMocks();
});

async function openInvites(
  api: ReturnType<typeof makeMockApi> = makeMockApi(),
): Promise<ReturnType<typeof createInviteManagerController>> {
  const controller = createInviteManagerController({ api: api as never, getRoot: () => root });
  await controller.open();
  return controller;
}

/** A controller whose getInvites stays pending until `resolveInvites` is called. */
function controllerWithPendingInvites() {
  let resolveInvites: (value: unknown[]) => void = () => {};
  const pending = new Promise<unknown[]>((resolve) => {
    resolveInvites = resolve;
  });
  const api = makeMockApi({ getInvites: vi.fn().mockReturnValue(pending) });
  const controller = createInviteManagerController({ api: api as never, getRoot: () => root });
  return { api, controller, resolveInvites };
}

/** Opens the manager over `invites` and returns the codes it was handed. */
async function shownInviteCodes(invites: unknown[]): Promise<string[]> {
  await openInvites(makeMockApi({ getInvites: vi.fn().mockResolvedValue(invites) }));
  return firstCallOpts<InviteListOpts>(createInviteManager).invites.map((i) => i.code);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createInviteManagerController", () => {
  it("opens invite manager and mounts to root", async () => {
    const api = makeMockApi();

    await openInvites(api);

    expect(createInviteManager).toHaveBeenCalledOnce();
    expect(mockInviteManagerMount).toHaveBeenCalledWith(root);
  });

  it("filters out revoked invites before handing the list to InviteManager", async () => {
    // Redemption enforces `revoked = 0` server-side (UseInviteAtomic), so a
    // revoked invite rendered like a live one hands out a code that always
    // fails. The list endpoint deliberately still includes revoked invites
    // (for admin visibility elsewhere), so the client must filter here.
    const codes = await shownInviteCodes([
      makeInviteResponse({ code: "live1", max_uses: null, creator_username: "me" }),
      makeInviteResponse({ code: "dead1", revoked: true }),
    ]);

    expect(codes).toEqual(["live1"]);
  });

  it("filters out expired invites so Copy cannot hand out a dead code (F4)", async () => {
    const codes = await shownInviteCodes([
      makeInviteResponse({
        code: "live1",
        max_uses: null,
        creator_username: "me",
        expires_at: "2099-01-01T00:00:00Z",
      }),
      makeInviteResponse({ code: "expired1", expires_at: "2000-01-01T00:00:00Z" }),
    ]);

    expect(codes).toEqual(["live1"]);
  });

  it("onRevokeInvite catches API error and re-throws for component handling", async () => {
    const api = makeMockApi({
      revokeInvite: vi.fn().mockRejectedValue(new Error("network error")),
    });

    await openInvites(api);

    // Extract the onRevokeInvite callback passed to InviteManager
    const opts = firstCallOpts<RevokeInviteOpts>(createInviteManager);

    // The callback should re-throw so InviteManager's catch prevents optimistic removal
    await expect(opts.onRevokeInvite("abc123xyz")).rejects.toThrow("network error");

    // Controller should log the error with context
    expect(mockLogError).toHaveBeenCalled();
  });

  it("onRevokeInvite succeeds normally when API works", async () => {
    const api = makeMockApi();

    await openInvites(api);

    const opts = firstCallOpts<RevokeInviteOpts>(createInviteManager);

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
    const opts = firstCallOpts<{
      invites: Array<{ code: string }>;
      featuredCode: string;
    }>(createInviteManager);
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
    const opts = firstCallOpts<FeaturedCodeOpts>(createInviteManager);
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
    const opts = firstCallOpts<FeaturedCodeOpts>(createInviteManager);
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
    const opts = firstCallOpts<{
      invites: Array<{ code: string }>;
      featuredCode: string | null;
    }>(createInviteManager);
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

    const controller = await openInvites(api);

    expect(mockShowToast).not.toHaveBeenCalled();
    expect(root.textContent).toContain("Failed to load invites");
    controller.cleanup();
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
// createInviteManagerController (additional coverage)
// ---------------------------------------------------------------------------

describe("createInviteManagerController (additional)", () => {
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

    const controller = await openInvites(api);
    await controller.open();

    expect(createInviteManager).toHaveBeenCalledOnce();
  });

  it("does not mount a second overlay from a double-click while getInvites is in flight", async () => {
    // `instance` is only assigned after the await, so a synchronous
    // `instance !== null` guard alone lets a second call in while the first
    // is still fetching — this is the concurrent case the sequential test
    // above does not exercise.
    const { api, controller, resolveInvites } = controllerWithPendingInvites();

    const first = controller.open();
    const second = controller.open(); // fires while getInvites is still pending

    resolveInvites([makeInviteResponse()]);
    await Promise.all([first, second]);

    expect(createInviteManager).toHaveBeenCalledOnce();
    expect(api.getInvites).toHaveBeenCalledOnce();
  });

  it("a cleanup while getInvites is in flight leaves the manager unmounted", async () => {
    const { controller, resolveInvites } = controllerWithPendingInvites();

    const opening = controller.open();
    controller.cleanup();
    resolveInvites([makeInviteResponse()]);
    await opening;

    expect(createInviteManager).not.toHaveBeenCalled();
  });

  it("cleanup destroys instance when open", async () => {
    const api = makeMockApi();

    const controller = await openInvites(api);
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

    await openInvites(api);

    const opts = firstCallOpts<{
      onCreateInvite: (p: { expiresInHours: number; maxUses: number }) => Promise<unknown>;
    }>(createInviteManager);

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

    await openInvites(api);

    const opts = firstCallOpts<CopyLinkOpts>(createInviteManager);

    opts.onCopyLink("test-code");
    expect(mockWriteText).toHaveBeenCalledWith("owncord://invite/test-code?host=chat.example.com");
  });

  describe("onCopyLink builds a shareable owncord:// link", () => {
    async function openAndGetCopy(host: string | undefined) {
      const api = makeMockApi({ getConfig: vi.fn().mockReturnValue({ host }) });
      await openInvites(api);
      const opts = firstCallOpts<CopyLinkOpts>(createInviteManager);
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

    const controller = await openInvites(api);

    const opts = firstCallOpts<{
      onClose: () => void;
    }>(createInviteManager);

    opts.onClose();
    expect(mockInviteManagerDestroy).toHaveBeenCalled();

    // Should be able to re-open
    vi.clearAllMocks();
    await controller.open();
    expect(createInviteManager).toHaveBeenCalledOnce();
  });

  it("onError logs and shows toast", async () => {
    const api = makeMockApi();

    await openInvites(api);

    const opts = firstCallOpts<{
      onError: (message: string) => void;
    }>(createInviteManager);

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

    await openInvites(api);

    const opts = firstCallOpts<RevokeInviteOpts>(createInviteManager);

    await expect(opts.onRevokeInvite("abc123xyz")).resolves.toBeUndefined();
    expect(api.revokeInvite).toHaveBeenCalledWith("abc123xyz");
  });
});
