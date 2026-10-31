import { describe, it, expect, vi, beforeEach } from "vitest";
import * as mocks from "../../helpers/channelControllerMocks";
import { createChannelController } from "../../../src/pages/main-page/ChannelController";
import type { ChannelControllerOptions } from "../../../src/pages/main-page/ChannelController";
import { Disposable } from "@lib/disposable";
import { loadSavedDraft, saveDraft } from "@lib/prefs/savedDrafts";
import {
  capturedMessageListOpts,
  capturedMessageInputOpts,
} from "../../helpers/channelControllerMocks";
import {
  makeOpts,
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

const {
  mockGetChannelMessages,
  mockCancelEdit,
  mockInputFocus,
  mockGetDraft,
  mockRestoreDraft,
  mockPeekDraft,
} = mocks;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createChannelController", () => {
  useChannelControllerHarness();

  describe("per-channel composer drafts", () => {
    it("captures the outgoing channel's draft before destroying it", () => {
      const opts = makeOpts();
      mockGetDraft.mockReturnValue({
        content: "kept draft",
        replyTo: { messageId: 7, username: "alice" },
        attachments: [{ id: "srv-1", filename: "a.png" }],
      });
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      ctrl.mountChannel(99, "random");

      expect(mockGetDraft).toHaveBeenCalled();
      expect(mockRestoreDraft).not.toHaveBeenCalledWith(
        expect.objectContaining({ content: "kept draft" }),
      );
    });

    it("restores a channel's draft when the user returns to it", () => {
      const opts = makeOpts();
      mockGetDraft.mockReturnValue({
        content: "",
        replyTo: null,
        attachments: [],
      });
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      // Capture a real draft for channel 42 while it is mounted.
      mockGetDraft.mockReturnValue({
        content: "back later",
        replyTo: null,
        attachments: [{ id: "srv-2", filename: "b.pdf" }],
      });
      ctrl.mountChannel(99, "random");
      mockGetDraft.mockReturnValue({ content: "", replyTo: null, attachments: [] });
      ctrl.mountChannel(42, "general");

      expect(mockRestoreDraft).toHaveBeenCalledWith({
        content: "back later",
        replyTo: null,
        attachments: [{ id: "srv-2", filename: "b.pdf" }],
      });
    });

    it("keeps a draft that holds only an upload still in flight", () => {
      const opts = makeOpts();
      const owner = new Disposable();
      const upload = { filename: "big.zip", owner };
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      mockGetDraft.mockReturnValue({
        content: "",
        replyTo: null,
        attachments: [],
        uploads: [upload],
      });
      ctrl.mountChannel(99, "random");
      mockGetDraft.mockReturnValue({ content: "", replyTo: null, attachments: [] });
      ctrl.mountChannel(42, "general");

      expect(mockRestoreDraft).toHaveBeenCalledWith(expect.objectContaining({ uploads: [upload] }));
      expect(owner.signal.aborted).toBe(false);
    });

    it("cancels uploads left in stashed drafts when the controller is destroyed", () => {
      const opts = makeOpts();
      const owner = new Disposable();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");
      mockGetDraft.mockReturnValue({
        content: "",
        replyTo: null,
        attachments: [],
        uploads: [{ filename: "big.zip", owner }],
      });
      ctrl.mountChannel(99, "random");
      mockGetDraft.mockReturnValue({ content: "", replyTo: null, attachments: [] });

      ctrl.destroy();

      expect(owner.signal.aborted).toBe(true);
    });

    it("does not restore a draft into a channel with none", () => {
      const opts = makeOpts();
      mockGetDraft.mockReturnValue({ content: "", replyTo: null, attachments: [] });
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");
      mockRestoreDraft.mockClear();

      ctrl.mountChannel(99, "random");

      expect(mockRestoreDraft).not.toHaveBeenCalled();
    });

    it("drops a restored reply target that no longer exists", () => {
      const { ctrl } = mountController();

      mockGetDraft.mockReturnValue({
        content: "reply draft",
        replyTo: { messageId: 7, username: "alice" },
        attachments: [],
      });
      ctrl.mountChannel(99, "random");
      // Returning to 42: its messages are gone (deleted elsewhere) — the reply
      // survives as text but the dangling target is dropped.
      mockGetChannelMessages.mockReturnValue([]);
      mockGetDraft.mockReturnValue({ content: "", replyTo: null, attachments: [] });
      ctrl.mountChannel(42, "general");

      expect(mockRestoreDraft).toHaveBeenCalledWith(
        expect.objectContaining({ content: "reply draft", replyTo: null }),
      );
    });

    it("does not carry a draft across two channels into a third", () => {
      const opts = makeOpts();
      const ctrl = createChannelController(opts);

      mockGetDraft.mockReturnValue({ content: "for 42", replyTo: null, attachments: [] });
      ctrl.mountChannel(42, "general");
      mockGetDraft.mockReturnValue({ content: "for 99", replyTo: null, attachments: [] });
      ctrl.mountChannel(99, "random");
      mockRestoreDraft.mockClear();
      mockGetDraft.mockReturnValue({ content: "", replyTo: null, attachments: [] });
      ctrl.mountChannel(7, "other");

      expect(mockRestoreDraft).not.toHaveBeenCalledWith(
        expect.objectContaining({ content: "for 42" }),
      );
    });

    it("restores the pre-edit draft after a channel switch mid-edit", () => {
      const { ctrl } = mountController();

      // While an edit is in progress the composer reports the draft the edit
      // displaced (not the edit text), so switching away and back keeps it.
      mockGetDraft.mockReturnValue({
        content: "pre-edit draft",
        replyTo: { messageId: 7, username: "alice" },
        attachments: [],
      });
      ctrl.mountChannel(99, "random");
      mockGetDraft.mockReturnValue({ content: "", replyTo: null, attachments: [] });
      mockGetChannelMessages.mockReturnValue([{ id: 7, content: "original" }]);
      ctrl.mountChannel(42, "general");

      expect(mockRestoreDraft).toHaveBeenCalledWith({
        content: "pre-edit draft",
        replyTo: { messageId: 7, username: "alice" },
        attachments: [],
      });
    });
  });

  describe("drafts survive a restart (3A-3)", () => {
    const withHost = (): ChannelControllerOptions => {
      const opts = makeOpts();
      Object.assign(opts.api, { getConfig: () => ({ host: "chat.example", token: "token" }) });
      return opts;
    };
    beforeEach(() => localStorage.clear());

    it("restores a saved draft on a fresh start, with its reply", () => {
      saveDraft("chat.example", 1, 42, {
        content: "from yesterday",
        replyTo: { messageId: 7, username: "alice" },
      });
      const ctrl = createChannelController(withHost());
      ctrl.mountChannel(42, "general");
      expect(mockRestoreDraft).toHaveBeenCalledWith({
        content: "from yesterday",
        replyTo: { messageId: 7, username: "alice" },
        attachments: [],
      });
      ctrl.destroy();
    });

    it("drops the saved reply when loaded history shows its message deleted", () => {
      saveDraft("chat.example", 1, 42, {
        content: "x",
        replyTo: { messageId: 7, username: "alice" },
      });
      mockGetChannelMessages.mockReturnValue([{ id: 7, deleted: true }]);
      const ctrl = createChannelController(withHost());
      ctrl.mountChannel(42, "general");
      expect(mockRestoreDraft).toHaveBeenCalledWith({
        content: "x",
        replyTo: null,
        attachments: [],
      });
      ctrl.destroy();
    });

    it("saves the composer's text when typing pauses, and removes it once empty", () => {
      vi.useFakeTimers();
      try {
        const ctrl = createChannelController(withHost());
        ctrl.mountChannel(42, "general");
        mockPeekDraft.mockReturnValue({ content: "typing…", replyTo: null });
        capturedMessageInputOpts!.onDraftChange();
        expect(loadSavedDraft("chat.example", 1, 42)).toBeNull();
        vi.advanceTimersByTime(750);
        expect(loadSavedDraft("chat.example", 1, 42)?.content).toBe("typing…");

        mockPeekDraft.mockReturnValue({ content: "", replyTo: null });
        capturedMessageInputOpts!.onDraftChange();
        expect(loadSavedDraft("chat.example", 1, 42)).toBeNull();
        ctrl.destroy();
      } finally {
        mockPeekDraft.mockReturnValue({ content: "", replyTo: null });
        vi.useRealTimers();
      }
    });

    it("saves straight away on a channel switch, to the channel it was typed in", () => {
      vi.useFakeTimers();
      try {
        const ctrl = createChannelController(withHost());
        ctrl.mountChannel(42, "general");
        // Once for the change, once for the save on the switch; the new
        // channel's composer starts empty.
        mockPeekDraft
          .mockReturnValueOnce({ content: "unsent", replyTo: null })
          .mockReturnValueOnce({ content: "unsent", replyTo: null });
        capturedMessageInputOpts!.onDraftChange();
        ctrl.mountChannel(99, "random");
        expect(loadSavedDraft("chat.example", 1, 42)?.content).toBe("unsent");
        expect(loadSavedDraft("chat.example", 1, 99)).toBeNull();
        vi.advanceTimersByTime(1000);
        expect(loadSavedDraft("chat.example", 1, 99)).toBeNull();
        ctrl.destroy();
      } finally {
        mockPeekDraft.mockReturnValue({ content: "", replyTo: null });
        vi.useRealTimers();
      }
    });
  });

  describe("draft saves stay with their account (3A-3)", () => {
    beforeEach(() => localStorage.clear());

    it("skips a save once a different account is signed in", () => {
      vi.useFakeTimers();
      let userId = 1;
      try {
        const opts = makeOpts({ getCurrentUserId: () => userId });
        Object.assign(opts.api, { getConfig: () => ({ host: "chat.example", token: "token" }) });
        const ctrl = createChannelController(opts);
        ctrl.mountChannel(42, "general");
        mockPeekDraft.mockReturnValue({ content: "mine", replyTo: null });
        capturedMessageInputOpts!.onDraftChange();
        userId = 2;
        vi.advanceTimersByTime(750);
        expect(loadSavedDraft("chat.example", 1, 42)).toBeNull();
        expect(loadSavedDraft("chat.example", 2, 42)).toBeNull();
        ctrl.destroy();
      } finally {
        mockPeekDraft.mockReturnValue({ content: "", replyTo: null });
        vi.useRealTimers();
      }
    });

    it("writes a restored draft back without the reply it dropped", () => {
      vi.useFakeTimers();
      try {
        const opts = makeOpts();
        Object.assign(opts.api, { getConfig: () => ({ host: "chat.example", token: "token" }) });
        saveDraft("chat.example", 1, 42, {
          content: "x",
          replyTo: { messageId: 7, username: "alice" },
        });
        mockGetChannelMessages.mockReturnValue([{ id: 7, deleted: true }]);
        mockPeekDraft.mockReturnValue({ content: "x", replyTo: null });
        const ctrl = createChannelController(opts);
        ctrl.mountChannel(42, "general");
        vi.advanceTimersByTime(750);
        expect(loadSavedDraft("chat.example", 1, 42)).toEqual({ content: "x", replyTo: null });
        ctrl.destroy();
      } finally {
        mockPeekDraft.mockReturnValue({ content: "", replyTo: null });
        vi.useRealTimers();
      }
    });
  });

  describe("delete confirm preview and Shift tip (3A-4)", () => {
    function previewEl(): HTMLElement | null {
      return document.querySelector("[data-testid='msg-delete-preview']");
    }

    it("shows the author and text of the message, plus the Shift tip", () => {
      mockGetChannelMessages.mockReturnValue([
        { id: 5, content: "see you **soon**", user: { id: 2, username: "bob" }, attachments: [] },
      ]);
      const ctrl = createChannelController(makeOpts());
      ctrl.mountChannel(42, "general");

      capturedMessageListOpts!.onDeleteClick(5, false);

      expect(previewEl()?.textContent).toContain("bob");
      expect(previewEl()?.textContent).toContain("see you soon");
      expect(document.querySelector("[data-testid='msg-delete-tip']")?.textContent).toBe(
        "Tip: hold Shift when you click Delete to skip this.",
      );
      document.querySelector<HTMLButtonElement>("[data-testid='msg-delete-cancel']")!.click();
      ctrl.destroyChannel();
    });

    it("truncates a long message and sets markup as text, never HTML", () => {
      mockGetChannelMessages.mockReturnValue([
        {
          id: 5,
          content: `<img src=x onerror=alert(1)>${"a".repeat(400)}`,
          user: { id: 2, username: "bob" },
          attachments: [],
        },
      ]);
      const ctrl = createChannelController(makeOpts());
      ctrl.mountChannel(42, "general");

      capturedMessageListOpts!.onDeleteClick(5, false);

      expect(previewEl()?.querySelector("img")).toBeNull();
      const text = previewEl()?.querySelector(".msg-delete-preview-text")?.textContent ?? "";
      expect(text.startsWith("<img src=x onerror=alert(1)>")).toBe(true);
      expect(text.endsWith("\u2026")).toBe(true);
      expect(Array.from(text).length).toBeLessThanOrEqual(201);
      document.querySelector<HTMLButtonElement>("[data-testid='msg-delete-cancel']")!.click();
      ctrl.destroyChannel();
    });

    it("labels an attachments-only message instead of leaving the preview blank", () => {
      mockGetChannelMessages.mockReturnValue([
        {
          id: 5,
          content: "",
          user: { id: 2, username: "bob" },
          attachments: [{ id: "a1" }],
        },
      ]);
      const ctrl = createChannelController(makeOpts());
      ctrl.mountChannel(42, "general");

      capturedMessageListOpts!.onDeleteClick(5, false);

      expect(previewEl()?.querySelector(".msg-delete-preview-text")?.textContent).toBe(
        "Attachment",
      );
      document.querySelector<HTMLButtonElement>("[data-testid='msg-delete-cancel']")!.click();
      ctrl.destroyChannel();
    });

    it("still opens, with the tip and no preview, when the message is not in the window", () => {
      mockGetChannelMessages.mockReturnValue([]);
      const ctrl = createChannelController(makeOpts());
      ctrl.mountChannel(42, "general");

      capturedMessageListOpts!.onDeleteClick(99, false);

      expect(document.querySelector("[data-testid='msg-delete-modal']")).not.toBeNull();
      expect(previewEl()).toBeNull();
      expect(document.querySelector("[data-testid='msg-delete-tip']")).not.toBeNull();
      document.querySelector<HTMLButtonElement>("[data-testid='msg-delete-cancel']")!.click();
      ctrl.destroyChannel();
    });

    it("the empty-edit confirm shows the preview too", () => {
      mockGetChannelMessages.mockReturnValue([
        { id: 5, content: "mine", user: { id: 1, username: "me" }, attachments: [] },
      ]);
      const ctrl = createChannelController(makeOpts());
      ctrl.mountChannel(42, "general");

      capturedMessageListOpts!.onEmptyEdit(5);

      expect(previewEl()?.textContent).toContain("mine");
      // No click opened this, so the Shift tip does not apply.
      expect(document.querySelector("[data-testid='msg-delete-tip']")).toBeNull();
      document.querySelector<HTMLButtonElement>("[data-testid='msg-delete-cancel']")!.click();
      ctrl.destroyChannel();
    });
  });

  describe("empty edit offers delete (3A-3)", () => {
    it("opens the delete confirm; Delete closes the edit and sends the delete", () => {
      mockGetChannelMessages.mockReturnValue([
        { id: 5, content: "mine", user: { id: 1, username: "me" } },
      ]);
      const { opts, ctrl } = mountController();

      capturedMessageListOpts!.onEmptyEdit(5);
      expect(document.querySelector("[data-testid='msg-delete-modal']")).not.toBeNull();
      expect(mockCancelEdit).not.toHaveBeenCalled();

      mockInputFocus.mockClear();
      (document.querySelector("[data-testid='msg-delete-confirm']") as HTMLButtonElement).click();
      expect(mockCancelEdit).toHaveBeenCalledTimes(1);
      // The modal gave focus back to the editor that just went away.
      expect(mockInputFocus).toHaveBeenCalledTimes(1);
      const deletes = (opts.ws.send as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([f]) => (f as { type: string }).type === "chat_delete",
      );
      expect(deletes).toHaveLength(1);
      ctrl.destroyChannel();
    });

    it("Cancel leaves the edit open and deletes nothing", () => {
      const { opts, ctrl } = mountController();
      capturedMessageListOpts!.onEmptyEdit(5);
      (document.querySelector("[data-testid='msg-delete-cancel']") as HTMLButtonElement).click();
      expect(mockCancelEdit).not.toHaveBeenCalled();
      expect(
        (opts.ws.send as ReturnType<typeof vi.fn>).mock.calls.some(
          ([f]) => (f as { type: string }).type === "chat_delete",
        ),
      ).toBe(false);
      ctrl.destroyChannel();
    });
  });
});
