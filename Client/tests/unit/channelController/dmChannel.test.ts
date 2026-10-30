import { describe, it, expect, vi } from "vitest";
import * as mocks from "../../helpers/channelControllerMocks";
import { createChannelController } from "../../../src/pages/main-page/ChannelController";
import { channelsStore, setChannels, updateChannel } from "@stores/channels.store";
import { makeOpts, useChannelControllerHarness } from "../../helpers/channelControllerHarness";

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
vi.mock("@components/message-list/attachments", (importOriginal) =>
  mocks.listAttachmentsMock(importOriginal),
);
vi.mock("@stores/members.store", () => mocks.membersStoreMock());
vi.mock("@stores/blocks.store", () => mocks.blocksStoreMock());
vi.mock("../../../src/pages/main-page/ThreadPanelHost", () => mocks.pageThreadPanelHostMock());

const {
  mockSetDisabled,
  mockUpdateChatHeaderForDm,
  mockDmStoreGetState,
  mockMembersStoreGetState,
  dmStoreSubscribers,
  membersStoreSubscribers,
  fetchImageAsObjectUrl,
  mockDmComposerBlockReason,
  blocksSubscribers,
} = mocks;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createChannelController", () => {
  useChannelControllerHarness();

  describe("DM channel header", () => {
    it("updates chat header for DM channel with recipient status", () => {
      mockDmStoreGetState.mockReturnValue({
        channels: [
          {
            channelId: 42,
            recipient: { id: 5, username: "alice", avatar: "", status: "online" },
            participants: [{ id: 5, username: "alice", avatar: "", status: "online" }],
            name: "",
            isGroup: false,
            lastMessageId: null,
            lastMessage: "",
            lastMessageAt: "",
            unreadCount: 0,
          },
        ],
      });
      mockMembersStoreGetState.mockReturnValue({
        members: new Map([[5, { id: 5, username: "alice", status: "idle" }]]),
      });

      const chatHeaderRefs = {
        hashEl: document.createElement("span"),
        nameEl: document.createElement("span"),
        topicEl: document.createElement("span"),
        callBtn: document.createElement("button"),
        videoCallBtn: document.createElement("button"),
        profileBtn: document.createElement("button"),
        membersBtn: document.createElement("button"),
        memberListBtn: document.createElement("button"),
        callChatBtn: document.createElement("button"),
        avatarEl: document.createElement("span"),
        sidebarToggle: document.createElement("button"),
        nameGroupEl: document.createElement("div"),
      };
      const opts = makeOpts({ chatHeaderRefs });
      const ctrl = createChannelController(opts);

      ctrl.mountChannel(42, "alice", "dm");

      // Should use member status ("idle") over DM recipient status ("online")
      expect(mockUpdateChatHeaderForDm).toHaveBeenCalledWith(
        chatHeaderRefs,
        expect.objectContaining({ username: "alice", status: "Idle", isGroup: false }),
      );
    });

    it("uses DM recipient status when member not found in members store", () => {
      mockDmStoreGetState.mockReturnValue({
        channels: [
          {
            channelId: 42,
            recipient: { id: 5, username: "bob", avatar: "", status: "dnd" },
            participants: [{ id: 5, username: "bob", avatar: "", status: "dnd" }],
            name: "",
            isGroup: false,
            lastMessageId: null,
            lastMessage: "",
            lastMessageAt: "",
            unreadCount: 0,
          },
        ],
      });
      mockMembersStoreGetState.mockReturnValue({
        members: new Map(),
      });

      const chatHeaderRefs = {
        hashEl: document.createElement("span"),
        nameEl: document.createElement("span"),
        topicEl: document.createElement("span"),
        callBtn: document.createElement("button"),
        videoCallBtn: document.createElement("button"),
        profileBtn: document.createElement("button"),
        membersBtn: document.createElement("button"),
        memberListBtn: document.createElement("button"),
        callChatBtn: document.createElement("button"),
        avatarEl: document.createElement("span"),
        sidebarToggle: document.createElement("button"),
        nameGroupEl: document.createElement("div"),
      };
      const opts = makeOpts({ chatHeaderRefs });
      const ctrl = createChannelController(opts);

      ctrl.mountChannel(42, "bob", "dm");

      expect(mockUpdateChatHeaderForDm).toHaveBeenCalledWith(
        chatHeaderRefs,
        expect.objectContaining({ username: "bob", status: "Do Not Disturb" }),
      );
    });

    it("hands the header the partner's avatar for a 1:1 and the face stack for a group", () => {
      const user = (id: number, username: string) => ({
        id,
        username,
        avatar: "",
        status: "online",
      });
      const dm = (
        isGroup: boolean,
        participants: [ReturnType<typeof user>, ...ReturnType<typeof user>[]],
      ) => ({
        channelId: 42,
        recipient: participants[0],
        participants,
        name: isGroup ? "Crew" : "",
        isGroup,
        lastMessageId: null,
        lastMessage: "",
        lastMessageAt: "",
        unreadCount: 0,
      });
      mockMembersStoreGetState.mockReturnValue({ members: new Map() });
      const chatHeaderRefs = {
        hashEl: document.createElement("span"),
        nameEl: document.createElement("span"),
        topicEl: document.createElement("span"),
        callBtn: document.createElement("button"),
        videoCallBtn: document.createElement("button"),
        profileBtn: document.createElement("button"),
        membersBtn: document.createElement("button"),
        memberListBtn: document.createElement("button"),
        callChatBtn: document.createElement("button"),
        avatarEl: document.createElement("span"),
        sidebarToggle: document.createElement("button"),
        nameGroupEl: document.createElement("div"),
      };

      mockDmStoreGetState.mockReturnValue({ channels: [dm(false, [user(5, "alice")])] });
      createChannelController(makeOpts({ chatHeaderRefs })).mountChannel(42, "alice", "dm");
      const one = mockUpdateChatHeaderForDm.mock.calls.at(-1)![1] as {
        avatar: HTMLElement;
        isGroup: boolean;
      };
      expect(one.isGroup).toBe(false);
      expect(one.avatar.querySelector(".avatar-initial")?.textContent).toBe("A");

      mockDmStoreGetState.mockReturnValue({
        channels: [dm(true, [user(5, "alice"), user(6, "bob"), user(7, "cy")])],
      });
      createChannelController(makeOpts({ chatHeaderRefs })).mountChannel(42, "Crew", "dm");
      const group = mockUpdateChatHeaderForDm.mock.calls.at(-1)![1] as {
        avatar: HTMLElement;
        isGroup: boolean;
      };
      expect(group.isGroup).toBe(true);
      expect(group.avatar.classList.contains("dm-avatar-stack")).toBe(true);
      expect(group.avatar.querySelectorAll(".dm-avatar-face")).toHaveLength(2);
      expect(group.avatar.dataset["testid"]).toBe("ch-avatar-stack");
      expect(group.avatar.getAttribute("aria-hidden")).toBe("true");
    });

    it("falls back to 'Offline' when DM channel not found in dmStore", () => {
      mockDmStoreGetState.mockReturnValue({ channels: [] });

      const chatHeaderRefs = {
        hashEl: document.createElement("span"),
        nameEl: document.createElement("span"),
        topicEl: document.createElement("span"),
        callBtn: document.createElement("button"),
        videoCallBtn: document.createElement("button"),
        profileBtn: document.createElement("button"),
        membersBtn: document.createElement("button"),
        memberListBtn: document.createElement("button"),
        callChatBtn: document.createElement("button"),
        avatarEl: document.createElement("span"),
        sidebarToggle: document.createElement("button"),
        nameGroupEl: document.createElement("div"),
      };
      const opts = makeOpts({ chatHeaderRefs });
      const ctrl = createChannelController(opts);

      ctrl.mountChannel(42, "unknown", "dm");

      expect(mockUpdateChatHeaderForDm).toHaveBeenCalledWith(
        chatHeaderRefs,
        expect.objectContaining({
          username: "unknown",
          status: "Offline",
        }),
      );
    });

    it("keeps the DM header subtitle live when the partner's presence changes", () => {
      mockDmStoreGetState.mockReturnValue({
        channels: [
          {
            channelId: 42,
            recipient: { id: 5, username: "alice", avatar: "", status: "offline" },
            participants: [{ id: 5, username: "alice", avatar: "", status: "offline" }],
            name: "",
            isGroup: false,
            lastMessageId: null,
            lastMessage: "",
            lastMessageAt: "",
            unreadCount: 0,
          },
        ],
      });
      mockMembersStoreGetState.mockReturnValue({ members: new Map() });

      const chatHeaderRefs = {
        hashEl: document.createElement("span"),
        nameEl: document.createElement("span"),
        topicEl: document.createElement("span"),
        callBtn: document.createElement("button"),
        videoCallBtn: document.createElement("button"),
        profileBtn: document.createElement("button"),
        membersBtn: document.createElement("button"),
        memberListBtn: document.createElement("button"),
        callChatBtn: document.createElement("button"),
        avatarEl: document.createElement("span"),
        sidebarToggle: document.createElement("button"),
        nameGroupEl: document.createElement("div"),
      };
      const opts = makeOpts({ chatHeaderRefs });
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "alice", "dm");

      expect(mockUpdateChatHeaderForDm).toHaveBeenLastCalledWith(
        chatHeaderRefs,
        expect.objectContaining({
          username: "alice",
          status: "Offline",
        }),
      );

      // The partner comes online — no re-mount, just a members store update.
      mockMembersStoreGetState.mockReturnValue({
        members: new Map([[5, { id: 5, username: "alice", status: "online" }]]),
      });
      for (const cb of membersStoreSubscribers) cb();

      expect(mockUpdateChatHeaderForDm).toHaveBeenLastCalledWith(
        chatHeaderRefs,
        expect.objectContaining({
          username: "alice",
          status: "Online",
        }),
      );
    });

    it("keeps a group DM header live when the roster changes", () => {
      const dmChannel = {
        channelId: 42,
        recipient: { id: 5, username: "alice", avatar: "", status: "online" },
        participants: [{ id: 5, username: "alice", avatar: "", status: "online" }],
        name: "",
        isGroup: true,
        lastMessageId: null,
        lastMessage: "",
        lastMessageAt: "",
        unreadCount: 0,
      };
      mockDmStoreGetState.mockReturnValue({ channels: [dmChannel] });

      const chatHeaderRefs = {
        hashEl: document.createElement("span"),
        nameEl: document.createElement("span"),
        topicEl: document.createElement("span"),
        callBtn: document.createElement("button"),
        videoCallBtn: document.createElement("button"),
        profileBtn: document.createElement("button"),
        membersBtn: document.createElement("button"),
        memberListBtn: document.createElement("button"),
        callChatBtn: document.createElement("button"),
        avatarEl: document.createElement("span"),
        sidebarToggle: document.createElement("button"),
        nameGroupEl: document.createElement("div"),
      };
      const opts = makeOpts({ chatHeaderRefs });
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "Group", "dm");

      expect(mockUpdateChatHeaderForDm).toHaveBeenLastCalledWith(
        chatHeaderRefs,
        expect.objectContaining({ status: "2 members: You, alice" }),
      );

      // Someone else joins the group — no re-mount, just a dm store update.
      mockDmStoreGetState.mockReturnValue({
        channels: [
          {
            ...dmChannel,
            participants: [
              { id: 5, username: "alice", avatar: "", status: "online" },
              { id: 6, username: "bob", avatar: "", status: "online" },
            ],
          },
        ],
      });
      for (const cb of dmStoreSubscribers) cb();

      expect(mockUpdateChatHeaderForDm).toHaveBeenLastCalledWith(
        chatHeaderRefs,
        expect.objectContaining({ status: "3 members: You, alice, bob" }),
      );
    });

    it("draws a group's icon in the header and redraws it when the summary's icon changes", async () => {
      fetchImageAsObjectUrl.mockImplementation(async (url: string) => `blob:${url}`);
      const user = (id: number, username: string) => ({
        id,
        username,
        avatar: "",
        status: "online",
      });
      const group = (icon: string) =>
        ({
          channelId: 42,
          recipient: user(5, "alice"),
          participants: [user(5, "alice"), user(6, "bob")],
          name: "Crew",
          isGroup: true,
          ownerId: 1,
          icon,
          lastMessageId: null,
          lastMessage: "",
          lastMessageAt: "",
          unreadCount: 0,
        }) as never;
      mockMembersStoreGetState.mockReturnValue({ members: new Map() });
      const chatHeaderRefs = {
        hashEl: document.createElement("span"),
        nameEl: document.createElement("span"),
        topicEl: document.createElement("span"),
        callBtn: document.createElement("button"),
        videoCallBtn: document.createElement("button"),
        profileBtn: document.createElement("button"),
        membersBtn: document.createElement("button"),
        avatarEl: document.createElement("span"),
        sidebarToggle: document.createElement("button"),
        nameGroupEl: document.createElement("div"),
        memberListBtn: document.createElement("button"),
        callChatBtn: document.createElement("button"),
      };
      const headerAvatar = (): HTMLElement =>
        (mockUpdateChatHeaderForDm.mock.calls.at(-1)![1] as { avatar: HTMLElement }).avatar;
      const flush = async (): Promise<void> => {
        await Promise.resolve();
        await Promise.resolve();
      };

      mockDmStoreGetState.mockReturnValue({ channels: [group("/api/v1/files/1")] });
      createChannelController(makeOpts({ chatHeaderRefs })).mountChannel(42, "Crew", "dm");
      const first = headerAvatar();
      await flush();
      expect(first.dataset["testid"]).toBe("ch-avatar-stack");
      expect(first.querySelector("img.dm-avatar-icon-img")?.getAttribute("src")).toContain(
        "/api/v1/files/1",
      );
      expect(first.querySelectorAll(".dm-avatar-face")).toHaveLength(0);

      // The icon is removed: the key changes, so the faces come back.
      mockDmStoreGetState.mockReturnValue({ channels: [group("")] });
      for (const cb of dmStoreSubscribers) cb();
      const cleared = headerAvatar();
      await flush();
      expect(cleared).not.toBe(first);
      expect(cleared.querySelector("img")).toBeNull();
      expect(cleared.querySelectorAll(".dm-avatar-face")).toHaveLength(2);

      // A different file is a different picture, not the cached element.
      mockDmStoreGetState.mockReturnValue({ channels: [group("/api/v1/files/2")] });
      for (const cb of dmStoreSubscribers) cb();
      const second = headerAvatar();
      await flush();
      expect(second).not.toBe(cleared);
      expect(second.querySelector("img.dm-avatar-icon-img")?.getAttribute("src")).toContain(
        "/api/v1/files/2",
      );
    });

    it("resets header for non-DM channel when chatHeaderRefs is provided", () => {
      const chatHeaderRefs = {
        hashEl: document.createElement("span"),
        nameEl: document.createElement("span"),
        topicEl: document.createElement("span"),
        callBtn: document.createElement("button"),
        videoCallBtn: document.createElement("button"),
        profileBtn: document.createElement("button"),
        membersBtn: document.createElement("button"),
        memberListBtn: document.createElement("button"),
        callChatBtn: document.createElement("button"),
        avatarEl: document.createElement("span"),
        sidebarToggle: document.createElement("button"),
        nameGroupEl: document.createElement("div"),
      };
      const opts = makeOpts({ chatHeaderRefs });
      const ctrl = createChannelController(opts);

      ctrl.mountChannel(42, "general", "text");

      expect(mockUpdateChatHeaderForDm).toHaveBeenCalledWith(chatHeaderRefs, null);
      expect(opts.chatHeaderName!.textContent).toBe("general");
    });

    it("only sets chatHeaderName when no chatHeaderRefs", () => {
      const opts = makeOpts({ chatHeaderRefs: null });
      const ctrl = createChannelController(opts);

      ctrl.mountChannel(42, "random");

      expect(opts.chatHeaderName!.textContent).toBe("random");
      expect(mockUpdateChatHeaderForDm).not.toHaveBeenCalled();
    });

    it("keeps the header name live when the channel is renamed mid-session (mirrors the topic subscription)", () => {
      setChannels([
        {
          id: 42,
          name: "general",
          type: "text",
          category: null,
          position: 0,
          can_send: true,
          nsfw: false,
        },
      ]);
      const chatHeaderRefs = {
        hashEl: document.createElement("span"),
        nameEl: document.createElement("span"),
        topicEl: document.createElement("span"),
        callBtn: document.createElement("button"),
        videoCallBtn: document.createElement("button"),
        profileBtn: document.createElement("button"),
        membersBtn: document.createElement("button"),
        memberListBtn: document.createElement("button"),
        callChatBtn: document.createElement("button"),
        avatarEl: document.createElement("span"),
        sidebarToggle: document.createElement("button"),
        nameGroupEl: document.createElement("div"),
      };
      const opts = makeOpts({ chatHeaderRefs });
      const ctrl = createChannelController(opts);

      ctrl.mountChannel(42, "general", "text");
      expect(opts.chatHeaderName!.textContent).toBe("general");

      updateChannel({ id: 42, name: "renamed" });
      channelsStore.flush();

      expect(opts.chatHeaderName!.textContent).toBe("renamed");
    });
  });

  describe("DM composer block gating", () => {
    function mountDm(reason: string | null): void {
      mockDmStoreGetState.mockReturnValue({
        channels: [
          {
            channelId: 42,
            recipient: { id: 5, username: "alice", avatar: "", status: "online" },
            participants: [{ id: 5, username: "alice", avatar: "", status: "online" }],
            name: "",
            isGroup: false,
            lastMessageId: null,
            lastMessage: "",
            lastMessageAt: "",
            unreadCount: 0,
          },
        ],
      });
      mockDmComposerBlockReason.mockReturnValue(reason);
      const ctrl = createChannelController(makeOpts());
      ctrl.mountChannel(42, "alice", "dm");
    }

    it("disables the DM composer with the explicit reason when the user blocked them", () => {
      mountDm("You've blocked this user. Unblock to send messages.");
      expect(mockSetDisabled).toHaveBeenLastCalledWith(
        "You've blocked this user. Unblock to send messages.",
      );
    });

    it("disables the DM composer with the neutral reason when being blocked", () => {
      mountDm("You can't message this user right now.");
      expect(mockSetDisabled).toHaveBeenLastCalledWith("You can't message this user right now.");
    });

    it("leaves the DM composer enabled when not blocked", () => {
      mountDm(null);
      expect(mockSetDisabled).toHaveBeenLastCalledWith(null);
    });

    it("un-gates live when the block clears (unblock)", () => {
      mountDm("You've blocked this user. Unblock to send messages.");
      expect(mockSetDisabled).toHaveBeenLastCalledWith(
        "You've blocked this user. Unblock to send messages.",
      );
      // Simulate an unblock: the store reports no reason and notifies subscribers.
      mockDmComposerBlockReason.mockReturnValue(null);
      for (const cb of blocksSubscribers) cb();
      expect(mockSetDisabled).toHaveBeenLastCalledWith(null);
    });

    it("does not subscribe to block state for non-DM channels", () => {
      const ctrl = createChannelController(makeOpts());
      ctrl.mountChannel(42, "general", "text");
      expect(blocksSubscribers).toHaveLength(0);
    });

    // Discord semantics, mirrored by the server's requireDMNotBlocked: a group
    // DM is a shared room, and gating one member's composer over a block with
    // one other member would leave the group reading a conversation that person
    // cannot join. Blocks are enforced when the group is created instead.
    it("does not gate a group DM's composer on block state", () => {
      mockDmStoreGetState.mockReturnValue({
        channels: [
          {
            channelId: 42,
            recipient: { id: 5, username: "alice", avatar: "", status: "online" },
            participants: [
              { id: 5, username: "alice", avatar: "", status: "online" },
              { id: 6, username: "bob", avatar: "", status: "online" },
            ],
            name: "Crew",
            isGroup: true,
            lastMessageId: null,
            lastMessage: "",
            lastMessageAt: "",
            unreadCount: 0,
          },
        ],
      });
      mockDmComposerBlockReason.mockReturnValue("You've blocked this user.");

      const ctrl = createChannelController(makeOpts());
      ctrl.mountChannel(42, "Crew", "dm");

      expect(mockSetDisabled).toHaveBeenLastCalledWith(null);
      expect(blocksSubscribers).toHaveLength(0);
    });
  });
});
