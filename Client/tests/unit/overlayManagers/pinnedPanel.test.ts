import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/overlayManagersMocks";
import { setMembers } from "@stores/members.store";
import { createPinnedMessages } from "@components/PinnedMessages";
import { channelsStore } from "@stores/channels.store";
import { messagesStore } from "@stores/messages.store";
import { membersStore } from "@stores/members.store";
import { uiStore, setConnectionStatus } from "@stores/ui.store";
import { mapToPinnedMessage } from "@pages/main-page/OverlayManagers";
import {
  createPinnedPanelController,
  firstCallOpts,
  type JumpToMessageOpts,
  makeMockApi,
  openPinnedControllers,
  type UnpinOpts,
} from "../../helpers/overlayManagersHarness";

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
  mockPinnedMessagesMount,
  mockPinnedMessagesDestroy,
  mockPinnedSetPins,
  mockPinnedRemovePin,
  mockPinnedSetOnUnpin,
  mockShowToast,
  mockSetMessagePinned,
} = mocks;

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

  function newPinned(
    api: ReturnType<typeof makeMockApi>,
    channelId: number,
  ): ReturnType<typeof createPinnedPanelController> {
    return createPinnedPanelController({
      api: api as never,
      getRoot: () => root,
      getCurrentChannelId: () => channelId,
    });
  }

  it("toggles pinned panel open and mounts to root", async () => {
    const api = makeMockApi();

    const controller = newPinned(api, 42);

    await controller.toggle();

    expect(createPinnedMessages).toHaveBeenCalledOnce();
    expect(mockPinnedMessagesMount).toHaveBeenCalledWith(root);
  });

  it("open() opens a closed panel and never closes or rebuilds an open one", async () => {
    const api = makeMockApi();
    const controller = newPinned(api, 42);

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
    const controller = newPinned(api, 42);
    await Promise.all([controller.open(), controller.open()]);
    expect(api.getPins).toHaveBeenCalledOnce();
    expect(createPinnedMessages).toHaveBeenCalledOnce();
  });

  it("does not open, fetch or toast behind an NSFW consent gate", async () => {
    const api = makeMockApi();
    const controller = newPinned(api, 99);

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

    const opts = firstCallOpts<{
      onUnpin?: (msgId: number) => void;
    }>(createPinnedMessages);
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
    const opts = firstCallOpts<UnpinOpts>(createPinnedMessages);

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

    const opts = firstCallOpts<UnpinOpts>(createPinnedMessages);

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

    const opts = firstCallOpts<JumpToMessageOpts>(createPinnedMessages);

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

    const opts = firstCallOpts<JumpToMessageOpts>(createPinnedMessages);

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

    const controller = newPinned(api, 42);

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

    const controller = newPinned(api, 42);

    await controller.toggle();
    expect(mockPinnedMessagesMount).toHaveBeenCalledOnce();

    // Toggle again should close
    await controller.toggle();
    expect(mockPinnedMessagesDestroy).toHaveBeenCalled();
  });

  it("cleanup closes panel if open", async () => {
    const api = makeMockApi();

    const controller = newPinned(api, 42);

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

    const controller = newPinned(api, 42);

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

    const controller = newPinned(api, 42);

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

    const controller = newPinned(api, 42);

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

    const opts = firstCallOpts<JumpToMessageOpts>(createPinnedMessages);

    opts.onJumpToMessage(1);

    // Without a callback, should just close the panel
    expect(mockPinnedMessagesDestroy).toHaveBeenCalled();
  });
});

describe("pinned panel closes on a press outside it", () => {
  let root: HTMLDivElement;
  let pinsBtn: HTMLButtonElement;
  let outsideEl: HTMLDivElement;

  const press = (el: Element): void => {
    el.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    root = document.createElement("div");
    pinsBtn = document.createElement("button");
    pinsBtn.className = "pin-btn pins-btn";
    outsideEl = document.createElement("div");
    root.append(pinsBtn, outsideEl);
    document.body.appendChild(root);
    mockPinnedMessagesMount.mockImplementationOnce((container: Element) => {
      const panel = document.createElement("div");
      panel.className = "pinned-panel";
      panel.appendChild(document.createElement("button"));
      container.appendChild(panel);
    });
  });

  afterEach(() => {
    for (const c of openPinnedControllers.splice(0)) c.cleanup();
    root.remove();
  });

  async function openPanel(): Promise<ReturnType<typeof createPinnedPanelController>> {
    const controller = createPinnedPanelController({
      api: makeMockApi() as never,
      getRoot: () => root,
      getCurrentChannelId: () => 42,
    });
    await controller.toggle();
    expect(mockPinnedMessagesMount).toHaveBeenCalledOnce();
    return controller;
  }

  it("closes on a press on the page behind it", async () => {
    await openPanel();
    press(outsideEl);
    expect(mockPinnedMessagesDestroy).toHaveBeenCalledOnce();
  });

  it("stays open on a press inside it", async () => {
    await openPanel();
    press(root.querySelector(".pinned-panel button")!);
    expect(mockPinnedMessagesDestroy).not.toHaveBeenCalled();
  });

  it("leaves its own header button to toggle it, so the click closes it once", async () => {
    const controller = await openPanel();
    press(pinsBtn);
    expect(mockPinnedMessagesDestroy).not.toHaveBeenCalled();
    await controller.toggle();
    expect(mockPinnedMessagesDestroy).toHaveBeenCalledOnce();
    expect(createPinnedMessages).toHaveBeenCalledOnce();
  });

  it("stays open on a press in a dialog, menu, toast or image viewer over the page", async () => {
    await openPanel();
    for (const cls of ["modal-overlay", "context-menu", "toast-container", "image-lightbox"]) {
      const layer = document.createElement("div");
      layer.className = cls;
      const inner = document.createElement("span");
      layer.appendChild(inner);
      document.body.appendChild(layer);
      press(inner);
      layer.remove();
    }
    expect(mockPinnedMessagesDestroy).not.toHaveBeenCalled();
  });

  it("stops listening once closed", async () => {
    const controller = await openPanel();
    controller.cleanup();
    expect(mockPinnedMessagesDestroy).toHaveBeenCalledOnce();
    press(outsideEl);
    expect(mockPinnedMessagesDestroy).toHaveBeenCalledOnce();
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
