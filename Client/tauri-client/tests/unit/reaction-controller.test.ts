import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockGetChannelMessages, createMockEmojiPickerElement, mockEmojiPickerDestroy } =
  vi.hoisted(() => ({
    mockGetChannelMessages: vi.fn((): Array<{ id: number; reactions: Array<{ emoji: string; me: boolean }> }> => []),
    createMockEmojiPickerElement: () => document.createElement("div"),
    mockEmojiPickerDestroy: vi.fn(),
  }));

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

let capturedOnSelect: ((emoji: string) => void) | null = null;
let capturedOnClose: (() => void) | null = null;

vi.mock("@components/EmojiPicker", () => ({
  createEmojiPicker: vi.fn((opts: { onSelect: (e: string) => void; onClose: () => void }) => {
    capturedOnSelect = opts.onSelect;
    capturedOnClose = opts.onClose;
    return {
      element: createMockEmojiPickerElement(),
      destroy: mockEmojiPickerDestroy,
    };
  }),
}));

vi.mock("@stores/messages.store", () => ({
  getChannelMessages: mockGetChannelMessages,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { createReactionController } from "../../src/pages/main-page/ReactionController";
import type { ReactionControllerOptions } from "../../src/pages/main-page/ReactionController";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWs(): ReactionControllerOptions["ws"] {
  return { send: vi.fn() } as unknown as ReactionControllerOptions["ws"];
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createReactionController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnSelect = null;
    capturedOnClose = null;
    // Clean up any leftover DOM elements
    document.querySelectorAll(".reaction-picker-wrap").forEach((el) => el.remove());
    document.querySelectorAll("[data-testid]").forEach((el) => el.remove());
  });

  afterEach(() => {
    document.querySelectorAll(".reaction-picker-wrap").forEach((el) => el.remove());
    document.querySelectorAll("[data-testid]").forEach((el) => el.remove());
  });

  describe("direct emoji toggle", () => {
    it("sends reaction_add for a new emoji", () => {
      mockGetChannelMessages.mockReturnValue([
        { id: 1, reactions: [] },
      ]);
      const opts = makeOpts();
      const ctrl = createReactionController(opts);

      ctrl.handleReaction(1, "👍");

      expect(opts.ws.send).toHaveBeenCalledWith({
        type: "reaction_add",
        payload: { message_id: 1, emoji: "👍" },
      });
    });

    it("sends reaction_remove when user already reacted", () => {
      mockGetChannelMessages.mockReturnValue([
        { id: 1, reactions: [{ emoji: "👍", me: true }] },
      ]);
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
      expect(opts.showError).toHaveBeenCalledWith(
        "Slow down! Please wait before reacting again.",
      );
    });
  });

  describe("emoji picker (empty emoji)", () => {
    it("does nothing when react button is not in DOM", () => {
      const opts = makeOpts();
      const ctrl = createReactionController(opts);

      ctrl.handleReaction(1, "");

      expect(document.querySelector(".reaction-picker-wrap")).toBeNull();
    });

    it("opens picker when react button exists", () => {
      const btn = document.createElement("button");
      btn.setAttribute("data-testid", "msg-react-1");
      btn.getBoundingClientRect = vi.fn(() => ({
        left: 500, right: 530, top: 100, bottom: 130,
        width: 30, height: 30, x: 500, y: 100, toJSON: () => {},
      }));
      document.body.appendChild(btn);

      const opts = makeOpts();
      const ctrl = createReactionController(opts);

      ctrl.handleReaction(1, "");

      expect(document.querySelector(".reaction-picker-wrap")).not.toBeNull();
    });

    it("closes existing picker on second open", () => {
      const btn = document.createElement("button");
      btn.setAttribute("data-testid", "msg-react-1");
      btn.getBoundingClientRect = vi.fn(() => ({
        left: 500, right: 530, top: 100, bottom: 130,
        width: 30, height: 30, x: 500, y: 100, toJSON: () => {},
      }));
      document.body.appendChild(btn);

      const opts = makeOpts();
      const ctrl = createReactionController(opts);

      ctrl.handleReaction(1, "");
      expect(document.querySelector(".reaction-picker-wrap")).not.toBeNull();

      // Open again — should close
      ctrl.handleReaction(1, "");
      expect(document.querySelector(".reaction-picker-wrap")).toBeNull();
    });

    it("sends reaction when emoji is selected from picker", () => {
      mockGetChannelMessages.mockReturnValue([
        { id: 1, reactions: [] },
      ]);
      const btn = document.createElement("button");
      btn.setAttribute("data-testid", "msg-react-1");
      btn.getBoundingClientRect = vi.fn(() => ({
        left: 500, right: 530, top: 100, bottom: 130,
        width: 30, height: 30, x: 500, y: 100, toJSON: () => {},
      }));
      document.body.appendChild(btn);

      const opts = makeOpts();
      const ctrl = createReactionController(opts);
      ctrl.handleReaction(1, "");

      // Simulate emoji selection from picker
      expect(capturedOnSelect).not.toBeNull();
      capturedOnSelect!("🎉");

      expect(opts.ws.send).toHaveBeenCalledWith({
        type: "reaction_add",
        payload: { message_id: 1, emoji: "🎉" },
      });
      // Picker should be removed from DOM
      expect(document.querySelector(".reaction-picker-wrap")).toBeNull();
    });

    it("calls pickerDestroy when emoji is selected", () => {
      mockGetChannelMessages.mockReturnValue([
        { id: 1, reactions: [] },
      ]);
      const btn = document.createElement("button");
      btn.setAttribute("data-testid", "msg-react-1");
      btn.getBoundingClientRect = vi.fn(() => ({
        left: 500, right: 530, top: 100, bottom: 130,
        width: 30, height: 30, x: 500, y: 100, toJSON: () => {},
      }));
      document.body.appendChild(btn);

      const opts = makeOpts();
      const ctrl = createReactionController(opts);
      ctrl.handleReaction(1, "");

      capturedOnSelect!("🎉");

      expect(mockEmojiPickerDestroy).toHaveBeenCalledOnce();
    });

    it("calls pickerDestroy when onClose fires", () => {
      const btn = document.createElement("button");
      btn.setAttribute("data-testid", "msg-react-1");
      btn.getBoundingClientRect = vi.fn(() => ({
        left: 500, right: 530, top: 100, bottom: 130,
        width: 30, height: 30, x: 500, y: 100, toJSON: () => {},
      }));
      document.body.appendChild(btn);

      const opts = makeOpts();
      const ctrl = createReactionController(opts);
      ctrl.handleReaction(1, "");

      capturedOnClose!();

      expect(mockEmojiPickerDestroy).toHaveBeenCalledOnce();
      expect(document.querySelector(".reaction-picker-wrap")).toBeNull();
    });

    it("calls pickerDestroy when toggling picker closed", () => {
      const btn = document.createElement("button");
      btn.setAttribute("data-testid", "msg-react-1");
      btn.getBoundingClientRect = vi.fn(() => ({
        left: 500, right: 530, top: 100, bottom: 130,
        width: 30, height: 30, x: 500, y: 100, toJSON: () => {},
      }));
      document.body.appendChild(btn);

      const opts = makeOpts();
      const ctrl = createReactionController(opts);
      ctrl.handleReaction(1, "");
      expect(mockEmojiPickerDestroy).not.toHaveBeenCalled();

      // Toggle close
      ctrl.handleReaction(1, "");
      expect(mockEmojiPickerDestroy).toHaveBeenCalledOnce();
    });
  });

  describe("destroy", () => {
    it("removes open picker and calls pickerDestroy", () => {
      const btn = document.createElement("button");
      btn.setAttribute("data-testid", "msg-react-1");
      btn.getBoundingClientRect = vi.fn(() => ({
        left: 500, right: 530, top: 100, bottom: 130,
        width: 30, height: 30, x: 500, y: 100, toJSON: () => {},
      }));
      document.body.appendChild(btn);

      const opts = makeOpts();
      const ctrl = createReactionController(opts);
      ctrl.handleReaction(1, "");
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
