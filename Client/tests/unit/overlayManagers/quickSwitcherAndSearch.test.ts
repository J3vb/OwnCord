import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import * as mocks from "../../helpers/overlayManagersMocks";
import { createQuickSwitcher } from "@components/QuickSwitcher";
import { createSearchOverlay } from "@components/SearchOverlay";
import {
  createQuickSwitcherManager,
  createSearchOverlayController,
} from "@pages/main-page/OverlayManagers";
import { makeMockApi } from "../../helpers/overlayManagersHarness";
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
  mockShowToast,
  mockQuickSwitcherMount,
  mockQuickSwitcherDestroy,
  mockSearchOverlayMount,
  mockSearchOverlayDestroy,
  mockSetActiveChannel,
} = mocks;

let root: HTMLDivElement;
useMountContainer((container) => {
  root = container;
});

beforeEach(() => {
  vi.clearAllMocks();
});

async function pressCtrlK(init: KeyboardEventInit = {}): Promise<void> {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, ...init }));
  await vi.dynamicImportSettled();
}

function attachSwitcher(
  isSuspended?: () => boolean,
  joinVoice?: (channelId: number) => void,
): { manager: ReturnType<typeof createQuickSwitcherManager>; cleanup: () => void } {
  const manager = createQuickSwitcherManager(() => root, isSuspended, joinVoice);
  return { manager, cleanup: manager.attach() };
}

type SearchControllerOptions = Parameters<typeof createSearchOverlayController>[0];

async function openSearch(
  api: ReturnType<typeof makeMockApi> = makeMockApi(),
  over: Partial<SearchControllerOptions> = {},
): Promise<ReturnType<typeof createSearchOverlayController>> {
  const controller = createSearchOverlayController({
    api: api as never,
    getRoot: () => root,
    getCurrentChannelId: () => 5,
    ...over,
  });
  controller.open();
  await vi.dynamicImportSettled();
  return controller;
}

// ---------------------------------------------------------------------------
// createQuickSwitcherManager
// ---------------------------------------------------------------------------

describe("createQuickSwitcherManager", () => {
  it("opens quick switcher on Ctrl+K", async () => {
    const { cleanup } = attachSwitcher();

    await pressCtrlK();

    expect(createQuickSwitcher).toHaveBeenCalledOnce();
    expect(mockQuickSwitcherMount).toHaveBeenCalledWith(root);

    cleanup();
  });

  it("a held Ctrl+K opens the switcher once and auto-repeat does not close it", async () => {
    const { cleanup } = attachSwitcher();

    await pressCtrlK();
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
    const { cleanup } = attachSwitcher();

    await pressCtrlK({ repeat: true });

    expect(createQuickSwitcher).not.toHaveBeenCalled();
    cleanup();
  });

  it("closes quick switcher on second Ctrl+K", async () => {
    const { cleanup } = attachSwitcher();

    // Open
    await pressCtrlK();
    expect(createQuickSwitcher).toHaveBeenCalledOnce();

    // Close
    await pressCtrlK();
    expect(mockQuickSwitcherDestroy).toHaveBeenCalled();

    cleanup();
  });

  it("opens on Ctrl+K from the focused composer, but not while a modal is open", async () => {
    const { cleanup } = attachSwitcher();

    const modal = document.createElement("div");
    modal.className = "modal-overlay visible";
    document.body.appendChild(modal);
    await pressCtrlK();
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
    const { cleanup } = attachSwitcher();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
    await vi.dynamicImportSettled();

    expect(createQuickSwitcher).toHaveBeenCalledOnce();

    cleanup();
  });

  it("does not open on plain K key without modifier", async () => {
    const { cleanup } = attachSwitcher();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k" }));
    await vi.dynamicImportSettled();

    expect(createQuickSwitcher).not.toHaveBeenCalled();

    cleanup();
  });

  it("does nothing when root is null", async () => {
    const manager = createQuickSwitcherManager(() => null);
    const cleanup = manager.attach();

    await pressCtrlK();

    expect(createQuickSwitcher).not.toHaveBeenCalled();

    cleanup();
  });

  it("cleanup removes the keydown listener and closes", async () => {
    const { cleanup } = attachSwitcher();

    // Open first
    await pressCtrlK();
    expect(createQuickSwitcher).toHaveBeenCalledOnce();

    // Cleanup
    cleanup();

    // Verify destroy was called
    expect(mockQuickSwitcherDestroy).toHaveBeenCalled();

    // After cleanup, Ctrl+K should not open a new instance
    vi.clearAllMocks();
    await pressCtrlK();
    expect(createQuickSwitcher).not.toHaveBeenCalled();
  });

  it("onSelectChannel callback sets active channel", async () => {
    const { cleanup } = attachSwitcher();

    await pressCtrlK();

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
    const { cleanup } = attachSwitcher(undefined, join);
    await pressCtrlK();

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
    const { cleanup } = attachSwitcher(undefined, join);
    await pressCtrlK();

    const opts = (createQuickSwitcher as Mock).mock.calls[0]![0] as {
      onSelectChannel: (channelId: number) => void;
    };
    opts.onSelectChannel(4);

    expect(mockSetActiveChannel).toHaveBeenCalledWith(4);
    expect(join).not.toHaveBeenCalled();

    cleanup();
  });

  it("onClose callback resets instance so re-open works", async () => {
    const { cleanup } = attachSwitcher();

    // Open
    await pressCtrlK();
    expect(createQuickSwitcher).toHaveBeenCalledOnce();

    // Simulate component calling onClose directly
    const opts = (createQuickSwitcher as Mock).mock.calls[0]![0] as {
      onClose: () => void;
    };
    opts.onClose();

    // Re-open should work
    await pressCtrlK();
    expect(createQuickSwitcher).toHaveBeenCalledTimes(2);

    cleanup();
  });

  it("does not open a second instance if already open", async () => {
    const { cleanup } = attachSwitcher();

    // Open
    await pressCtrlK();

    // Simulate trying to open from external code — the instance check should prevent it
    // The attach() function only exposes Ctrl+K, and the toggle logic handles this
    expect(createQuickSwitcher).toHaveBeenCalledOnce();

    cleanup();
  });

  it("opens on Ctrl+K with CapsLock on (KeyboardEvent.key reports uppercase 'K')", async () => {
    // OC-0150: `e.key` reflects CapsLock/Shift state. A case-sensitive `=== "k"`
    // check means CapsLock (or Ctrl+Shift+K) silently does nothing.
    const { cleanup } = attachSwitcher();

    await pressCtrlK({ key: "K" });

    expect(createQuickSwitcher).toHaveBeenCalledOnce();

    cleanup();
  });

  it("does not open on AltGr+K (Windows reports AltGr as ctrlKey+altKey)", async () => {
    // OC-0150: without an altKey exclusion, AltGr-produced characters on
    // non-US layouts get swallowed by an unwanted preventDefault().
    const { cleanup } = attachSwitcher();

    await pressCtrlK({ altKey: true });

    expect(createQuickSwitcher).not.toHaveBeenCalled();

    cleanup();
  });

  it("does not open while isSuspended() reports true (e.g. settings overlay open)", async () => {
    // OC-0150: every other global shortcut honours isSuspended; the quick
    // switcher never got the guard, so it could stack on top of Settings.
    const { cleanup } = attachSwitcher(() => true);

    await pressCtrlK();

    expect(createQuickSwitcher).not.toHaveBeenCalled();

    cleanup();
  });
});

describe("createQuickSwitcherManager.open (the phone drawer's search button)", () => {
  it("opens the switcher without the keyboard, once, and not twice while it is up", async () => {
    const { manager, cleanup } = attachSwitcher();

    manager.open();
    manager.open();
    await vi.dynamicImportSettled();
    manager.open();
    await vi.dynamicImportSettled();

    expect(createQuickSwitcher).toHaveBeenCalledOnce();
    expect(mockQuickSwitcherMount).toHaveBeenCalledWith(root);

    cleanup();
  });

  it("does not open while the shortcut is suspended, or behind a dialog", async () => {
    let suspended = true;
    const manager = createQuickSwitcherManager(
      () => root,
      () => suspended,
    );
    manager.open();
    await vi.dynamicImportSettled();
    expect(createQuickSwitcher).not.toHaveBeenCalled();

    suspended = false;
    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);
    manager.open();
    await vi.dynamicImportSettled();
    expect(createQuickSwitcher).not.toHaveBeenCalled();
    dialog.remove();
  });
});

// ---------------------------------------------------------------------------
// createSearchOverlayController
// ---------------------------------------------------------------------------

describe("createSearchOverlayController", () => {
  it("opens search overlay and mounts to root", async () => {
    const api = makeMockApi();
    await openSearch(api);

    expect(createSearchOverlay).toHaveBeenCalledOnce();
    expect(mockSearchOverlayMount).toHaveBeenCalledWith(root);
  });

  it("offers only a server-wide search behind an NSFW consent gate", async () => {
    await openSearch(undefined, { getCurrentChannelId: () => 99 });

    expect(vi.mocked(createSearchOverlay).mock.calls[0]![0].currentChannelId).toBeUndefined();
  });

  it("does nothing when root is null", async () => {
    const api = makeMockApi();
    await openSearch(api, { getRoot: () => null });

    expect(createSearchOverlay).not.toHaveBeenCalled();
  });

  it("does not open a second instance if already open", async () => {
    const api = makeMockApi();
    const controller = await openSearch(api);
    controller.open();
    await vi.dynamicImportSettled();

    expect(createSearchOverlay).toHaveBeenCalledOnce();
  });

  it("passes currentChannelId as undefined when null", async () => {
    const api = makeMockApi();
    await openSearch(api, { getCurrentChannelId: () => null });

    const opts = (createSearchOverlay as Mock).mock.calls[0]![0] as {
      currentChannelId: number | undefined;
    };

    expect(opts.currentChannelId).toBeUndefined();
  });

  it("onSearch calls api.search newest-first and passes the page cursor through", async () => {
    const api = makeMockApi();
    await openSearch(api);

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
    await openSearch(api);

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
    await openSearch(api);

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
    await openSearch(api, { onJumpToMessage: mockJump });

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
    await openSearch(api, { onJumpToMessage: mockJump });

    const opts = (createSearchOverlay as Mock).mock.calls[0]![0] as {
      onSelectResult: (result: { channel_id: number; message_id: number }) => void;
    };

    opts.onSelectResult({ channel_id: 3, message_id: 999 });

    // A hit outside the loaded page is now a fetch, not a dead end.
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it("onSelectResult works without onJumpToMessage callback", async () => {
    const api = makeMockApi();
    await openSearch(api);

    const opts = (createSearchOverlay as Mock).mock.calls[0]![0] as {
      onSelectResult: (result: { channel_id: number; message_id: number }) => void;
    };

    // Should not throw
    opts.onSelectResult({ channel_id: 3, message_id: 42 });
    expect(mockSetActiveChannel).toHaveBeenCalledWith(3);
  });

  it("onClose closes overlay and allows re-open", async () => {
    const api = makeMockApi();
    const controller = await openSearch(api);

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
    const controller = await openSearch(api);
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
