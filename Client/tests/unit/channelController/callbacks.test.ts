import { describe, it, expect, vi } from "vitest";
import { fakeTimersTest } from "../../helpers/fakeTimersTest";
import * as mocks from "../../helpers/channelControllerMocks";
import { createChannelController } from "../../../src/pages/main-page/ChannelController";
import {
  activatePendingMessages,
  newClientMessageId,
  PENDING_MESSAGE_MAX_COUNT,
  savePendingText,
} from "@lib/pendingMessages";
import type { ChannelControllerOptions } from "../../../src/pages/main-page/ChannelController";
import { setConnectionStatus } from "@stores/ui.store";
import { setActiveTimeout } from "../../../src/features/safety/store";
import {
  capturedMessageListOpts,
  capturedMessageInputOpts,
} from "../../helpers/channelControllerMocks";
import {
  installSendIds,
  makeOpts,
  sentFrames,
  mountController,
  mountControllerWithSendIds,
  useChannelControllerHarness,
} from "../../helpers/channelControllerHarness";

vi.mock("@lib/logger", () => mocks.loggerMock());
vi.mock("@lib/dom", () => mocks.domMock());
vi.mock("@components/MessageList", () => mocks.messageListMock());
vi.mock("@components/MessageInput", () => mocks.messageInputMock());
vi.mock("@components/NsfwGate", () => mocks.nsfwGateMock());
vi.mock("@components/TypingIndicator", () => mocks.typingIndicatorMock());
vi.mock("@lib/readState", () => mocks.readStateMock());
vi.mock("@stores/messages.store", () => mocks.messagesStoreMock());
vi.mock("@lib/nav/messageNavigation", () => mocks.navMessageNavigationMock());
vi.mock("@stores/auth.store", () => mocks.authStoreMock());
vi.mock("../../../src/pages/main-page/ChatHeader", (importOriginal) =>
  mocks.pageChatHeaderMock(importOriginal),
);
vi.mock("@stores/dm.store", () => mocks.dmStoreMock());
vi.mock("../../../src/features/messaging/content/attachments", (importOriginal) =>
  mocks.listAttachmentsMock(importOriginal),
);
vi.mock("@stores/members.store", () => mocks.membersStoreMock());
vi.mock("@stores/blocks.store", () => mocks.blocksStoreMock());
vi.mock("../../../src/pages/main-page/ThreadPanelHost", () => mocks.pageThreadPanelHostMock());

const {
  mockGetChannelMessages,
  mockSetReplyTo,
  mockStartEdit,
  mockInputFocus,
  mockSetDisabled,
  mockSetMessagePinned,
  mockAddOptimistic,
  mockMarkSendFailed,
  mockRemoveOptimistic,
  mockMarkChannelRead,
  mockPinRevisions,
  mockReattachToPresent,
  mockJumpToMessage,
  mockIsWindowDetached,
} = mocks;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createChannelController", () => {
  useChannelControllerHarness();

  describe("MessageList callbacks (delete confirmation dialog)", () => {
    function mountBobsMessage(): ReturnType<typeof mountController> {
      mockGetChannelMessages.mockReturnValue([
        { id: 5, content: "bye", user: { id: 2, username: "Bob" } },
      ]);
      return mountController();
    }
    function deleteModal(): HTMLElement | null {
      return document.querySelector("[data-testid='msg-delete-modal']");
    }
    function confirmBtn(): HTMLButtonElement {
      return document.querySelector("[data-testid='msg-delete-confirm']") as HTMLButtonElement;
    }
    function cancelBtn(): HTMLButtonElement {
      return document.querySelector("[data-testid='msg-delete-cancel']") as HTMLButtonElement;
    }

    it("opens a dialog and sends nothing on the first click", () => {
      const { opts, ctrl } = mountBobsMessage();

      capturedMessageListOpts!.onDeleteClick(5, false);

      expect(deleteModal()).not.toBeNull();
      expect(sentFrames(opts, "chat_delete")).toHaveLength(0);
      ctrl.destroyChannel();
    });

    it("sends exactly one chat_delete when the dialog is confirmed", () => {
      const { opts, ctrl } = mountBobsMessage();

      capturedMessageListOpts!.onDeleteClick(5, false);
      confirmBtn().click();

      const sends = sentFrames(opts, "chat_delete");
      expect(sends).toHaveLength(1);
      expect(sends[0]![0]).toEqual({ type: "chat_delete", payload: { message_id: 5 } });
      expect(deleteModal()).toBeNull();
      ctrl.destroyChannel();
    });

    it("cancelling the dialog sends nothing and closes it", () => {
      const { opts, ctrl } = mountBobsMessage();

      capturedMessageListOpts!.onDeleteClick(5, false);
      cancelBtn().click();

      expect(deleteModal()).toBeNull();
      expect(sentFrames(opts, "chat_delete")).toHaveLength(0);
      ctrl.destroyChannel();
    });

    it("Escape cancels the dialog without deleting", () => {
      const { opts, ctrl } = mountBobsMessage();

      capturedMessageListOpts!.onDeleteClick(5, false);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

      expect(deleteModal()).toBeNull();
      expect(sentFrames(opts, "chat_delete")).toHaveLength(0);
      ctrl.destroyChannel();
    });

    it("Shift-click deletes immediately with no dialog", () => {
      const { opts, ctrl } = mountBobsMessage();

      capturedMessageListOpts!.onDeleteClick(5, true);

      expect(deleteModal()).toBeNull();
      expect(opts.ws.send).toHaveBeenCalledWith({
        type: "chat_delete",
        payload: { message_id: 5 },
      });
      ctrl.destroyChannel();
    });

    it("keeps the delivery gate: confirming while disconnected shows one error and sends nothing", () => {
      const { opts, ctrl } = mountBobsMessage();
      setConnectionStatus("disconnected");
      vi.clearAllMocks();

      capturedMessageListOpts!.onDeleteClick(5, false);
      confirmBtn().click();

      const sends = sentFrames(opts, "chat_delete");
      expect(sends).toHaveLength(0);
      expect(opts.showToast).toHaveBeenCalledTimes(1);
      expect(opts.showToast).toHaveBeenCalledWith(expect.stringContaining("delete"), "error");
      ctrl.destroyChannel();
    });

    it("closes an open dialog when the channel is destroyed", () => {
      mockGetChannelMessages.mockReturnValue([
        { id: 5, content: "bye", user: { id: 2, username: "Bob" } },
      ]);
      const { ctrl } = mountController();

      capturedMessageListOpts!.onDeleteClick(5, false);
      expect(deleteModal()).not.toBeNull();
      ctrl.destroyChannel();

      expect(deleteModal()).toBeNull();
    });

    it("onReactionClick delegates to reactionCtrl", () => {
      const { opts } = mountController();

      capturedMessageListOpts.onReactionClick(5, "👍");

      expect(opts.reactionCtrl.handleReaction).toHaveBeenCalledWith(5, "👍");
    });
  });

  describe("MessageInput callbacks", () => {
    it("releases retry payloads on its own keyed echo, while ignoring another user's echo", async () => {
      activatePendingMessages(
        { host: "chat.example", userId: 1 },
        { id: 1, username: "tester", avatar: null },
        true,
      );
      const opts = makeOpts();
      const ownedCleanups = new Set<() => void>();
      let current = true;
      Object.assign(opts.api, {
        getConfig: () => ({ host: "chat.example", token: "token" }),
        getSession: () => ({
          isCurrent: () => current,
          addCleanup: (cleanup: () => void) => {
            ownedCleanups.add(cleanup);
            return () => ownedCleanups.delete(cleanup);
          },
        }),
      });
      installSendIds(opts);
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");
      capturedMessageInputOpts.onSend("private text", null, [], []);
      await vi.waitFor(() => expect(mockAddOptimistic).toHaveBeenCalledOnce());
      const logicalId = mockAddOptimistic.mock.calls[0]![0].clientMessageId;
      const callback = vi
        .mocked(opts.ws.on)
        .mock.calls.find(([event]) => event === "chat_message")![1] as (payload: {
        user: { id: number };
        channel_id: number;
        client_message_id: string;
      }) => void;
      callback({ user: { id: 2 }, channel_id: 42, client_message_id: logicalId });
      expect(ownedCleanups.size).toBe(1);
      current = false;
      callback({ user: { id: 1 }, channel_id: 42, client_message_id: logicalId });
      expect(ownedCleanups.size).toBe(1);
      current = true;
      callback({ user: { id: 1 }, channel_id: 42, client_message_id: logicalId });
      expect(ownedCleanups.size).toBe(0);
      capturedMessageListOpts.onRetry("cid-2");
      expect(
        vi.mocked(opts.ws.send).mock.calls.filter(([frame]) => frame.type === "chat_send"),
      ).toHaveLength(1);
      ctrl.destroyChannel();
    });

    it("keeps the stable logical identity across explicit retries while changing transport ids", async () => {
      activatePendingMessages(
        { host: "chat.example", userId: 1 },
        { id: 1, username: "tester", avatar: null },
        true,
      );
      const opts = makeOpts();
      Object.assign(opts.api, { getConfig: () => ({ host: "chat.example", token: "token" }) });
      installSendIds(opts);
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");
      capturedMessageInputOpts.onSend("send once", null, [], []);
      await vi.waitFor(() => expect(mockAddOptimistic).toHaveBeenCalledOnce());
      const first = vi
        .mocked(opts.ws.send)
        .mock.calls.find(([frame]) => frame.type === "chat_send")![0];
      expect(first.payload).toMatchObject({ client_message_id: expect.stringMatching(/^\d{13}:/) });
      capturedMessageListOpts.onRetry("cid-2");
      await vi.waitFor(() => expect(mockAddOptimistic).toHaveBeenCalledTimes(2));
      const sends = vi
        .mocked(opts.ws.send)
        .mock.calls.filter(([frame]) => frame.type === "chat_send");
      expect(sends[1]![0].payload).toEqual(first.payload);
      expect(mockAddOptimistic.mock.calls[0]![0].correlationId).not.toEqual(
        mockAddOptimistic.mock.calls[1]![0].correlationId,
      );
      ctrl.destroyChannel();
    });

    async function retryPreFloorDraft(): Promise<{
      opts: ChannelControllerOptions;
      ctrl: ReturnType<typeof createChannelController>;
      beforeFloorId: string;
      handler: (event: string) => (payload: never, correlationId?: string) => void;
    }> {
      const owner = { host: "chat.example", userId: 1 };
      const user = { id: 1, username: "tester", avatar: null };
      const floor = Date.now() + 5 * 60 * 1000 + 1000;
      activatePendingMessages(owner, user, true, floor);
      // A pre-floor id was persisted before the restore; save it directly so
      // the recovered path exposes it (a live send would mint a post-floor id).
      const beforeFloorId = `${Date.now()}:${crypto.randomUUID()}`;
      await savePendingText(owner, {
        clientMessageId: beforeFloorId,
        channelId: 42,
        content: "queued before the restore",
        createdAt: Number(beforeFloorId.split(":", 1)[0]!),
      });

      const opts = makeOpts();
      Object.assign(opts.api, { getConfig: () => ({ host: owner.host, token: "token" }) });
      installSendIds(opts);
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");
      const listeners = [...vi.mocked(opts.ws.on).mock.calls];
      const handler = (event: string) =>
        listeners.find(([type]) => type === event)![1] as (
          payload: never,
          correlationId?: string,
        ) => void;
      vi.clearAllMocks();

      capturedMessageListOpts.onRetry(`recovered:${beforeFloorId}`);

      // The server decides: Retry resends the same logical id unchanged.
      await vi.waitFor(() =>
        expect(
          vi.mocked(opts.ws.send).mock.calls.filter(([frame]) => frame.type === "chat_send"),
        ).toHaveLength(1),
      );
      const [resent] = vi
        .mocked(opts.ws.send)
        .mock.calls.find(([frame]) => frame.type === "chat_send")!;
      expect(resent.payload).toMatchObject({
        client_message_id: beforeFloorId,
        content: "queued before the restore",
      });
      return { opts, ctrl, beforeFloorId, handler };
    }

    it("reconciles a pre-restore draft whose retry the server deduplicates", async () => {
      const { opts, ctrl, beforeFloorId, handler } = await retryPreFloorDraft();

      handler("chat_send_ok")(
        { message_id: 7, client_message_id: beforeFloorId, deduplicated: true } as never,
        "cid-2",
      );

      expect(opts.showToast).not.toHaveBeenCalled();
      expect(mockMarkSendFailed).not.toHaveBeenCalled();
      ctrl.destroyChannel();
    });

    it("does not resend a pre-restore retry the server refuses", async () => {
      const { opts, ctrl, handler } = await retryPreFloorDraft();

      handler("error")(
        { code: "BAD_REQUEST", message: "review the pending message" } as never,
        "cid-2",
      );

      // No resend loop: the refusal leaves the one failed row for the user.
      await Promise.resolve();
      expect(
        vi.mocked(opts.ws.send).mock.calls.filter(([frame]) => frame.type === "chat_send"),
      ).toHaveLength(1);
      ctrl.destroyChannel();
    });

    it("cannot retry a saved logical identity after a server capability downgrade", async () => {
      const owner = { host: "chat.example", userId: 1 };
      const user = { id: 1, username: "tester", avatar: null };
      activatePendingMessages(owner, user, true);
      const opts = makeOpts();
      Object.assign(opts.api, { getConfig: () => ({ host: owner.host, token: "token" }) });
      installSendIds(opts);
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");
      capturedMessageInputOpts.onSend("private text", null, [], []);
      await vi.waitFor(() => expect(mockAddOptimistic).toHaveBeenCalledOnce());
      activatePendingMessages(owner, user, false);
      capturedMessageListOpts.onRetry("cid-2");
      expect(
        vi.mocked(opts.ws.send).mock.calls.filter(([frame]) => frame.type === "chat_send"),
      ).toHaveLength(1);
      expect(mockRemoveOptimistic).not.toHaveBeenCalled();
      expect(opts.showToast).toHaveBeenCalledWith(
        expect.stringContaining("cannot safely retry"),
        "error",
      );
      ctrl.destroyChannel();
    });

    it("preserves submission order between a persisted plain-text send and a synchronous reply/attachment send", async () => {
      // A plain text send (no reply, no attachment) with dedup support takes
      // an async path: it awaits savePendingText's persistence round-trip
      // before handing the frame to the socket. A send with a reply or
      // attachment always dispatches synchronously. If the two paths are not
      // ordered against each other, a second message submitted right after a
      // first plain-text one can reach the socket first, inverting the order
      // every client renders for both messages.
      const owner = { host: "chat.example", userId: 1 };
      const user = { id: 1, username: "tester", avatar: null };
      activatePendingMessages(owner, user, true);
      const opts = makeOpts();
      Object.assign(opts.api, { getConfig: () => ({ host: owner.host, token: "token" }) });
      let next = 0;
      const sentContents: string[] = [];
      vi.mocked(opts.ws.send).mockImplementation((frame) => {
        if ((frame as { type: string }).type === "chat_send") {
          sentContents.push((frame as { payload: { content: string } }).payload.content);
        }
        return `cid-${++next}`;
      });
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      // "A" is plain text and takes the persisted async path.
      capturedMessageInputOpts.onSend("A", null, [], []);
      // "B" carries a reply, submitted right after A while A's persist IPC
      // is still in flight — it must not be sent to the socket before A.
      capturedMessageInputOpts.onSend("B", 7, [], []);

      await vi.waitFor(() => expect(sentContents).toHaveLength(2));
      expect(sentContents).toEqual(["A", "B"]);
      ctrl.destroyChannel();
    });

    it("ignores a stale composer callback after its server session changes", () => {
      let current = true;
      const opts = makeOpts();
      Object.assign(opts.api, { getSession: () => ({ isCurrent: () => current }) });
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");
      current = false;
      capturedMessageInputOpts.onSend("belongs to the old server", null, [], []);
      expect(opts.ws.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "chat_send" }));
    });

    it(
      "releases every acknowledged send timer and its session cleanup",
      fakeTimersTest(() => {
        const cleanups = new Set<() => void>();
        const opts = makeOpts();
        Object.assign(opts.api, {
          getSession: () => ({
            isCurrent: () => true,
            addCleanup: (cleanup: () => void) => {
              cleanups.add(cleanup);
              return () => cleanups.delete(cleanup);
            },
          }),
        });
        let next = 0;
        vi.mocked(opts.ws.send).mockImplementation(() => `cid-${++next}`);
        const ctrl = createChannelController(opts);
        ctrl.mountChannel(42, "general");
        for (let i = 0; i < 100; i++) {
          capturedMessageInputOpts.onSend("hello", null, [], []);
          const callback = vi
            .mocked(opts.ws.on)
            .mock.calls.findLast(([event]) => event === "chat_send_ok")![1];
          (callback as (payload: object, id: string) => void)({}, `cid-${next}`);
        }
        expect(cleanups.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(20_000);
        expect(mockMarkSendFailed).not.toHaveBeenCalled();
      }),
    );

    it("onSend sends chat_send via ws", () => {
      const { opts } = mountController();

      capturedMessageInputOpts.onSend("hello", null, [], []);

      expect(opts.ws.send).toHaveBeenCalledWith({
        type: "chat_send",
        payload: {
          channel_id: 42,
          content: "hello",
          reply_to: null,
          attachments: [],
        },
      });
    });

    it("onSend drops the reply when its target was deleted", () => {
      mockGetChannelMessages.mockReturnValue([{ id: 7, content: "", deleted: true }]);
      const { opts } = mountController();

      capturedMessageInputOpts.onSend("hello", 7, [], []);

      expect(opts.ws.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "chat_send",
          payload: expect.objectContaining({ reply_to: null }),
        }),
      );
    });

    it("onSend keeps the reply when its target is live", () => {
      mockGetChannelMessages.mockReturnValue([{ id: 7, content: "original", deleted: false }]);
      const { opts } = mountController();

      capturedMessageInputOpts.onSend("hello", 7, [], []);

      expect(opts.ws.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "chat_send",
          payload: expect.objectContaining({ reply_to: 7 }),
        }),
      );
    });

    it("onSend from a detached window reattaches to present before sending", () => {
      // After a jump into history the composer stays enabled; sending must
      // land the optimistic row in the live tail, not mid-history.
      mockIsWindowDetached.mockReturnValueOnce(true);
      mockMarkChannelRead.mockClear();
      const { opts } = mountController();
      (opts.msgCtrl.loadMessages as ReturnType<typeof vi.fn>).mockClear();

      capturedMessageInputOpts.onSend("hello", null, [], []);

      expect(mockReattachToPresent).toHaveBeenCalledWith(42);
      // Reattach clears "loaded", so the live tail is refetched.
      expect(opts.msgCtrl.loadMessages).toHaveBeenCalledWith(42, expect.any(AbortSignal));
      // The send itself still goes out.
      expect(opts.ws.send).toHaveBeenCalledWith(expect.objectContaining({ type: "chat_send" }));
      // OC-0204: a detached-but-active channel can carry an unread/mention
      // badge dispatcher.ts left behind for messages missed below the gap —
      // jumping to present (which sending here implies) must clear it.
      expect(mockMarkChannelRead).toHaveBeenCalledWith(42);
    });

    it("onSend while disconnected records a failed optimistic row (no silent drop)", () => {
      const opts = makeOpts();
      setConnectionStatus("disconnected");
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      capturedMessageInputOpts.onSend("hello", null, [], []);

      // No socket send is attempted; the row is shown as failed with retry.
      expect(opts.ws.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "chat_send" }));
      expect(mockAddOptimistic).toHaveBeenCalled();
      expect(mockMarkSendFailed).toHaveBeenCalledWith(expect.any(String), "OFFLINE");
    });

    it("marks an offline send unrecoverable when the recovery outbox cannot take it", async () => {
      // An offline send is never handed to a socket, so the saved copy IS the
      // message: if the write fails there is nothing left after a restart. A
      // full outbox (64 drafts) is how that write fails in practice, and the
      // row must not keep claiming an ordinary offline retry is enough.
      const owner = { host: "chat.example", userId: 1 };
      activatePendingMessages(owner, { id: 1, username: "tester", avatar: null }, true);
      const opts = makeOpts();
      Object.assign(opts.api, { getConfig: () => ({ host: owner.host, token: "token" }) });
      for (let i = 0; i < PENDING_MESSAGE_MAX_COUNT; i++) {
        const filler = newClientMessageId();
        await savePendingText(owner, {
          clientMessageId: filler,
          channelId: 99,
          content: `filler ${i}`,
          createdAt: Number(filler.split(":", 1)[0]),
        });
      }
      setConnectionStatus("disconnected");
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      capturedMessageInputOpts.onSend("lost text", null, [], []);

      expect(mockMarkSendFailed).toHaveBeenCalledWith(expect.any(String), "OFFLINE");
      await vi.waitFor(() =>
        expect(mockMarkSendFailed).toHaveBeenCalledWith(expect.any(String), "OFFLINE_NO_RECOVERY"),
      );
      // The relabel targets the row this send created, not the filler drafts.
      const correlationId = mockAddOptimistic.mock.calls[0]![0].correlationId;
      expect(mockMarkSendFailed).toHaveBeenCalledWith(correlationId, "OFFLINE_NO_RECOVERY");
      expect(opts.showToast).toHaveBeenCalledWith(
        expect.stringContaining("Could not save this pending message"),
        "error",
      );
      expect(opts.ws.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "chat_send" }));
      ctrl.destroyChannel();
    });

    it("composer disable reason distinguishes reconnecting from disconnected", () => {
      const opts = makeOpts();
      setConnectionStatus("reconnecting");
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");
      expect(mockSetDisabled).toHaveBeenLastCalledWith("Reconnecting…");

      ctrl.destroyChannel();
      setConnectionStatus("disconnected");
      ctrl.mountChannel(43, "general-2");
      expect(mockSetDisabled).toHaveBeenLastCalledWith("Not connected");
    });

    it("composer shows the timeout with the server-supplied expiry and re-enables on lift", async () => {
      const { ctrl } = mountController();
      expect(mockSetDisabled).toHaveBeenLastCalledWith(null);

      setActiveTimeout(new Date(Date.now() + 60_000).toISOString());
      await Promise.resolve();
      expect(mockSetDisabled).toHaveBeenLastCalledWith(
        expect.stringMatching(/^You can't send messages until /),
      );

      setActiveTimeout(null);
      await Promise.resolve();
      expect(mockSetDisabled).toHaveBeenLastCalledWith(null);
      ctrl.destroyChannel();
    });

    it("onRetryLoad re-invokes loadMessages for the mounted channel", () => {
      const { opts } = mountController();
      (opts.msgCtrl.loadMessages as ReturnType<typeof vi.fn>).mockClear();

      capturedMessageListOpts.onRetryLoad();

      expect(opts.msgCtrl.loadMessages).toHaveBeenCalledWith(42, expect.any(AbortSignal));
    });

    it("onJumpToMessage routes a reply-bar jump through the shared jumper", () => {
      mountController();

      capturedMessageListOpts.onJumpToMessage(1234);

      // Scoped to the mounted channel: a reply always points inside it.
      expect(mockJumpToMessage).toHaveBeenCalledWith(42, 1234);
    });

    it("onJumpToPresent reattaches the channel and refetches the live tail", () => {
      mockMarkChannelRead.mockClear();
      const { opts } = mountController();
      (opts.msgCtrl.loadMessages as ReturnType<typeof vi.fn>).mockClear();

      capturedMessageListOpts.onJumpToPresent();

      // Reattaching first is what makes the refetch actually happen —
      // loadMessages short-circuits while the channel is still "loaded".
      expect(mockReattachToPresent).toHaveBeenCalledWith(42);
      expect(opts.msgCtrl.loadMessages).toHaveBeenCalledWith(42, expect.any(AbortSignal));
      expect(mockReattachToPresent.mock.invocationCallOrder[0]).toBeLessThan(
        (opts.msgCtrl.loadMessages as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
      );
      // OC-0204: clicking "Jump to Present" is reading whatever arrived
      // below the gap — clear the badge it may have left, the same way
      // leaving a channel does.
      expect(mockMarkChannelRead).toHaveBeenCalledWith(42);
    });

    it("onRetry re-sends the failed draft with a fresh correlation id", () => {
      mountControllerWithSendIds();

      // cid-1 is channel_focus; the chat_send gets cid-2.
      capturedMessageInputOpts.onSend("hello", null, [], []);
      expect(mockAddOptimistic).toHaveBeenCalledWith(
        expect.objectContaining({ correlationId: "cid-2", content: "hello" }),
      );

      capturedMessageListOpts.onRetry("cid-2");

      // The old row is discarded and the draft re-sent under a new id.
      expect(mockRemoveOptimistic).toHaveBeenCalledWith("cid-2");
      expect(mockAddOptimistic).toHaveBeenLastCalledWith(
        expect.objectContaining({ correlationId: "cid-3", content: "hello" }),
      );
    });

    it("onRetry re-sends a refused reply as a plain message", () => {
      const { opts } = mountControllerWithSendIds();
      mockGetChannelMessages.mockReturnValue([]);
      capturedMessageInputOpts.onSend("hello", 7, [], []);
      mockGetChannelMessages.mockReturnValue([
        { id: -1, correlationId: "cid-2", status: "failed", errorCode: "BAD_REQUEST" },
      ]);

      capturedMessageListOpts.onRetry("cid-2");

      expect(opts.ws.send).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: "chat_send",
          payload: expect.objectContaining({ content: "hello", reply_to: null }),
        }),
      );
    });

    it("onRetry keeps the reply when the send failed for another reason", () => {
      const { opts } = mountControllerWithSendIds();
      mockGetChannelMessages.mockReturnValue([]);
      capturedMessageInputOpts.onSend("hello", 7, [], []);
      mockGetChannelMessages.mockReturnValue([
        { id: -1, correlationId: "cid-2", status: "failed", errorCode: "NETWORK" },
      ]);

      capturedMessageListOpts.onRetry("cid-2");

      expect(opts.ws.send).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: "chat_send",
          payload: expect.objectContaining({ content: "hello", reply_to: 7 }),
        }),
      );
    });

    it("onDeleteDraft discards the failed row without re-sending", () => {
      const { opts } = mountControllerWithSendIds();

      capturedMessageInputOpts.onSend("hello", null, [], []);
      const sendCalls = (opts.ws.send as ReturnType<typeof vi.fn>).mock.calls.length;

      capturedMessageListOpts.onDeleteDraft("cid-2");

      expect(mockRemoveOptimistic).toHaveBeenCalledWith("cid-2");
      expect((opts.ws.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(sendCalls);
    });

    it("onRetry still re-sends a failed draft after the channel was remounted", () => {
      // A failed row survives a channel switch (it is carried across history
      // refetches), so its draft must too — a per-mount draft map left Retry
      // silently inert once the reader switched away and back.
      const { ctrl } = mountControllerWithSendIds();

      // cid-1 is channel_focus; the chat_send gets cid-2.
      capturedMessageInputOpts.onSend("hello", null, [], []);
      expect(mockAddOptimistic).toHaveBeenCalledWith(
        expect.objectContaining({ correlationId: "cid-2", content: "hello" }),
      );

      // Simulate a real remount: switch away and back to the same channel.
      ctrl.destroyChannel();
      ctrl.mountChannel(42, "general");

      capturedMessageListOpts.onRetry("cid-2");

      expect(mockRemoveOptimistic).toHaveBeenCalledWith("cid-2");
      expect(mockAddOptimistic).toHaveBeenLastCalledWith(
        expect.objectContaining({ correlationId: "cid-4", content: "hello" }),
      );
    });

    it("releases a draft once the send is acked", () => {
      // The draft map outlives a channel switch so a failed row stays
      // retriable. Nothing else prunes it, so an accepted send must release
      // its own entry or every message of the session is retained forever.
      const { opts } = mountControllerWithSendIds();

      capturedMessageInputOpts.onSend("hello", null, [], []);

      const ackCall = (opts.ws.on as ReturnType<typeof vi.fn>).mock.calls.findLast(
        (c: unknown[]) => c[0] === "chat_send_ok",
      );
      const onAck = ackCall![1] as (payload: unknown, id?: string) => void;
      onAck({ message_id: 7, timestamp: "2024-01-01T00:00:00Z" }, "cid-2");

      const sendCalls = (opts.ws.send as ReturnType<typeof vi.fn>).mock.calls.length;
      capturedMessageListOpts.onRetry("cid-2");

      // No draft left to re-send: the ack already released it.
      expect((opts.ws.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(sendCalls);
    });

    it("onTyping sends typing_start via ws", () => {
      const { opts } = mountController();

      capturedMessageInputOpts.onTyping();

      expect(opts.ws.send).toHaveBeenCalledWith({
        type: "typing_start",
        payload: { channel_id: 42 },
      });
    });

    it("onEditSave skips the send, and closes the editor, when content unchanged", () => {
      mockGetChannelMessages.mockReturnValue([{ id: 5, content: "hello" }]);
      const { opts } = mountController();

      // true closes the editor.
      expect(capturedMessageListOpts!.onEditSave(5, "hello")).toBe(true);

      // Should not send edit since content hasn't changed
      const sendMock = opts.ws.send as ReturnType<typeof vi.fn>;
      const editCalls = sendMock.mock.calls.filter(
        (c: unknown[]) => (c[0] as { type: string }).type === "chat_edit",
      );
      expect(editCalls).toHaveLength(0);
    });

    it("onTyping does not send when rate limited", () => {
      const opts = makeOpts();
      (opts.typingLimiter.tryConsume as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      capturedMessageInputOpts!.onTyping();

      const sendMock = opts.ws.send as ReturnType<typeof vi.fn>;
      const typingCalls = sendMock.mock.calls.filter(
        (c: unknown[]) => (c[0] as { type: string }).type === "typing_start",
      );
      expect(typingCalls).toHaveLength(0);
    });

    it("onUploadFile returns file data on success", async () => {
      mountController();

      const result = await capturedMessageInputOpts!.onUploadFile(new File(["x"], "test.txt"));

      expect(result).toEqual({ id: 1, url: "/f/1", filename: "f.txt" });
    });

    // P1-09: the composer reports a failed upload inline from the rejection,
    // so the controller must not also toast it.
    it("onUploadFile rethrows a failure for the composer's inline line, without a toast", async () => {
      const opts = makeOpts();
      (
        opts.api as unknown as { uploadFile: ReturnType<typeof vi.fn> }
      ).uploadFile.mockRejectedValue(new Error("upload failed"));
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      await expect(
        capturedMessageInputOpts!.onUploadFile(new File(["x"], "test.txt")),
      ).rejects.toThrow("upload failed");
      expect(opts.showToast).not.toHaveBeenCalled();
    });
  });

  describe("MessageList callbacks - additional", () => {
    it("onScrollTop delegates to msgCtrl.loadOlderMessages", () => {
      const { opts } = mountController();

      capturedMessageListOpts!.onScrollTop();

      expect(opts.msgCtrl.loadOlderMessages).toHaveBeenCalledWith(42, expect.any(AbortSignal));
    });

    it("onScrollBottom delegates to msgCtrl.loadNewerMessages", () => {
      const { opts } = mountController();

      capturedMessageListOpts!.onScrollBottom!();

      expect(opts.msgCtrl.loadNewerMessages).toHaveBeenCalledWith(42, expect.any(AbortSignal));
    });

    it("onReplyClick sets reply with username", () => {
      mockGetChannelMessages.mockReturnValue([
        { id: 5, content: "hello", user: { id: 2, username: "alice" } },
      ]);
      mountController();

      capturedMessageListOpts!.onReplyClick(5);

      expect(mockSetReplyTo).toHaveBeenCalledWith(5, "alice", { self: false });
    });

    it("onReplyClick shows the display name and marks a reply to yourself (3A-12)", () => {
      mockGetChannelMessages.mockReturnValue([
        { id: 5, content: "hi", user: { id: 2, username: "alice", display_name: "Alice B" } },
        { id: 6, content: "mine", user: { id: 1, username: "me" } },
      ]);
      const ctrl = createChannelController(makeOpts());
      ctrl.mountChannel(42, "general");

      capturedMessageListOpts!.onReplyClick(5);
      expect(mockSetReplyTo).toHaveBeenLastCalledWith(5, "Alice B", { self: false });
      capturedMessageListOpts!.onReplyClick(6);
      expect(mockSetReplyTo).toHaveBeenLastCalledWith(6, "me", { self: true });
    });

    it("onReplyClick uses empty string for unknown message", () => {
      mockGetChannelMessages.mockReturnValue([]);
      mountController();

      capturedMessageListOpts!.onReplyClick(999);

      expect(mockSetReplyTo).toHaveBeenCalledWith(999, "");
    });

    it("onEditClick opens the inline editor on that message", () => {
      mockGetChannelMessages.mockReturnValue([
        { id: 5, content: "hello", user: { id: 1, username: "me" } },
      ]);
      mountController();

      capturedMessageListOpts!.onEditClick(5);

      expect(mockStartEdit).toHaveBeenCalledWith(5);
    });

    it("onEditClick hands an unknown id to the list, which refuses it", () => {
      mockGetChannelMessages.mockReturnValue([]);
      mockStartEdit.mockReturnValue(false);
      const { opts } = mountController();

      capturedMessageListOpts!.onEditClick(999);

      // The list owns "is it loaded, mine and sent"; nothing else happens.
      expect(mockStartEdit).toHaveBeenCalledExactlyOnceWith(999);
      expect(opts.ws.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "chat_edit" }));
    });

    it("onEditEnd puts focus back in the composer", () => {
      const ctrl = createChannelController(makeOpts());
      ctrl.mountChannel(42, "general");

      capturedMessageListOpts!.onEditEnd();

      expect(mockInputFocus).toHaveBeenCalledTimes(1);
      ctrl.destroyChannel();
    });

    it("onPinClick pins a message and shows toast", async () => {
      const opts = makeOpts();
      (opts.api as unknown as { pinMessage: ReturnType<typeof vi.fn> }).pinMessage = vi
        .fn()
        .mockResolvedValue(undefined);
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      capturedMessageListOpts!.onPinClick(5, 42, false);

      // Optimistic: the row flips before the request settles.
      expect(mockSetMessagePinned).toHaveBeenCalledExactlyOnceWith(42, 5, true);

      await vi.waitFor(() => {
        expect(opts.showToast).toHaveBeenCalledWith("Message pinned", "success");
      });
      expect(mockSetMessagePinned).toHaveBeenCalledOnce();
    });

    it("onPinClick unpins a message and shows toast", async () => {
      const opts = makeOpts();
      (opts.api as unknown as { unpinMessage: ReturnType<typeof vi.fn> }).unpinMessage = vi
        .fn()
        .mockResolvedValue(undefined);
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      capturedMessageListOpts!.onPinClick(5, 42, true);

      expect(mockSetMessagePinned).toHaveBeenCalledExactlyOnceWith(42, 5, false);

      await vi.waitFor(() => {
        expect(opts.showToast).toHaveBeenCalledWith("Message unpinned", "success");
      });
      expect(mockSetMessagePinned).toHaveBeenCalledOnce();
    });

    it("onPinClick shows error toast on failure", async () => {
      const opts = makeOpts();
      (opts.api as unknown as { pinMessage: ReturnType<typeof vi.fn> }).pinMessage = vi
        .fn()
        .mockRejectedValue(new Error("network error"));
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      capturedMessageListOpts!.onPinClick(5, 42, false);

      await vi.waitFor(() => {
        expect(opts.showToast).toHaveBeenCalledWith("Failed to pin/unpin message", "error");
      });
      // Flipped first, then reverted to the state it started in.
      expect(mockSetMessagePinned.mock.calls).toEqual([
        [42, 5, true],
        [42, 5, false],
      ]);
    });

    it("onPinClick: a chat_pinned before the rejection keeps its truth, no revert", async () => {
      const opts = makeOpts();
      let reject: (e: Error) => void = () => {};
      (opts.api as unknown as { pinMessage: ReturnType<typeof vi.fn> }).pinMessage = vi
        .fn()
        .mockReturnValue(new Promise<void>((_, r) => (reject = r)));
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");
      mockPinRevisions.clear();

      capturedMessageListOpts!.onPinClick(5, 42, false);
      // The server's broadcast lands while the request is pending.
      mockPinRevisions.set(5, 1);
      reject(new Error("late"));

      await vi.waitFor(() => {
        expect(opts.showToast).toHaveBeenCalledWith("Failed to pin/unpin message", "error");
      });
      expect(mockSetMessagePinned.mock.calls).toEqual([[42, 5, true]]);
      mockPinRevisions.clear();
    });

    it("onPinClick: a pin of another message in the channel still lets the rejection revert", async () => {
      const opts = makeOpts();
      let reject: (e: Error) => void = () => {};
      (opts.api as unknown as { pinMessage: ReturnType<typeof vi.fn> }).pinMessage = vi
        .fn()
        .mockReturnValue(new Promise<void>((_, r) => (reject = r)));
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");
      mockPinRevisions.clear();

      capturedMessageListOpts!.onPinClick(5, 42, false);
      mockPinRevisions.set(6, 1);
      reject(new Error("refused"));

      await vi.waitFor(() => {
        expect(mockSetMessagePinned.mock.calls).toEqual([
          [42, 5, true],
          [42, 5, false],
        ]);
      });
      mockPinRevisions.clear();
    });

    it("onPinClick: a second click while the first is pending is ignored, then allowed again", async () => {
      const opts = makeOpts();
      let resolve: () => void = () => {};
      const pinMessage = vi.fn().mockReturnValue(new Promise<void>((r) => (resolve = r)));
      (opts.api as unknown as { pinMessage: ReturnType<typeof vi.fn> }).pinMessage = pinMessage;
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      capturedMessageListOpts!.onPinClick(5, 42, false);
      capturedMessageListOpts!.onPinClick(5, 42, true);
      expect(pinMessage).toHaveBeenCalledOnce();
      expect(mockSetMessagePinned).toHaveBeenCalledOnce();

      resolve();
      await vi.waitFor(() => {
        expect(opts.showToast).toHaveBeenCalledWith("Message pinned", "success");
      });
      await Promise.resolve();
      capturedMessageListOpts!.onPinClick(5, 42, false);
      expect(pinMessage).toHaveBeenCalledTimes(2);
    });

    it("onPinClick failure on an unpin restores the pinned state", async () => {
      const opts = makeOpts();
      (opts.api as unknown as { unpinMessage: ReturnType<typeof vi.fn> }).unpinMessage = vi
        .fn()
        .mockRejectedValue(new Error("network error"));
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      capturedMessageListOpts!.onPinClick(5, 42, true);

      await vi.waitFor(() => {
        expect(opts.showToast).toHaveBeenCalledWith("Failed to pin/unpin message", "error");
      });
      expect(mockSetMessagePinned.mock.calls).toEqual([
        [42, 5, false],
        [42, 5, true],
      ]);
    });

    it("onScrollTop does not load when channelAbort is null (after destroy)", () => {
      const { opts, ctrl } = mountController();

      // Capture the onScrollTop callback
      const scrollTopCb = capturedMessageListOpts!.onScrollTop;

      // Destroy channel (sets channelAbort to null)
      ctrl.destroyChannel();
      vi.clearAllMocks();

      // Calling onScrollTop after destroy should not call loadOlderMessages
      scrollTopCb();

      expect(opts.msgCtrl.loadOlderMessages).not.toHaveBeenCalled();
    });
  });

  describe("MessageInput callbacks - additional", () => {
    it("onEditSave sends chat_edit when content changed", () => {
      mockGetChannelMessages.mockReturnValue([{ id: 5, content: "old content" }]);
      const { opts } = mountController();

      expect(capturedMessageListOpts!.onEditSave(5, "new content")).toBe(true);

      expect(opts.ws.send).toHaveBeenCalledWith({
        type: "chat_edit",
        payload: { message_id: 5, content: "new content" },
      });
      // CLI-08: no optimistic success toast — an edit is confirmed by its
      // chat_edited echo, and toasted only when it fails.
      expect(opts.showToast).not.toHaveBeenCalledWith(expect.any(String), "success");
    });

    it("onEditSave sends edit when message not found in store", () => {
      mockGetChannelMessages.mockReturnValue([]);
      const { opts } = mountController();

      capturedMessageListOpts!.onEditSave(999, "new content");

      expect(opts.ws.send).toHaveBeenCalledWith({
        type: "chat_edit",
        payload: { message_id: 999, content: "new content" },
      });
    });

    it("onSend includes reply_to and attachments", () => {
      const { opts } = mountController();

      capturedMessageInputOpts.onSend(
        "hello",
        10,
        ["file1.png"],
        [{ id: "file1.png", filename: "file1.png" }],
        true,
      );

      expect(opts.ws.send).toHaveBeenCalledWith({
        type: "chat_send",
        payload: {
          channel_id: 42,
          content: "hello",
          reply_to: 10,
          reply_ping: true,
          attachments: ["file1.png"],
        },
      });
    });

    it("sends reply_ping false with a reply and leaves it out without one (3A-12)", () => {
      const { opts } = mountController();

      capturedMessageInputOpts.onSend("off", 10, [], [], false);
      capturedMessageInputOpts.onSend("plain", null, [], [], true);

      const payloads = vi
        .mocked(opts.ws.send)
        .mock.calls.filter(([f]) => f.type === "chat_send")
        .map(([f]) => f.payload as Record<string, unknown>);
      expect(payloads[0]).toMatchObject({ reply_to: 10, reply_ping: false });
      expect(payloads[1]).not.toHaveProperty("reply_ping");
    });

    it("a retry resends the same reply_ping (3A-12)", () => {
      const { opts } = mountControllerWithSendIds();
      mockGetChannelMessages.mockReturnValue([]);
      capturedMessageInputOpts.onSend("hey", 7, [], [], false);
      mockGetChannelMessages.mockReturnValue([
        { id: -1, correlationId: "cid-2", status: "failed", errorCode: "NETWORK" },
      ]);

      capturedMessageListOpts.onRetry("cid-2");

      expect(opts.ws.send).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: "chat_send",
          payload: expect.objectContaining({ reply_to: 7, reply_ping: false }),
        }),
      );
      mockGetChannelMessages.mockReturnValue([]);
    });
  });
});
