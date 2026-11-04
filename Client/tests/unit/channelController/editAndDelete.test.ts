import { describe, it, expect, vi } from "vitest";
import { fakeTimersTest } from "../../helpers/fakeTimersTest";
import * as mocks from "../../helpers/channelControllerMocks";
import { createChannelController } from "../../../src/pages/main-page/ChannelController";
import type { ChannelControllerOptions } from "../../../src/pages/main-page/ChannelController";
import { setConnectionStatus } from "@stores/ui.store";
import { messagingText } from "../../../src/i18n/messaging";
import { capturedMessageListOpts } from "../../helpers/channelControllerMocks";
import {
  makeOpts,
  sentFrames,
  mountController,
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

const { mockGetChannelMessages, mockStartEdit, mockIsEditing, mockIsIdle } = mocks;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function editRow(id: number, content: string, over: Record<string, unknown> = {}) {
  return {
    id,
    content,
    user: { id: 1, username: "me" },
    deleted: false,
    status: "sent",
    ...over,
  };
}

describe("createChannelController", () => {
  useChannelControllerHarness();

  describe("edit-last-message event", () => {
    function pressEditLast(): void {
      const { opts } = mountController();
      vi.clearAllMocks();
      opts.slots.inputSlot.dispatchEvent(new Event("edit-last-message"));
    }

    it("finds the last non-deleted message by current user and starts edit", () => {
      mockGetChannelMessages.mockReturnValue([
        editRow(1, "first"),
        editRow(2, "other user", { user: { id: 2, username: "them" } }),
        editRow(3, "my deleted", { deleted: true }),
        editRow(4, "my latest"),
      ]);
      pressEditLast();

      expect(mockStartEdit).toHaveBeenCalledExactlyOnceWith(4);
    });

    it("skips a sticker message and edits the last message with text", () => {
      mockGetChannelMessages.mockReturnValue([
        editRow(1, "my text"),
        editRow(2, "[Sticker: Wave]", {
          sticker: { id: 3, name: "Wave", url: "/api/v1/stickers/3/image" },
        }),
      ]);
      pressEditLast();

      expect(mockStartEdit).toHaveBeenCalledExactlyOnceWith(1);
    });

    it("skips deleted messages and finds earlier non-deleted message", () => {
      mockGetChannelMessages.mockReturnValue([
        editRow(1, "earliest"),
        editRow(2, "deleted", { deleted: true }),
      ]);
      pressEditLast();

      expect(mockStartEdit).toHaveBeenCalledExactlyOnceWith(1);
    });

    it("does nothing when no own messages exist", () => {
      mockGetChannelMessages.mockReturnValue([
        editRow(1, "other", { user: { id: 2, username: "them" } }),
      ]);
      pressEditLast();

      expect(mockStartEdit).not.toHaveBeenCalled();
    });

    it("skips an unconfirmed/failed optimistic row (id 0) and edits the last actually-sent message", () => {
      mockGetChannelMessages.mockReturnValue([
        editRow(5, "sent earlier"),
        editRow(0, "still sending", { status: "pending" }),
      ]);
      pressEditLast();

      // The visual Edit affordance only appears on status === "sent" rows
      // (renderers.ts); the keyboard shortcut must honor the same gate rather
      // than editing an optimistic row that has no real message id yet.
      expect(mockStartEdit).toHaveBeenCalledExactlyOnceWith(5);
    });

    it("does nothing when every own message is still pending/failed", () => {
      mockGetChannelMessages.mockReturnValue([editRow(0, "still sending", { status: "failed" })]);
      pressEditLast();

      expect(mockStartEdit).not.toHaveBeenCalled();
    });
  });

  // CLI-08: chat_edit / chat_delete are fire-and-forget. They used to toast
  // "success" on send, so a frame dropped by a closed or half-open socket left
  // a moderator convinced the message was gone. Track each frame's envelope id
  // (like reactions), resolve it on the echo, and report one error if the
  // socket refuses it — restoring an edit's text so it can be retried.
  describe("edit/delete delivery tracking", () => {
    /** The onSendFailure listener the controller registered. */
    function sendFailureListener(
      opts: ChannelControllerOptions,
    ): (id: string, code: string) => void {
      const calls = (opts.ws.onSendFailure as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      return calls[0]![0] as (id: string, code: string) => void;
    }

    function errorListener(
      opts: ChannelControllerOptions,
    ): (payload: { code: string; message: string }, id?: string) => void {
      const calls = (opts.ws.on as ReturnType<typeof vi.fn>).mock.calls;
      const entry = calls.findLast((c) => c[0] === "error");
      expect(entry).toBeDefined();
      return entry![1] as (payload: { code: string; message: string }, id?: string) => void;
    }

    function echoListener(
      opts: ChannelControllerOptions,
      event: string,
    ): (payload: { message_id: number; channel_id: number }) => void {
      const calls = (opts.ws.on as ReturnType<typeof vi.fn>).mock.calls;
      const entry = calls.find((c) => c[0] === event);
      expect(entry).toBeDefined();
      return entry![1] as (payload: { message_id: number; channel_id: number }) => void;
    }

    function mountEditable(): ReturnType<typeof mountWithIds> {
      mockGetChannelMessages.mockReturnValue([{ id: 5, content: "old content" }]);
      return mountWithIds();
    }

    function stateListener(opts: ChannelControllerOptions): (state: string) => void {
      const calls = (opts.ws.onStateChange as ReturnType<typeof vi.fn>).mock.calls;
      return calls[0]![0] as (state: string) => void;
    }

    function mountWithIds(): {
      opts: ChannelControllerOptions;
      ctrl: ReturnType<typeof createChannelController>;
      ids: () => string[];
    } {
      const opts = makeOpts();
      const issued: string[] = [];
      (opts.ws.send as ReturnType<typeof vi.fn>).mockImplementation((frame: { type: string }) => {
        const id = `cid-${issued.length + 1}-${frame.type}`;
        issued.push(id);
        return id;
      });
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");
      return { opts, ctrl, ids: () => issued };
    }

    function saveEditThenCapture(text: string) {
      const { opts, ctrl, ids } = mountEditable();
      const onSendFailure = sendFailureListener(opts);
      capturedMessageListOpts!.onEditSave(5, text);
      const editId = ids().find((id) => id.endsWith("chat_edit"))!;
      vi.clearAllMocks();
      return { opts, ctrl, fail: (reason: string) => onSendFailure(editId, reason) };
    }

    async function expectEditRestoredWithToast(opts: ChannelControllerOptions, text: string) {
      await vi.waitFor(() => expect(mockStartEdit).toHaveBeenCalledWith(5, text, { focus: true }));
      await vi.waitFor(() => expect(opts.showToast).toHaveBeenCalledTimes(1));
      expect(opts.showToast).toHaveBeenCalledWith(
        messagingText("toast.editFailedRestored"),
        "error",
      );
    }

    it("does not toast success when a delete is sent and acknowledged", () => {
      const { opts, ctrl } = mountController();

      capturedMessageListOpts!.onDeleteClick(5, true);

      expect(opts.ws.send).toHaveBeenCalledWith({
        type: "chat_delete",
        payload: { message_id: 5 },
      });
      expect(opts.showToast).not.toHaveBeenCalledWith(expect.any(String), "success");
      ctrl.destroyChannel();
    });

    it("shows one error and sends nothing when deleting while disconnected", () => {
      setConnectionStatus("disconnected");
      const { opts, ctrl } = mountController();
      vi.clearAllMocks();

      capturedMessageListOpts!.onDeleteClick(5, true);

      const sends = sentFrames(opts, "chat_delete");
      expect(sends).toHaveLength(0);
      expect(opts.showToast).toHaveBeenCalledTimes(1);
      expect(opts.showToast).toHaveBeenCalledWith(expect.stringContaining("delete"), "error");
      expect(opts.showToast).not.toHaveBeenCalledWith(expect.any(String), "success");
      ctrl.destroyChannel();
    });

    it("does not toast success when an edit is sent", () => {
      const { opts, ctrl } = mountEditable();

      capturedMessageListOpts!.onEditSave(5, "new content");

      const sends = sentFrames(opts, "chat_edit");
      expect(sends).toHaveLength(1);
      expect(opts.showToast).not.toHaveBeenCalledWith(expect.any(String), "success");
      ctrl.destroyChannel();
    });

    it("shows one error, sends nothing, and keeps the editor open when saving offline", () => {
      setConnectionStatus("reconnecting");
      mockGetChannelMessages.mockReturnValue([{ id: 5, content: "old content" }]);
      const { opts, ctrl } = mountController();
      vi.clearAllMocks();

      // false keeps the editor open with the text; nothing was sent.
      expect(capturedMessageListOpts!.onEditSave(5, "new content")).toBe(false);

      const sends = sentFrames(opts, "chat_edit");
      expect(sends).toHaveLength(0);
      expect(opts.showToast).toHaveBeenCalledTimes(1);
      expect(opts.showToast).toHaveBeenCalledWith(messagingText("toast.editFailed"), "error");
      expect(mockStartEdit).not.toHaveBeenCalled();
      ctrl.destroyChannel();
    });

    it("shows one error and restores the text when an edit fails to send", async () => {
      const { opts, ctrl, fail } = saveEditThenCapture("new content");

      fail("NETWORK");

      await expectEditRestoredWithToast(opts, "new content");
      ctrl.destroyChannel();
    });

    it("restores the text but leaves the single error to the dispatcher on a server refusal", async () => {
      const { opts, ctrl, ids } = mountEditable();
      const onError = errorListener(opts);

      capturedMessageListOpts!.onEditSave(5, "too long");
      const editId = ids().find((id) => id.endsWith("chat_edit"))!;
      vi.clearAllMocks();

      onError({ code: "BAD_REQUEST", message: "Message too long" }, editId);

      // The dispatcher's error chain already shows the one error toast; the
      // controller only restores, so the user never sees two.
      expect(opts.showToast).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(mockStartEdit).toHaveBeenCalledWith(5, "too long", { focus: true }),
      );
      ctrl.destroyChannel();
    });

    it("shows one error when a delete frame fails to send", () => {
      const { opts, ctrl, ids } = mountWithIds();
      const onSendFailure = sendFailureListener(opts);

      capturedMessageListOpts!.onDeleteClick(5, true);
      const deleteId = ids().find((id) => id.endsWith("chat_delete"))!;
      vi.clearAllMocks();

      onSendFailure(deleteId, "OFFLINE");

      expect(opts.showToast).toHaveBeenCalledTimes(1);
      expect(opts.showToast).toHaveBeenCalledWith(expect.stringContaining("delete"), "error");
      ctrl.destroyChannel();
    });

    it("reports one edit error and restores the text when the socket drops mid-frame", async () => {
      const { opts, ctrl } = mountEditable();
      const onState = stateListener(opts);

      capturedMessageListOpts!.onEditSave(5, "new content");
      vi.clearAllMocks();

      // A half-open socket accepts the frame into its buffer, then the link
      // drops: the frame can never be echoed.
      onState("reconnecting");

      await expectEditRestoredWithToast(opts, "new content");
      ctrl.destroyChannel();
    });

    it("restores the newest of several edits lost when the socket drops", async () => {
      const { opts, ctrl } = mountEditable();
      const onState = stateListener(opts);

      capturedMessageListOpts!.onEditSave(5, "fix typo");
      capturedMessageListOpts!.onEditSave(5, "fix typo properly");
      vi.clearAllMocks();

      onState("reconnecting");
      await new Promise((r) => setTimeout(r, 0));

      expect(mockStartEdit).toHaveBeenCalledTimes(1);
      expect(mockStartEdit).toHaveBeenCalledWith(5, "fix typo properly", { focus: true });
      expect(opts.showToast).toHaveBeenCalledTimes(1);
      expect(opts.showToast).toHaveBeenCalledWith(
        messagingText("toast.editFailedRestored"),
        "error",
      );
      ctrl.destroyChannel();
    });

    it("a failed edit that lands while the composer holds a draft restores quietly, without focus", async () => {
      const { opts, ctrl, fail } = saveEditThenCapture("new content");
      // The user has since started typing in the composer.
      mockIsIdle.mockReturnValue(false);

      fail("NETWORK");

      await vi.waitFor(() =>
        expect(mockStartEdit).toHaveBeenCalledWith(5, "new content", { focus: false }),
      );
      expect(opts.showToast).toHaveBeenCalledWith(
        messagingText("toast.editFailedRestored"),
        "error",
      );
      ctrl.destroyChannel();
    });

    it("a failed edit that lands while another text field has focus restores without focus", async () => {
      const { ctrl, fail } = saveEditThenCapture("new content");
      const search = document.createElement("input");
      document.body.appendChild(search);
      search.focus();

      fail("NETWORK");

      await vi.waitFor(() =>
        expect(mockStartEdit).toHaveBeenCalledWith(5, "new content", { focus: false }),
      );
      search.remove();
      ctrl.destroyChannel();
    });

    it("a quick refusal reopens the editor with focus when focus is on the idle composer", async () => {
      const { ctrl, fail } = saveEditThenCapture("new content");
      const composer = document.createElement("textarea");
      composer.className = "msg-textarea";
      document.body.appendChild(composer);
      composer.focus();

      fail("NETWORK");

      await vi.waitFor(() =>
        expect(mockStartEdit).toHaveBeenCalledWith(5, "new content", { focus: true }),
      );
      composer.remove();
      ctrl.destroyChannel();
    });

    it(
      "drops an unechoed edit and delete silently after the expiry, so a later drop shows no error",
      fakeTimersTest(async () => {
        const { opts, ctrl } = mountEditable();
        capturedMessageListOpts!.onEditSave(5, "new content");
        capturedMessageListOpts!.onDeleteClick(6, true);

        // The user moves on; the server unsubscribes channel 42's topic
        // before the echoes are delivered, so none ever arrives.
        ctrl.mountChannel(43, "random");
        vi.advanceTimersByTime(90_000);
        vi.clearAllMocks();

        ctrl.mountChannel(42, "general");
        const onState = stateListener(opts);
        onState("reconnecting");
        await vi.runAllTimersAsync();

        expect(opts.showToast).not.toHaveBeenCalled();
        expect(mockStartEdit).not.toHaveBeenCalled();
        ctrl.destroyChannel();
      }),
    );

    it("keeps another edit the user opened when a failed edit comes back late", async () => {
      const { opts, ctrl } = mountEditable();
      const onState = stateListener(opts);

      capturedMessageListOpts!.onEditSave(5, "new content");
      vi.clearAllMocks();
      mockIsEditing.mockReturnValue(true);

      onState("reconnecting");
      await new Promise((r) => setTimeout(r, 0));

      expect(opts.showToast).toHaveBeenCalledTimes(1);
      expect(opts.showToast).toHaveBeenCalledWith(messagingText("toast.editFailed"), "error");
      expect(mockStartEdit).not.toHaveBeenCalled();
      ctrl.destroyChannel();
    });

    it("does not toast success and resolves the entry when the edit echo arrives", () => {
      const { opts, ctrl, ids } = mountEditable();
      const onSendFailure = sendFailureListener(opts);
      const onEdited = echoListener(opts, "chat_edited");

      capturedMessageListOpts!.onEditSave(5, "new content");
      const editId = ids().find((id) => id.endsWith("chat_edit"))!;

      // The frame is echoed back: the tracker must drop it so a later error
      // carrying a reused id cannot be misattributed to this edit.
      onEdited({ message_id: 5, channel_id: 42 });
      vi.clearAllMocks();
      onSendFailure(editId, "NETWORK");

      expect(opts.showToast).not.toHaveBeenCalled();
      expect(mockStartEdit).not.toHaveBeenCalled();
      ctrl.destroyChannel();
    });
  });
});
