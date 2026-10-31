/**
 * 3A-13: Delete, Pin and React follow the server's per-channel verdicts
 * (can_delete_others, can_pin, can_react), falling back to the role's
 * MANAGE_MESSAGES (delete, pin) or "allowed" (react) when an older server
 * sends none.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMessageList } from "@components/MessageList";
import type { MessageListOptions } from "@components/MessageList";
import { channelBitOrRole } from "@lib/permissions";
import { Permission } from "@lib/types";
import { authStore } from "@stores/auth.store";
import { addChannel, channelsStore, setChannels, setRoles } from "@stores/channels.store";
import type { Message } from "@stores/messages.store";
import { messagesStore } from "@stores/messages.store";
import { setConnectionStatus, uiStore } from "@stores/ui.store";
import { createReactionController } from "../../src/pages/main-page/ReactionController";
import { resetMessagesState } from "../helpers/storeResets";
import "../helpers/resizeObserverStub";

const ME = 1;
const OTHER = 2;

function setRole(manage: boolean): void {
  setRoles([
    { id: 1, name: "member", color: null, permissions: manage ? Permission.MANAGE_MESSAGES : 0 },
  ]);
  authStore.setState(() => ({
    token: "t",
    user: { id: ME, username: "me", avatar: null, role: "member" },
    serverName: null,
    motd: null,
    isAuthenticated: true,
  }));
}

type Bits = { can_delete_others?: boolean; can_pin?: boolean; can_react?: boolean };

function setChannel(bits: Bits, type: "text" | "dm" = "text"): void {
  setChannels([{ id: 1, name: "general", type, category: "Text", position: 0, ...bits }]);
}

function msg(id: number, userId: number): Message {
  return {
    id,
    channelId: 1,
    user: { id: userId, username: userId === ME ? "me" : "bob", avatar: null },
    content: `m${id}`,
    replyTo: null,
    attachments: [],
    reactions: [{ emoji: "🔥", count: 1, me: false }],
    pinned: false,
    editedAt: null,
    deleted: false,
    timestamp: "2024-01-15T12:00:00Z",
    status: "sent",
    correlationId: null,
    errorCode: null,
  };
}

describe("channel permission bits (3A-13)", () => {
  let container: HTMLDivElement;
  let list: ReturnType<typeof createMessageList> | null = null;

  function mount(channelType: "text" | "dm" = "text"): void {
    const options: MessageListOptions = {
      channelId: 1,
      channelName: "general",
      channelType,
      currentUserId: ME,
      onScrollTop: vi.fn(),
      onReplyClick: vi.fn(),
      onEditClick: vi.fn(),
      onEditSave: vi.fn(() => true),
      onEmptyEdit: vi.fn(),
      onDeleteClick: vi.fn(),
      onReactionClick: vi.fn(),
      onPinClick: vi.fn(),
    };
    messagesStore.setState((prev) => {
      const next = new Map(prev.messagesByChannel);
      next.set(1, [msg(10, ME), msg(11, OTHER)]);
      return { ...prev, messagesByChannel: next };
    });
    list = createMessageList(options);
    list.mount(container);
  }

  const has = (testid: string): boolean =>
    container.querySelector(`[data-testid='${testid}']`) !== null;
  const reactBtn = (): HTMLElement =>
    container.querySelector<HTMLElement>("[data-testid='msg-react-11']")!;

  beforeEach(() => {
    channelsStore.setState(() => ({
      channels: new Map(),
      activeChannelId: null,
      roles: [],
      categories: [],
    }));
    resetMessagesState();
    setConnectionStatus("connected");
    uiStore.flush();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    list?.destroy?.();
    list = null;
    container.remove();
  });

  describe("store mapping", () => {
    it("maps the three bits from ready and leaves absent ones undefined", () => {
      setChannel({ can_delete_others: true, can_pin: false, can_react: true });
      const ch = channelsStore.getState().channels.get(1)!;
      expect([ch.canDeleteOthers, ch.canPin, ch.canReact]).toEqual([true, false, true]);
      setChannel({});
      const bare = channelsStore.getState().channels.get(1)!;
      expect([bare.canDeleteOthers, bare.canPin, bare.canReact]).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
    });

    it("channel_create keeps the existing verdicts when it omits the keys", () => {
      setChannel({ can_delete_others: false, can_pin: true, can_react: false });
      addChannel({ id: 1, name: "general", type: "text", category: "Text", position: 0 });
      const ch = channelsStore.getState().channels.get(1)!;
      expect([ch.canDeleteOthers, ch.canPin, ch.canReact]).toEqual([false, true, false]);
    });

    it("channel_create replaces the verdicts when it carries them", () => {
      setChannel({ can_delete_others: false, can_pin: true, can_react: false });
      addChannel({
        id: 1,
        name: "general",
        type: "text",
        category: "Text",
        position: 0,
        can_delete_others: true,
        can_pin: false,
        can_react: true,
      });
      const ch = channelsStore.getState().channels.get(1)!;
      expect([ch.canDeleteOthers, ch.canPin, ch.canReact]).toEqual([true, false, true]);
    });

    it("a brand-new channel_create without the keys stays unknown", () => {
      addChannel({ id: 1, name: "new", type: "text", category: "Text", position: 0 });
      expect(channelsStore.getState().channels.get(1)!.canPin).toBeUndefined();
    });
  });

  describe("channelBitOrRole", () => {
    it("uses the bit when present and the role when absent", () => {
      setRole(true);
      expect(channelBitOrRole(false)).toBe(false);
      expect(channelBitOrRole(undefined)).toBe(true);
      setRole(false);
      expect(channelBitOrRole(true)).toBe(true);
      expect(channelBitOrRole(undefined)).toBe(false);
    });
  });

  describe("delete", () => {
    it("shows delete on others' messages when can_delete_others is true without MANAGE_MESSAGES", () => {
      setRole(false);
      setChannel({ can_delete_others: true });
      mount();
      expect(has("msg-delete-11")).toBe(true);
    });

    it("hides delete on others' messages when can_delete_others is false despite MANAGE_MESSAGES", () => {
      setRole(true);
      setChannel({ can_delete_others: false });
      mount();
      expect(has("msg-delete-11")).toBe(false);
    });

    it("always shows delete on own messages", () => {
      setRole(false);
      setChannel({ can_delete_others: false });
      mount();
      expect(has("msg-delete-10")).toBe(true);
    });

    it("falls back to the role when the bit is absent", () => {
      setRole(true);
      setChannel({});
      mount();
      expect(has("msg-delete-11")).toBe(true);
      list?.destroy?.();
      container.replaceChildren();
      setRole(false);
      mount();
      expect(has("msg-delete-11")).toBe(false);
    });

    it("never offers delete on the other person's message in a DM", () => {
      setRole(true);
      setChannel({ can_delete_others: true }, "dm");
      mount("dm");
      expect(has("msg-delete-11")).toBe(false);
      expect(has("msg-delete-10")).toBe(true);
    });
  });

  describe("pin", () => {
    it("follows can_pin true and false regardless of the role", () => {
      setRole(false);
      setChannel({ can_pin: true });
      mount();
      expect(has("msg-pin-11")).toBe(true);
      list?.destroy?.();
      container.replaceChildren();
      setRole(true);
      setChannel({ can_pin: false });
      mount();
      expect(has("msg-pin-11")).toBe(false);
    });

    it("falls back to the role when absent", () => {
      setRole(true);
      setChannel({});
      mount();
      expect(has("msg-pin-11")).toBe(true);
      list?.destroy?.();
      container.replaceChildren();
      setRole(false);
      mount();
      expect(has("msg-pin-11")).toBe(false);
    });

    it("a DM participant can always pin", () => {
      setRole(false);
      setChannel({ can_pin: false }, "dm");
      mount("dm");
      expect(has("msg-pin-11")).toBe(true);
    });
  });

  describe("react", () => {
    it("locks the react button and chips when can_react is false", () => {
      setRole(false);
      setChannel({ can_react: false });
      mount();
      expect(reactBtn().getAttribute("aria-disabled")).toBe("true");
      expect(reactBtn().title).toBe("You can't add reactions in this channel");
      const chip = container.querySelector<HTMLElement>(".reaction-chip")!;
      expect(chip.getAttribute("aria-disabled")).toBe("true");
    });

    it("leaves reacting on when can_react is true or absent", () => {
      setRole(false);
      setChannel({});
      mount();
      expect(reactBtn().hasAttribute("aria-disabled")).toBe(false);
      list?.destroy?.();
      container.replaceChildren();
      setChannel({ can_react: true });
      mount();
      expect(reactBtn().hasAttribute("aria-disabled")).toBe(false);
    });

    it("the reaction controller refuses to send when can_react is false", () => {
      setChannel({ can_react: false });
      const send = vi.fn(() => "c");
      const showError = vi.fn();
      const ctrl = createReactionController({
        ws: { send } as unknown as Parameters<typeof createReactionController>[0]["ws"],
        reactionsLimiter: { tryConsume: () => true },
        getChannelId: () => 1,
        showError,
      });
      ctrl.handleReaction(11, "🔥");
      expect(send).not.toHaveBeenCalled();
      expect(showError).toHaveBeenCalledWith("You can't add reactions in this channel");
      ctrl.destroy();
    });

    it("the reaction controller sends when can_react is absent", () => {
      setChannel({});
      const send = vi.fn(() => "c");
      const showError = vi.fn();
      const ctrl = createReactionController({
        ws: { send } as unknown as Parameters<typeof createReactionController>[0]["ws"],
        reactionsLimiter: { tryConsume: () => true },
        getChannelId: () => 1,
        showError,
      });
      ctrl.handleReaction(11, "🔥");
      expect(send).toHaveBeenCalledTimes(1);
      expect(showError).not.toHaveBeenCalled();
      ctrl.destroy();
    });
  });

  describe("live updates", () => {
    function patch(
      bits: Partial<Record<"canDeleteOthers" | "canPin" | "canReact", boolean>>,
    ): void {
      channelsStore.setState((prev) => {
        const next = new Map(prev.channels);
        next.set(1, { ...next.get(1)!, ...bits });
        return { ...prev, channels: next };
      });
      channelsStore.flush();
    }

    it("rebuilds rows when the active channel's can_delete_others or can_pin changes", () => {
      setRole(false);
      setChannel({ can_delete_others: false, can_pin: false });
      mount();
      expect(has("msg-delete-11")).toBe(false);
      expect(has("msg-pin-11")).toBe(false);
      patch({ canDeleteOthers: true });
      expect(has("msg-delete-11")).toBe(true);
      patch({ canPin: true });
      expect(has("msg-pin-11")).toBe(true);
      patch({ canDeleteOthers: false, canPin: false });
      expect(has("msg-delete-11")).toBe(false);
      expect(has("msg-pin-11")).toBe(false);
    });

    it("locks and unlocks reaction controls in place when can_react changes", () => {
      setRole(false);
      setChannel({ can_react: true });
      mount();
      const before = reactBtn();
      patch({ canReact: false });
      expect(reactBtn()).toBe(before);
      expect(before.getAttribute("aria-disabled")).toBe("true");
      patch({ canReact: true });
      expect(before.hasAttribute("aria-disabled")).toBe(false);
    });

    it("stops reacting to channel changes after destroy", () => {
      setRole(false);
      setChannel({ can_delete_others: false });
      const original = channelsStore.subscribeSelector.bind(channelsStore);
      const unsubs: Array<ReturnType<typeof vi.fn>> = [];
      const spy = vi
        .spyOn(channelsStore, "subscribeSelector")
        .mockImplementation((...args: Parameters<typeof original>) => {
          const unsub = vi.fn(original(...args));
          unsubs.push(unsub);
          return unsub;
        });
      mount();
      spy.mockRestore();
      expect(unsubs.length).toBeGreaterThanOrEqual(2);
      list?.destroy?.();
      list = null;
      for (const unsub of unsubs) expect(unsub).toHaveBeenCalledTimes(1);
      expect(() => patch({ canDeleteOthers: true })).not.toThrow();
    });
  });
});
