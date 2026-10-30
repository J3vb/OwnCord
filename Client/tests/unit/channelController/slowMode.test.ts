import { describe, it, expect, vi, beforeEach } from "vitest";
import * as mocks from "../../helpers/channelControllerMocks";
import { createChannelController } from "../../../src/pages/main-page/ChannelController";
import type { ChannelControllerOptions } from "../../../src/pages/main-page/ChannelController";
import { setConnectionStatus } from "@stores/ui.store";
import {
  channelsStore,
  setChannels,
  setActiveChannel,
  setRoles,
  updateChannel,
  addChannel,
} from "@stores/channels.store";
import { capturedMessageInputOpts } from "../../helpers/channelControllerMocks";
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

const { mockSetDisabled, mockSetSendGate, mockSetSlowModeNote, mockRole, membersStoreSubscribers } =
  mocks;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createChannelController", () => {
  useChannelControllerHarness();

  describe("slow mode", () => {
    /** Pull a ws.on handler registered by the controller. */
    function wsHandler(opts: ChannelControllerOptions, event: string): (payload: never) => void {
      const calls = (opts.ws.on as ReturnType<typeof vi.fn>).mock.calls;
      const entry = calls.findLast((c) => c[0] === event);
      expect(entry).toBeDefined();
      return entry![1] as (payload: never) => void;
    }

    function seedChannel(slowMode: number): void {
      setChannels([
        {
          id: 42,
          name: "general",
          type: "text",
          category: null,
          position: 0,
          can_send: true,
          slow_mode: slowMode,
        },
      ]);
      setActiveChannel(42);
    }

    beforeEach(() => {
      mockRole.value = "member";
      setRoles([{ id: 4, name: "member", color: null, permissions: 0 }]);
      setConnectionStatus("connected");
    });

    it("gates only the send for the cooldown, leaving the draft editable (#12)", () => {
      vi.useFakeTimers();
      try {
        seedChannel(5);
        const opts = makeOpts();
        const ctrl = createChannelController(opts);
        ctrl.mountChannel(42, "general");
        expect(mockSetSendGate).toHaveBeenLastCalledWith(null);

        wsHandler(opts, "chat_send_ok")({} as never);
        expect(mockSetSendGate).toHaveBeenLastCalledWith("Slow mode — 5s");
        // The composer itself must NOT be disabled — typing continues.
        expect(mockSetDisabled).toHaveBeenLastCalledWith(null);

        vi.advanceTimersByTime(3000);
        expect(mockSetSendGate).toHaveBeenLastCalledWith("Slow mode — 2s");

        vi.advanceTimersByTime(2000);
        expect(mockSetSendGate).toHaveBeenLastCalledWith(null);
      } finally {
        vi.useRealTimers();
      }
    });

    it("leaves the composer alone in a channel without slow mode", () => {
      seedChannel(0);
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      wsHandler(opts, "chat_send_ok")({} as never);

      expect(mockSetSendGate).toHaveBeenLastCalledWith(null);
    });

    it("does not charge slow mode again for a deduplicated receipt", () => {
      seedChannel(30);
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");
      wsHandler(opts, "chat_send_ok")({ deduplicated: true } as never);
      expect(mockSetSendGate).toHaveBeenLastCalledWith(null);
    });

    it("restarts the cooldown when the server refuses with SLOW_MODE", () => {
      vi.useFakeTimers();
      try {
        seedChannel(10);
        const opts = makeOpts();
        const ctrl = createChannelController(opts);
        ctrl.mountChannel(42, "general");

        wsHandler(opts, "error")({ code: "SLOW_MODE", message: "slow mode" } as never);
        expect(mockSetSendGate).toHaveBeenLastCalledWith("Slow mode — 10s");

        // An unrelated error must not gate the composer.
        vi.advanceTimersByTime(10_000);
        mockSetSendGate.mockClear();
        wsHandler(opts, "error")({ code: "FORBIDDEN", message: "nope" } as never);
        expect(mockSetSendGate).not.toHaveBeenCalledWith(expect.stringContaining("Slow mode"));
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not gate a moderator, who bypasses slow mode server-side", () => {
      seedChannel(5);
      mockRole.value = "moderator";
      setRoles([{ id: 3, name: "moderator", color: null, permissions: 0x10000 }]);
      const opts = makeOpts();
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      wsHandler(opts, "chat_send_ok")({} as never);

      expect(mockSetSendGate).toHaveBeenLastCalledWith(null);
    });

    it("does not gate the newly mounted channel with a late ack for a message sent in the previous channel", () => {
      // Channel A has slow mode; channel B does too, with a different value,
      // so a misattributed ack is unmistakable.
      setChannels([
        {
          id: 42,
          name: "general",
          type: "text",
          category: null,
          position: 0,
          can_send: true,
          slow_mode: 5,
        },
        {
          id: 43,
          name: "other",
          type: "text",
          category: null,
          position: 0,
          can_send: true,
          slow_mode: 7,
        },
      ]);
      setActiveChannel(42);
      const opts = makeOpts();
      let n = 0;
      (opts.ws.send as ReturnType<typeof vi.fn>).mockImplementation(() => `cid-${++n}`);
      const ctrl = createChannelController(opts);
      ctrl.mountChannel(42, "general");

      // cid-1 is channel_focus; the chat_send in A gets cid-2. The ack for it
      // does not arrive before the user switches away.
      capturedMessageInputOpts.onSend("hello", null, [], []);

      // Switch to channel B before A's ack arrives.
      setActiveChannel(43);
      ctrl.mountChannel(43, "other");
      mockSetSendGate.mockClear();

      // A's late chat_send_ok now arrives; only B's handler is subscribed.
      const ackCalls = (opts.ws.on as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === "chat_send_ok",
      );
      const onAck = ackCalls[ackCalls.length - 1]![1] as (payload: unknown, id?: string) => void;
      onAck({ message_id: 7, timestamp: "2024-01-01T00:00:00Z" }, "cid-2");

      // B was never sent to and must not be gated by A's cooldown.
      expect(mockSetSendGate).not.toHaveBeenCalledWith(expect.stringContaining("Slow mode"));
    });

    it("stops the countdown when the channel unmounts", () => {
      vi.useFakeTimers();
      try {
        seedChannel(5);
        const opts = makeOpts();
        const ctrl = createChannelController(opts);
        ctrl.mountChannel(42, "general");
        wsHandler(opts, "chat_send_ok")({} as never);

        ctrl.destroyChannel();
        mockSetSendGate.mockClear();
        vi.advanceTimersByTime(5000);

        expect(mockSetSendGate).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("slow-mode note up front (3A-4)", () => {
    const base = { type: "text", category: null, position: 0, can_send: true } as const;

    beforeEach(() => {
      mockRole.value = "member";
      setRoles([{ id: 4, name: "member", color: null, permissions: 0 }]);
      setConnectionStatus("connected");
    });

    function seed(slowMode: number): void {
      setChannels([
        { ...base, id: 42, name: "general", slow_mode: slowMode },
        { ...base, id: 43, name: "other", slow_mode: 0 },
      ]);
      setActiveChannel(42);
    }

    it("shows the note before any send, without gating the send", () => {
      seed(5);
      const ctrl = createChannelController(makeOpts());
      ctrl.mountChannel(42, "general");

      expect(mockSetSlowModeNote).toHaveBeenLastCalledWith("Slow mode is on: one message every 5s");
      expect(mockSetSendGate).not.toHaveBeenCalledWith(expect.stringContaining("Slow mode"));
      ctrl.destroyChannel();
    });

    it("hides the note when slow mode is 0", () => {
      seed(0);
      const ctrl = createChannelController(makeOpts());
      ctrl.mountChannel(42, "general");

      expect(mockSetSlowModeNote).toHaveBeenLastCalledWith(null);
      ctrl.destroyChannel();
    });

    it("updates the note when the user's role changes", () => {
      seed(5);
      const before = membersStoreSubscribers.length;
      const ctrl = createChannelController(makeOpts());
      ctrl.mountChannel(42, "general");
      expect(mockSetSlowModeNote).toHaveBeenLastCalledWith("Slow mode is on: one message every 5s");

      mockRole.value = "moderator";
      setRoles([{ id: 3, name: "moderator", color: null, permissions: 0x10000 }]);
      for (const cb of membersStoreSubscribers.slice(before)) cb();
      expect(mockSetSlowModeNote).toHaveBeenLastCalledWith(null);
      ctrl.destroyChannel();
    });

    it("hides the note for a moderator, who bypasses slow mode", () => {
      seed(5);
      mockRole.value = "moderator";
      setRoles([{ id: 3, name: "moderator", color: null, permissions: 0x10000 }]);
      const ctrl = createChannelController(makeOpts());
      ctrl.mountChannel(42, "general");

      expect(mockSetSlowModeNote).toHaveBeenLastCalledWith(null);
      ctrl.destroyChannel();
    });

    it("follows a channel switch", () => {
      seed(5);
      const ctrl = createChannelController(makeOpts());
      ctrl.mountChannel(42, "general");
      expect(mockSetSlowModeNote).toHaveBeenLastCalledWith("Slow mode is on: one message every 5s");

      setActiveChannel(43);
      ctrl.mountChannel(43, "other");
      expect(mockSetSlowModeNote).toHaveBeenLastCalledWith(null);
      ctrl.destroyChannel();
    });

    it("updates when slow mode changes through channel_create or channel_update", () => {
      seed(0);
      const ctrl = createChannelController(makeOpts());
      ctrl.mountChannel(42, "general");
      expect(mockSetSlowModeNote).toHaveBeenLastCalledWith(null);

      addChannel({ ...base, id: 42, name: "general", slow_mode: 10 });
      channelsStore.flush();
      expect(mockSetSlowModeNote).toHaveBeenLastCalledWith(
        "Slow mode is on: one message every 10s",
      );

      updateChannel({ id: 42, slow_mode: 0 });
      channelsStore.flush();
      expect(mockSetSlowModeNote).toHaveBeenLastCalledWith(null);
      ctrl.destroyChannel();
    });
  });

  describe("slow mode across channel switches", () => {
    function wsHandler(opts: ChannelControllerOptions, event: string): (payload: never) => void {
      const calls = (opts.ws.on as ReturnType<typeof vi.fn>).mock.calls;
      // The newest registration belongs to the channel mounted last.
      const entry = [...calls].reverse().find((c) => c[0] === event);
      expect(entry).toBeDefined();
      return entry![1] as (payload: never) => void;
    }

    function seedTwoChannels(): void {
      const base = { type: "text", category: null, position: 0, can_send: true } as const;
      setChannels([
        { ...base, id: 42, name: "general", slow_mode: 30 },
        { ...base, id: 43, name: "other", slow_mode: 0 },
      ]);
      setActiveChannel(42);
    }

    function switchTo(ctrl: ReturnType<typeof createChannelController>, id: 42 | 43): void {
      setActiveChannel(id);
      ctrl.mountChannel(id, id === 42 ? "general" : "other");
    }

    beforeEach(() => {
      mockRole.value = "member";
      setRoles([{ id: 4, name: "member", color: null, permissions: 0 }]);
      setConnectionStatus("connected");
    });

    it("re-arms the countdown on return and clears the gate only at the deadline", () => {
      vi.useFakeTimers();
      try {
        seedTwoChannels();
        const opts = makeOpts();
        const ctrl = createChannelController(opts);
        ctrl.mountChannel(42, "general");
        wsHandler(opts, "chat_send_ok")({} as never);
        expect(mockSetSendGate).toHaveBeenLastCalledWith("Slow mode — 30s");

        switchTo(ctrl, 43);
        // A channel never sent in shows no gate.
        expect(mockSetSendGate).toHaveBeenLastCalledWith(null);

        vi.advanceTimersByTime(5000);
        switchTo(ctrl, 42);
        expect(mockSetSendGate).toHaveBeenLastCalledWith("Slow mode — 25s");

        // The re-armed ticker keeps counting down on the remounted composer.
        vi.advanceTimersByTime(10_000);
        expect(mockSetSendGate).toHaveBeenLastCalledWith("Slow mode — 15s");

        vi.advanceTimersByTime(14_000);
        expect(mockSetSendGate).toHaveBeenLastCalledWith("Slow mode — 1s");
        mockSetSendGate.mockClear();
        vi.advanceTimersByTime(1000);
        expect(mockSetSendGate).toHaveBeenLastCalledWith(null);
      } finally {
        vi.useRealTimers();
      }
    });

    it("follows an admin lowering slow mode while the user was away", () => {
      vi.useFakeTimers();
      try {
        seedTwoChannels();
        const opts = makeOpts();
        const ctrl = createChannelController(opts);
        ctrl.mountChannel(42, "general");
        wsHandler(opts, "chat_send_ok")({} as never);

        switchTo(ctrl, 43);
        updateChannel({ id: 42, slow_mode: 5 });
        channelsStore.flush();
        vi.advanceTimersByTime(6000);
        mockSetSendGate.mockClear();
        switchTo(ctrl, 42);

        expect(mockSetSendGate).toHaveBeenLastCalledWith(null);
        expect(mockSetSendGate).not.toHaveBeenCalledWith(expect.stringContaining("Slow mode"));
      } finally {
        vi.useRealTimers();
      }
    });

    it("follows an admin raising slow mode while the user was away", () => {
      vi.useFakeTimers();
      try {
        seedTwoChannels();
        const opts = makeOpts();
        const ctrl = createChannelController(opts);
        ctrl.mountChannel(42, "general");
        wsHandler(opts, "chat_send_ok")({} as never);

        switchTo(ctrl, 43);
        updateChannel({ id: 42, slow_mode: 60 });
        channelsStore.flush();
        vi.advanceTimersByTime(6000);
        switchTo(ctrl, 42);

        expect(mockSetSendGate).toHaveBeenLastCalledWith("Slow mode — 54s");
      } finally {
        vi.useRealTimers();
      }
    });

    it("drops the cooldown when slow mode is switched off while the user was away", () => {
      vi.useFakeTimers();
      try {
        seedTwoChannels();
        const opts = makeOpts();
        const ctrl = createChannelController(opts);
        ctrl.mountChannel(42, "general");
        wsHandler(opts, "chat_send_ok")({} as never);

        switchTo(ctrl, 43);
        updateChannel({ id: 42, slow_mode: 0 });
        channelsStore.flush();
        mockSetSendGate.mockClear();
        switchTo(ctrl, 42);

        expect(mockSetSendGate).toHaveBeenLastCalledWith(null);
        expect(mockSetSendGate).not.toHaveBeenCalledWith(expect.stringContaining("Slow mode"));
      } finally {
        vi.useRealTimers();
      }
    });

    it("records a late acknowledgement against the channel it was sent to", () => {
      vi.useFakeTimers();
      try {
        seedTwoChannels();
        const opts = makeOpts();
        let n = 0;
        (opts.ws.send as ReturnType<typeof vi.fn>).mockImplementation(() => `cid-${++n}`);
        const ctrl = createChannelController(opts);
        ctrl.mountChannel(42, "general");
        // cid-1 is channel_focus; the send in channel 42 gets cid-2 and is
        // not acknowledged before the user switches away.
        capturedMessageInputOpts.onSend("hello", null, [], []);
        switchTo(ctrl, 43);

        (wsHandler(opts, "chat_send_ok") as (payload: unknown, id?: string) => void)({}, "cid-2");
        // Only channel 42 is gated, and not while channel 43 is mounted.
        expect(mockSetSendGate).not.toHaveBeenCalledWith(expect.stringContaining("Slow mode"));

        vi.advanceTimersByTime(5000);
        switchTo(ctrl, 42);
        expect(mockSetSendGate).toHaveBeenLastCalledWith("Slow mode — 25s");
      } finally {
        vi.useRealTimers();
      }
    });

    it("bases a late acknowledgement's cooldown on when the message was sent", () => {
      vi.useFakeTimers();
      try {
        seedTwoChannels();
        const opts = makeOpts();
        let n = 0;
        (opts.ws.send as ReturnType<typeof vi.fn>).mockImplementation(() => `cid-${++n}`);
        const ctrl = createChannelController(opts);
        ctrl.mountChannel(42, "general");
        capturedMessageInputOpts.onSend("hello", null, [], []);
        switchTo(ctrl, 43);

        // The ack only arrives 20 s later (a paused renderer, say).
        vi.advanceTimersByTime(20_000);
        (wsHandler(opts, "chat_send_ok") as (payload: unknown, id?: string) => void)({}, "cid-2");
        switchTo(ctrl, 42);

        expect(mockSetSendGate).toHaveBeenLastCalledWith("Slow mode — 10s");
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps the send time past the observed window so a later increase still gates", () => {
      vi.useFakeTimers();
      try {
        seedTwoChannels();
        const opts = makeOpts();
        const ctrl = createChannelController(opts);
        ctrl.mountChannel(42, "general");
        wsHandler(opts, "chat_send_ok")({} as never);

        // The 30 s window passes while the channel stays mounted.
        vi.advanceTimersByTime(31_000);
        switchTo(ctrl, 43);
        vi.advanceTimersByTime(9000);
        updateChannel({ id: 42, slow_mode: 60 });
        channelsStore.flush();
        switchTo(ctrl, 42);

        // The server still holds the send, so 60 s from it leaves 20 s.
        expect(mockSetSendGate).toHaveBeenLastCalledWith("Slow mode — 20s");
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps the send time through a temporary slow-mode reduction", () => {
      vi.useFakeTimers();
      try {
        seedTwoChannels();
        const opts = makeOpts();
        const ctrl = createChannelController(opts);
        ctrl.mountChannel(42, "general");
        wsHandler(opts, "chat_send_ok")({} as never);

        switchTo(ctrl, 43);
        updateChannel({ id: 42, slow_mode: 5 });
        channelsStore.flush();
        vi.advanceTimersByTime(10_000);
        // Back in the channel with the lowered setting the gate is open...
        switchTo(ctrl, 42);
        expect(mockSetSendGate).toHaveBeenLastCalledWith(null);

        // ...but the server's larger window is still running, so raising the
        // setting again must find the original send time.
        switchTo(ctrl, 43);
        updateChannel({ id: 42, slow_mode: 30 });
        channelsStore.flush();
        vi.advanceTimersByTime(2000);
        switchTo(ctrl, 42);
        expect(mockSetSendGate).toHaveBeenLastCalledWith("Slow mode — 18s");
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not re-arm once the cooldown has expired", () => {
      vi.useFakeTimers();
      try {
        seedTwoChannels();
        const opts = makeOpts();
        const ctrl = createChannelController(opts);
        ctrl.mountChannel(42, "general");
        wsHandler(opts, "chat_send_ok")({} as never);

        switchTo(ctrl, 43);
        vi.advanceTimersByTime(31_000);
        mockSetSendGate.mockClear();
        switchTo(ctrl, 42);

        expect(mockSetSendGate).toHaveBeenLastCalledWith(null);
        expect(mockSetSendGate).not.toHaveBeenCalledWith(expect.stringContaining("Slow mode"));
        // Nothing keeps ticking afterwards either.
        mockSetSendGate.mockClear();
        vi.advanceTimersByTime(5000);
        expect(mockSetSendGate).not.toHaveBeenCalledWith(expect.stringContaining("Slow mode"));
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops the re-armed ticker when the channel unmounts again", () => {
      vi.useFakeTimers();
      try {
        seedTwoChannels();
        const opts = makeOpts();
        const ctrl = createChannelController(opts);
        ctrl.mountChannel(42, "general");
        wsHandler(opts, "chat_send_ok")({} as never);
        switchTo(ctrl, 43);
        switchTo(ctrl, 42);

        ctrl.destroyChannel();
        mockSetSendGate.mockClear();
        vi.advanceTimersByTime(5000);

        expect(mockSetSendGate).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not carry a cooldown across a fresh controller (new session)", () => {
      vi.useFakeTimers();
      try {
        seedTwoChannels();
        const first = makeOpts();
        const ctrl = createChannelController(first);
        ctrl.mountChannel(42, "general");
        wsHandler(first, "chat_send_ok")({} as never);
        ctrl.destroyChannel();

        const next = createChannelController(makeOpts());
        mockSetSendGate.mockClear();
        next.mountChannel(42, "general");

        expect(mockSetSendGate).toHaveBeenLastCalledWith(null);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
