import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const {
  mockGetChannelMessages,
  mockAddOptimisticReaction,
  mockEmojiPickerDestroy,
  mockListCustomEmoji,
  mockCreateEmojiPicker,
  captured,
} = vi.hoisted(() => {
  const captured: {
    onSelect: ((emoji: string, select?: { keepOpen: boolean }) => void) | null;
    onClose: (() => void) | null;
  } = { onSelect: null, onClose: null };
  const createMockEmojiPickerElement = () => document.createElement("div");
  const mockEmojiPickerDestroy = vi.fn();
  return {
    mockGetChannelMessages: vi.fn(
      (): Array<{ id: number; reactions: Array<{ emoji: string; me: boolean }> }> => [],
    ),
    mockAddOptimisticReaction: vi.fn(),
    mockEmojiPickerDestroy,
    mockListCustomEmoji: vi.fn((): Array<{ id: number; shortcode: string; url: string }> => []),
    mockCreateEmojiPicker: vi.fn(
      (opts: {
        onSelect: (e: string, select?: { keepOpen: boolean }) => void;
        onClose: () => void;
        customEmoji?: readonly { id: number; shortcode: string; url: string }[];
      }) => {
        captured.onSelect = opts.onSelect;
        captured.onClose = opts.onClose;
        return {
          element: createMockEmojiPickerElement(),
          destroy: mockEmojiPickerDestroy,
        };
      },
    ),
    captured,
  };
});

vi.mock("@lib/dom", () => ({
  createElement: vi.fn((tag: string, attrs?: Record<string, string>) => {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "class") el.className = v;
        else if (k === "style") el.setAttribute("style", v);
        else el.setAttribute(k, v);
      }
    }
    return el;
  }),
}));

vi.mock("@components/EmojiPicker", () => ({
  createEmojiPicker: mockCreateEmojiPicker,
}));

vi.mock("@stores/messages.store", () => ({
  getChannelMessages: mockGetChannelMessages,
  addOptimisticReaction: mockAddOptimisticReaction,
}));

vi.mock("@stores/emoji.store", () => ({
  listCustomEmoji: mockListCustomEmoji,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { createReactionController } from "../../src/pages/main-page/ReactionController";
import type { ReactionControllerOptions } from "../../src/pages/main-page/ReactionController";
import { setConnectionStatus, uiStore } from "@stores/ui.store";

// Reaction controls lock while the socket is down (3A-3); these tests react online.
beforeEach(() => {
  setConnectionStatus("connected");
  uiStore.flush();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWs(): ReactionControllerOptions["ws"] {
  return { send: vi.fn(() => "corr-1") } as unknown as ReactionControllerOptions["ws"];
}

function makeLimiter(allowed = true): ReactionControllerOptions["reactionsLimiter"] {
  return { tryConsume: vi.fn(() => allowed) };
}

function makeOpts(overrides: Partial<ReactionControllerOptions> = {}): ReactionControllerOptions {
  return {
    ws: makeWs(),
    reactionsLimiter: makeLimiter(),
    getChannelId: () => 42,
    showError: vi.fn(),
    ...overrides,
  };
}

function addReactButton(id: number, top?: number): HTMLElement {
  const btn = document.createElement("button");
  btn.setAttribute("data-testid", `msg-react-${id}`);
  if (top !== undefined) {
    btn.getBoundingClientRect = vi.fn(() => ({
      left: 500,
      right: 530,
      top,
      bottom: top + 30,
      width: 30,
      height: 30,
      x: 500,
      y: top,
      toJSON: () => {},
    }));
  }
  document.body.appendChild(btn);
  return btn;
}

async function openPicker(messageId = 1) {
  const opts = makeOpts();
  const ctrl = createReactionController(opts);
  ctrl.handleReaction(messageId, "");
  await vi.dynamicImportSettled();
  return { opts, ctrl };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createReactionController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListCustomEmoji.mockReturnValue([]);
    captured.onSelect = null;
    captured.onClose = null;
    // Clean up any leftover DOM elements
    document.querySelectorAll(".reaction-picker-wrap").forEach((el) => el.remove());
    document.querySelectorAll("[data-testid]").forEach((el) => el.remove());
  });

  afterEach(() => {
    document.querySelectorAll(".reaction-picker-wrap").forEach((el) => el.remove());
    document.querySelectorAll("[data-testid]").forEach((el) => el.remove());
  });

  it("refuses to send while the socket is down, even from an open picker (3A-3)", () => {
    mockGetChannelMessages.mockReturnValue([{ id: 1, reactions: [] }]);
    const opts = makeOpts();
    const ctrl = createReactionController(opts);
    setConnectionStatus("reconnecting");
    uiStore.flush();

    ctrl.handleReaction(1, "👍");

    expect(opts.ws.send).not.toHaveBeenCalled();
    expect(opts.showError).toHaveBeenCalledWith("Reconnecting…");
  });

  describe("20 different emoji per message (3A-12)", () => {
    const full = Array.from({ length: 20 }, (_, i) => ({ emoji: `e${i}`, me: false }));

    it("refuses a new emoji on a message that already has 20, without sending", () => {
      mockGetChannelMessages.mockReturnValue([{ id: 1, reactions: full }]);
      const opts = makeOpts();
      const ctrl = createReactionController(opts);

      ctrl.handleReaction(1, "👍");

      expect(opts.ws.send).not.toHaveBeenCalled();
      expect(opts.reactionsLimiter.tryConsume).not.toHaveBeenCalled();
      expect(opts.showError).toHaveBeenCalledWith(
        "This message has reached the reaction limit (20)",
      );
    });

    it("still toggles an emoji that is already on the message", () => {
      mockGetChannelMessages.mockReturnValue([{ id: 1, reactions: full }]);
      const opts = makeOpts();
      const ctrl = createReactionController(opts);

      ctrl.handleReaction(1, "e3");

      expect(opts.ws.send).toHaveBeenCalledWith({
        type: "reaction_add",
        payload: { message_id: 1, emoji: "e3" },
      });
    });

    it("does not open the picker on a full message", async () => {
      mockGetChannelMessages.mockReturnValue([{ id: 1, reactions: full }]);
      addReactButton(1);
      const { opts } = await openPicker();

      expect(mockCreateEmojiPicker).not.toHaveBeenCalled();
      expect(opts.showError).toHaveBeenCalledOnce();
    });
  });

  describe("direct emoji toggle", () => {
    it("sends reaction_add for a new emoji", () => {
      mockGetChannelMessages.mockReturnValue([{ id: 1, reactions: [] }]);
      const opts = makeOpts();
      const ctrl = createReactionController(opts);

      ctrl.handleReaction(1, "👍");

      expect(opts.ws.send).toHaveBeenCalledWith({
        type: "reaction_add",
        payload: { message_id: 1, emoji: "👍" },
      });
    });

    it("sends reaction_remove when user already reacted", () => {
      mockGetChannelMessages.mockReturnValue([{ id: 1, reactions: [{ emoji: "👍", me: true }] }]);
      const opts = makeOpts();
      const ctrl = createReactionController(opts);

      ctrl.handleReaction(1, "👍");

      expect(opts.ws.send).toHaveBeenCalledWith({
        type: "reaction_remove",
        payload: { message_id: 1, emoji: "👍" },
      });
    });

    it("blocks when rate limited", () => {
      const opts = makeOpts({ reactionsLimiter: makeLimiter(false) });
      const ctrl = createReactionController(opts);

      ctrl.handleReaction(1, "👍");

      expect(opts.ws.send).not.toHaveBeenCalled();
      expect(opts.showError).toHaveBeenCalledWith("Slow down! Please wait before reacting again.");
      expect(mockAddOptimisticReaction).not.toHaveBeenCalled();
    });

    it("registers the optimistic toggle under the send's correlation id", () => {
      mockGetChannelMessages.mockReturnValue([{ id: 1, reactions: [] }]);
      const ctrl = createReactionController(makeOpts());

      ctrl.handleReaction(1, "👍");

      expect(mockAddOptimisticReaction).toHaveBeenCalledWith("corr-1", {
        channelId: 42,
        messageId: 1,
        emoji: "👍",
        action: "add",
      });
    });

    it("registers an optimistic remove when toggling off", () => {
      mockGetChannelMessages.mockReturnValue([{ id: 1, reactions: [{ emoji: "👍", me: true }] }]);
      const ctrl = createReactionController(makeOpts());

      ctrl.handleReaction(1, "👍");

      expect(mockAddOptimisticReaction).toHaveBeenCalledWith("corr-1", {
        channelId: 42,
        messageId: 1,
        emoji: "👍",
        action: "remove",
      });
    });
  });

  describe("emoji picker (empty emoji)", () => {
    it("does nothing when react button is not in DOM", async () => {
      await openPicker();

      expect(document.querySelector(".reaction-picker-wrap")).toBeNull();
    });

    it("passes the server's custom emoji to the picker", async () => {
      const customEmoji = [{ id: 1, shortcode: "partyparrot", url: "/api/v1/emoji/1/image" }];
      mockListCustomEmoji.mockReturnValue(customEmoji);

      addReactButton(1, 100);

      await openPicker();

      expect(mockCreateEmojiPicker).toHaveBeenCalledWith(expect.objectContaining({ customEmoji }));
    });

    it("opens picker when react button exists", async () => {
      addReactButton(1, 100);

      await openPicker();

      expect(document.querySelector(".reaction-picker-wrap")).not.toBeNull();
    });

    it("opens the new message's picker when React is clicked on a second message (F12)", async () => {
      addReactButton(1, 100);
      addReactButton(2, 200);

      const { opts, ctrl } = await openPicker();
      expect(document.querySelector(".reaction-picker-wrap")).not.toBeNull();

      // Clicking React on a DIFFERENT message must move the picker there, not
      // just close the first and swallow the click.
      ctrl.handleReaction(2, "");
      await vi.dynamicImportSettled();

      // The picker was rebuilt for message 2 (selecting sends to message 2).
      mockGetChannelMessages.mockReturnValue([{ id: 2, reactions: [] }]);
      captured.onSelect!("🎉");
      expect(opts.ws.send).toHaveBeenCalledWith({
        type: "reaction_add",
        payload: { message_id: 2, emoji: "🎉" },
      });
    });

    it("closes existing picker on second open", async () => {
      addReactButton(1, 100);

      const { ctrl } = await openPicker();
      expect(document.querySelector(".reaction-picker-wrap")).not.toBeNull();

      // Open again — should close
      ctrl.handleReaction(1, "");
      await vi.dynamicImportSettled();
      expect(document.querySelector(".reaction-picker-wrap")).toBeNull();
    });

    it("a second click on the same message's react button while the code loads cancels", async () => {
      const btn = addReactButton(1);
      const ctrl = createReactionController(makeOpts());

      ctrl.handleReaction(1, "");
      ctrl.handleReaction(1, ""); // before the picker's code arrives
      await vi.dynamicImportSettled();
      expect(document.querySelector(".reaction-picker-wrap")).toBeNull();
      expect(mockCreateEmojiPicker).not.toHaveBeenCalled();
      btn.remove();
    });

    it("a click on a different message while the code loads replaces the pending open", async () => {
      const btn1 = addReactButton(1);
      const btn2 = addReactButton(2);
      const ctrl = createReactionController(makeOpts());

      ctrl.handleReaction(1, "");
      ctrl.handleReaction(2, "");
      await vi.dynamicImportSettled();
      const wraps = document.querySelectorAll(".reaction-picker-wrap");
      expect(wraps).toHaveLength(1);
      expect(wraps[0]!.getAttribute("data-message-id")).toBe("2");
      expect(mockCreateEmojiPicker).toHaveBeenCalledOnce();
      ctrl.destroy();
      btn1.remove();
      btn2.remove();
    });

    it("destroy during the load mounts nothing", async () => {
      const btn = addReactButton(1);
      const ctrl = createReactionController(makeOpts());

      ctrl.handleReaction(1, "");
      ctrl.destroy();
      await vi.dynamicImportSettled();
      expect(document.querySelector(".reaction-picker-wrap")).toBeNull();
      btn.remove();
    });

    it("sends reaction when emoji is selected from picker", async () => {
      mockGetChannelMessages.mockReturnValue([{ id: 1, reactions: [] }]);
      addReactButton(1, 100);

      const { opts } = await openPicker();

      // Simulate emoji selection from picker
      expect(captured.onSelect).not.toBeNull();
      captured.onSelect!("🎉");

      expect(opts.ws.send).toHaveBeenCalledWith({
        type: "reaction_add",
        payload: { message_id: 1, emoji: "🎉" },
      });
      // Picker should be removed from DOM
      expect(document.querySelector(".reaction-picker-wrap")).toBeNull();
    });

    it("a Shift-pick sends the reaction and keeps the picker open", async () => {
      mockGetChannelMessages.mockReturnValue([{ id: 1, reactions: [] }]);
      addReactButton(1);

      const { opts } = await openPicker();

      captured.onSelect!("🎉", { keepOpen: true });
      captured.onSelect!("🔥", { keepOpen: true });

      expect(opts.ws.send).toHaveBeenCalledTimes(2);
      expect(opts.ws.send).toHaveBeenLastCalledWith({
        type: "reaction_add",
        payload: { message_id: 1, emoji: "🔥" },
      });
      expect(document.querySelector(".reaction-picker-wrap")).not.toBeNull();
      expect(mockEmojiPickerDestroy).not.toHaveBeenCalled();

      // A plain pick still closes it.
      captured.onSelect!("👍");
      expect(document.querySelector(".reaction-picker-wrap")).toBeNull();
      expect(mockEmojiPickerDestroy).toHaveBeenCalledOnce();
    });

    it("calls pickerDestroy when emoji is selected", async () => {
      mockGetChannelMessages.mockReturnValue([{ id: 1, reactions: [] }]);
      addReactButton(1, 100);

      await openPicker();

      captured.onSelect!("🎉");

      expect(mockEmojiPickerDestroy).toHaveBeenCalledOnce();
    });

    it("calls pickerDestroy when onClose fires", async () => {
      addReactButton(1, 100);

      await openPicker();

      captured.onClose!();

      expect(mockEmojiPickerDestroy).toHaveBeenCalledOnce();
      expect(document.querySelector(".reaction-picker-wrap")).toBeNull();
    });

    it("calls pickerDestroy when toggling picker closed", async () => {
      addReactButton(1, 100);

      const { ctrl } = await openPicker();
      expect(mockEmojiPickerDestroy).not.toHaveBeenCalled();

      // Toggle close
      ctrl.handleReaction(1, "");
      await vi.dynamicImportSettled();
      expect(mockEmojiPickerDestroy).toHaveBeenCalledOnce();
    });
  });

  describe("destroy", () => {
    it("removes open picker and calls pickerDestroy", async () => {
      addReactButton(1, 100);

      const { ctrl } = await openPicker();
      expect(document.querySelector(".reaction-picker-wrap")).not.toBeNull();

      ctrl.destroy();
      expect(document.querySelector(".reaction-picker-wrap")).toBeNull();
      expect(mockEmojiPickerDestroy).toHaveBeenCalledOnce();
    });

    it("is safe to call when no picker is open", () => {
      const opts = makeOpts();
      const ctrl = createReactionController(opts);
      expect(() => ctrl.destroy()).not.toThrow();
    });
  });
});
