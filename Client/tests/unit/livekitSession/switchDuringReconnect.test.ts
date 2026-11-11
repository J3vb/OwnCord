// Switches between voice channels, end to end: the real sidebar and widget
// callbacks, the real voice store, the dispatcher's own frame handlers and the
// session they reach. Only LiveKit and the native edges are stand-ins.
//
// Whatever order the server's frames arrive in, the screen and the server must
// end on the same channel, and this client must never tell the server to end
// a call the user is still in.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/livekitSessionMocks";
import * as voice from "../../../src/lib/voice/livekitSession";
import {
  handleVoiceJoinRollback,
  handleVoiceLeave,
  handleVoiceState,
  handleVoiceTokenFrame,
} from "../../../src/features/voice/wsHandlers";
import { joinAnswerWaitFor } from "../../../src/features/voice/wsErrors";
import { noteJoinSent, setJoinAnswerWait } from "../../../src/features/voice/joinRequest";
import { noteJoinSucceeded } from "../../../src/features/voice/joinBackoff";
import {
  createSidebarVoiceCallbacks,
  createVoiceWidgetCallbacks,
} from "../../../src/pages/main-page/VoiceCallbacks";
import type { WsClient } from "../../../src/lib/ws";
import type { Payload } from "../../../src/features/connection/dispatchContext";
import { joinVoiceChannel, voiceStore } from "@stores/voice.store";
import { channelsStore } from "@stores/channels.store";
import { setConnectionStatus } from "@stores/ui.store";
import { captureDisconnectedHandler } from "../../helpers/livekitSessionHarness";
import { createDeferred } from "../../helpers/deferred";
import {
  NEW,
  OLD,
  SELF,
  clock,
  granted,
  left,
  onError,
  selfRow,
  send,
  store,
  tokenFor,
  unwireVoice,
  wireVoice,
  ws,
} from "../../helpers/voiceSwitchHarness";

vi.mock("livekit-client", () => mocks.livekitClientMock());
vi.mock("@tauri-apps/api/core", () => mocks.apiCoreMock());
vi.mock("@lib/prefs/preferences", (importOriginal) => mocks.prefsPreferencesMock(importOriginal));
vi.mock("@lib/logger", () => mocks.loggerMock());
vi.mock("@lib/ui/toast", () => mocks.uiToastMock());
vi.mock("@lib/voice/noiseSuppression", () => mocks.voiceNoiseSuppressionMock());
vi.mock("@lib/net/e2eeCrypto", () => mocks.netE2eeCryptoMock());
vi.mock("@lib/net/identity", () => mocks.netIdentityMock());

/** The user's click: the store names the channel, then voice_join goes out. */
function click(channelId: number, joinId: string): void {
  joinVoiceChannel(channelId);
  noteJoinSent(joinId);
}

describe("a switch to another voice channel during an auto-reconnect", () => {
  /** In the old channel, the room drops, the user clicks the new channel, and
   *  the loop hands the session to that join at its next check. */
  beforeEach(async () => {
    wireVoice();
    const disconnected = captureDisconnectedHandler();

    joinVoiceChannel(OLD);
    handleVoiceState(ws, selfRow(OLD));
    handleVoiceTokenFrame(tokenFor(OLD));
    await vi.advanceTimersByTimeAsync(0);
    expect(store()).toMatchObject({ currentChannelId: OLD, voiceStatus: "connected" });

    disconnected()!(/* SERVER_SHUTDOWN */ 1);
    expect(store().voiceStatus).toBe("reconnecting");

    joinVoiceChannel(NEW);
    noteJoinSent("join-new");
    expect(store()).toMatchObject({ currentChannelId: NEW, voiceStatus: "joining" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(voice.isAutoReconnecting()).toBe(false);
    expect(voice.getRoomForStats()).toBeNull();
    expect(store()).toMatchObject({ currentChannelId: NEW, voiceStatus: "joining" });
    expect(left()).toBe(0);
  });

  afterEach(unwireVoice);

  // The server answers an accepted switch with three frames: the old
  // channel's leave, the new channel's row, then the token.
  it("connects the new channel when the server accepts the join", async () => {
    handleVoiceLeave({ channel_id: OLD, user_id: SELF }, clock);
    handleVoiceState(ws, selfRow(NEW));
    await vi.advanceTimersByTimeAsync(0);
    expect(store()).toMatchObject({ currentChannelId: NEW, voiceStatus: "joining" });

    handleVoiceTokenFrame(tokenFor(NEW));
    await vi.advanceTimersByTimeAsync(0);
    expect(voice.getRoomForStats()).not.toBeNull();
    expect(store()).toMatchObject({ currentChannelId: NEW, voiceStatus: "connected" });

    // The wait for the answer is over: nothing ends the new call later.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(store()).toMatchObject({ currentChannelId: NEW, voiceStatus: "connected" });
    expect(left()).toBe(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it("ends the old call on the server when the join is refused", async () => {
    handleVoiceJoinRollback(ws, { code: "FORBIDDEN", message: "" }, "join-new");
    await vi.advanceTimersByTimeAsync(0);

    expect(left()).toBe(1);
    expect(voice.isVoiceSessionActive()).toBe(false);
    expect(store()).toMatchObject({ currentChannelId: null, voiceStatus: "idle" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends the call like a give-up when no answer comes", async () => {
    await vi.advanceTimersByTimeAsync(15_000);

    expect(left()).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(voice.isVoiceSessionActive()).toBe(false);
    expect(store()).toMatchObject({ currentChannelId: null, voiceStatus: "idle" });
  });

  // In the app every join also has its own wait, counted from the click: it
  // runs out first and ends the call once, like any join with no answer.
  it("ends through the join's own wait when that runs out first", async () => {
    setConnectionStatus("connected");
    setJoinAnswerWait(joinAnswerWaitFor(ws));
    try {
      // 15 s after the click; the hand-over itself came 3 s later.
      await vi.advanceTimersByTimeAsync(12_000);
      expect(store()).toMatchObject({ currentChannelId: null, voiceStatus: "idle" });
      expect(voice.isVoiceSessionActive()).toBe(false);
      expect(left()).toBe(1);

      await vi.advanceTimersByTimeAsync(15_000);
      expect(left()).toBe(1);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      setJoinAnswerWait(null);
      setConnectionStatus("disconnected");
    }
  });
});

// The frames of several joins interleave when the user clicks faster than the
// server answers. Whatever the order, the server must not be left holding a
// call that this client does not show.
describe("voice join answers that arrive after the user clicked on", () => {
  beforeEach(wireVoice);
  afterEach(unwireVoice);

  it("completes a switch when the old call's own row arrives after the click", async () => {
    click(OLD, "join-old");
    await granted(OLD);
    expect(store()).toMatchObject({ currentChannelId: OLD, voiceStatus: "connected" });

    click(NEW, "join-new");
    // A mute toggled just before the click, echoed back after it.
    handleVoiceState(ws, { ...selfRow(OLD), muted: true });
    expect(store()).toMatchObject({ currentChannelId: NEW, voiceStatus: "joining" });

    handleVoiceLeave({ channel_id: OLD, user_id: SELF }, clock);
    await granted(NEW);

    expect(store()).toMatchObject({ currentChannelId: NEW, voiceStatus: "connected" });
    expect(left()).toBe(0);
  });

  // The user's last click was the old channel and the server ends there too.
  // The leave that arrives in between ends the first stay in it, not the one
  // the last click asked for, so it must not end the call.
  it("stays in the last clicked channel when the answers of three quick clicks cross", async () => {
    click(OLD, "join-1");
    click(NEW, "join-2");
    click(OLD, "join-3");

    await granted(OLD);
    // The second join leaves the old channel on its way to the new one.
    handleVoiceLeave({ channel_id: OLD, user_id: SELF }, clock);
    await granted(NEW);
    handleVoiceLeave({ channel_id: NEW, user_id: SELF }, clock);
    await granted(OLD);

    // Both sides agree on the old channel, and nothing told the server to end it.
    expect(store()).toMatchObject({ currentChannelId: OLD, voiceStatus: "connected" });
    expect(voice.isVoiceSessionActive()).toBe(true);
    expect(left()).toBe(0);
  });

  it("gives back a call granted for a channel the user left for a refused one", async () => {
    click(OLD, "join-old");
    click(NEW, "join-new");

    await granted(OLD);
    expect(store()).toMatchObject({ currentChannelId: NEW, voiceStatus: "joining" });
    expect(voice.isVoiceSessionActive()).toBe(false);

    handleVoiceJoinRollback(ws, { code: "FORBIDDEN", message: "" }, "join-new");
    await vi.advanceTimersByTimeAsync(0);

    expect(store()).toMatchObject({ currentChannelId: null, voiceStatus: "idle" });
    expect(left()).toBe(1);
  });

  it("answers a token that follows the user's own Disconnect with one bare leave", async () => {
    click(OLD, "join-old");
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: null, voiceStatus: "idle" }));

    handleVoiceTokenFrame(tokenFor(OLD));
    await vi.advanceTimersByTimeAsync(0);

    // No session starts, and the server is told so.
    expect(left()).toBe(1);
    expect(voice.getRoomForStats()).toBeNull();
  });
});

const THIRD = 5;
const socket = ws as unknown as WsClient;
const sidebar = createSidebarVoiceCallbacks(socket);
const widget = createVoiceWidgetCallbacks(socket, {
  voice: { tryConsume: () => true },
  voiceVideo: { tryConsume: () => true },
});

let joinsSent = 0;
/** The server refuses the join this client sent last. */
function refuse(code: Payload<"error">["code"]): void {
  handleVoiceJoinRollback(ws, { code, message: "" }, `join-${joinsSent}`);
}
/** The server's notice that this user left `channelId`. */
function leaveEcho(channelId: number): void {
  handleVoiceLeave({ channel_id: channelId, user_id: SELF }, clock);
}
const settle = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0);
const inCall = (channelId: number) => ({ currentChannelId: channelId, voiceStatus: "connected" });

/** Three voice channels, a live chat socket and the real click callbacks' wiring. */
function wireClicks(): void {
  wireVoice();
  joinsSent = 0;
  send.mockImplementation((msg) => (msg.type === "voice_join" ? `join-${++joinsSent}` : undefined));
  channelsStore.setState((prev) => ({
    ...prev,
    channels: new Map([...prev.channels, [THIRD, { id: THIRD, type: "voice" } as never]]),
  }));
  setConnectionStatus("connected");
  setJoinAnswerWait(joinAnswerWaitFor(ws));
  noteJoinSucceeded();
}

function unwireClicks(): void {
  setJoinAnswerWait(null);
  send.mockReset();
  setConnectionStatus("disconnected");
  unwireVoice();
}

describe("a click on another channel before the first join is settled", () => {
  beforeEach(wireClicks);
  afterEach(unwireClicks);

  describe("while the first channel's room is still connecting", () => {
    /** The first join's token arrived and its room connects only after the
     *  click on the second channel. */
    beforeEach(async () => {
      const connecting = createDeferred();
      mocks.mockRoom.connect.mockReturnValue(connecting.promise);
      sidebar.onVoiceJoin(OLD);
      handleVoiceTokenFrame(tokenFor(OLD));
      await settle();
      sidebar.onVoiceJoin(NEW);

      connecting.resolve();
      await settle();
      expect(voice.isVoiceSessionActive()).toBe(true);
    });

    it("keeps showing the second channel as connecting once the first room is up", () => {
      expect(store()).toMatchObject({ currentChannelId: NEW, voiceStatus: "joining" });
      expect(left()).toBe(0);
    });

    it("ends the first channel's call on both sides when the second is refused", async () => {
      refuse("FORBIDDEN");
      await settle();

      expect(store()).toMatchObject({ currentChannelId: null, voiceStatus: "idle" });
      expect(voice.isVoiceSessionActive()).toBe(false);
      expect(left()).toBe(1);
    });

    it("ends it too when the second join gets no answer", async () => {
      await vi.advanceTimersByTimeAsync(15_000);

      expect(store()).toMatchObject({ currentChannelId: null, voiceStatus: "idle" });
      expect(voice.isVoiceSessionActive()).toBe(false);
      expect(left()).toBe(1);
    });

    it("connects the second channel when its token arrives", async () => {
      leaveEcho(OLD);
      await granted(NEW);

      expect(store()).toMatchObject(inCall(NEW));
      expect(left()).toBe(0);
    });
  });

  it("gives back a call whose answer was lost when the next join is refused", async () => {
    // The server granted the first join; its token never arrived.
    sidebar.onVoiceJoin(OLD);
    sidebar.onVoiceJoin(NEW);

    refuse("FORBIDDEN");
    await settle();

    expect(store()).toMatchObject({ currentChannelId: null, voiceStatus: "idle" });
    expect(left()).toBe(1);
    expect(send.mock.calls.at(-1)?.[0]).toEqual({ type: "voice_leave", payload: {} });
  });
});

describe("clicks on voice channels while in a live call", () => {
  beforeEach(async () => {
    wireClicks();
    sidebar.onVoiceJoin(OLD);
    await granted(OLD);
    expect(store()).toMatchObject(inCall(OLD));
  });

  afterEach(unwireClicks);

  it.each(["PASSWORD_REQUIRED", "WRONG_PASSWORD", "CHANNEL_FULL", "FORBIDDEN"] as const)(
    "keeps the call when the server refuses the switch with %s",
    async (code) => {
      sidebar.onVoiceJoin(NEW);
      // The call the user is in stays on screen while the server decides.
      expect(store()).toMatchObject({ ...inCall(OLD), switchingTo: NEW });

      refuse(code);
      await settle();

      expect(store()).toMatchObject({ ...inCall(OLD), switchingTo: null });
      expect(voice.isVoiceSessionActive()).toBe(true);
      expect(voice.getRoomForStats()).not.toBeNull();

      // Nothing ends it later either.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(store()).toMatchObject(inCall(OLD));
      expect(left()).toBe(0);
      expect(onError).not.toHaveBeenCalled();
    },
  );

  it("moves to the new channel when the old call's leave arrives first", async () => {
    sidebar.onVoiceJoin(NEW);

    leaveEcho(OLD);
    expect(store()).toMatchObject({ currentChannelId: NEW, voiceStatus: "joining" });
    expect(store().switchingTo).toBeNull();

    handleVoiceState(ws, selfRow(NEW));
    handleVoiceTokenFrame(tokenFor(NEW));
    await settle();
    expect(store()).toMatchObject(inCall(NEW));
    expect(left()).toBe(0);
  });

  it("moves to the new channel when its token overtakes the old call's leave", async () => {
    sidebar.onVoiceJoin(NEW);

    await granted(NEW);
    expect(store()).toMatchObject({ ...inCall(NEW), switchingTo: null });

    leaveEcho(OLD);
    await settle();
    expect(store()).toMatchObject(inCall(NEW));
    expect(voice.isVoiceSessionActive()).toBe(true);
    expect(store().voiceUsers.get(OLD)?.has(SELF) ?? false).toBe(false);
    expect(left()).toBe(0);
  });

  it("sends nothing for another click while the switch waits for the server", () => {
    sidebar.onVoiceJoin(NEW);
    sidebar.onVoiceJoin(THIRD);
    sidebar.onVoiceJoin(NEW);

    expect(joinsSent).toBe(2);
    expect(store()).toMatchObject({ ...inCall(OLD), switchingTo: NEW });
  });

  it("ends the call like the user's own Disconnect when the switch gets no answer", async () => {
    sidebar.onVoiceJoin(NEW);

    await vi.advanceTimersByTimeAsync(15_000);

    // Which channel the server holds is unknown, so both sides end on none.
    expect(store()).toMatchObject({ currentChannelId: null, voiceStatus: "idle" });
    expect(store().switchingTo).toBeNull();
    expect(voice.isVoiceSessionActive()).toBe(false);
    expect(left()).toBe(1);
  });

  describe("Disconnect, then the same channel again", () => {
    beforeEach(() => {
      widget.onDisconnect();
      sidebar.onVoiceJoin(OLD);
      expect(left()).toBe(1);
      expect(store()).toMatchObject({ currentChannelId: OLD, voiceStatus: "joining" });
    });

    it("joins when the first call's leave arrives before the new answer", async () => {
      leaveEcho(OLD);
      expect(store()).toMatchObject({ currentChannelId: OLD, voiceStatus: "joining" });

      await granted(OLD);
      expect(store()).toMatchObject(inCall(OLD));
      expect(voice.isVoiceSessionActive()).toBe(true);
      expect(left()).toBe(1);
    });

    it("stays in the call when the first call's leave arrives after the new token", async () => {
      await granted(OLD);
      expect(store()).toMatchObject(inCall(OLD));

      leaveEcho(OLD);
      await settle();
      expect(store()).toMatchObject(inCall(OLD));
      expect(store().voiceUsers.get(OLD)?.has(SELF)).toBe(true);
      expect(voice.isVoiceSessionActive()).toBe(true);
      expect(left()).toBe(1);
    });

    it("still ends the call on a leave that follows the first call's own", async () => {
      await granted(OLD);
      leaveEcho(OLD);
      await settle();

      // A moderator's disconnect of the call the user is in now.
      leaveEcho(OLD);
      await settle();
      expect(store()).toMatchObject({ currentChannelId: null, voiceStatus: "idle" });
      expect(voice.isVoiceSessionActive()).toBe(false);
    });
  });

  it("ends the call on a leave after a refusal that came once the user had left", async () => {
    widget.onDisconnect();
    sidebar.onVoiceJoin(NEW);
    widget.onDisconnect();
    // The answer to a join the user no longer waits for.
    refuse("CHANNEL_FULL");
    sidebar.onVoiceJoin(NEW);
    await granted(NEW);
    expect(store()).toMatchObject(inCall(NEW));

    // The server takes the user out of the channel: nothing earlier explains it.
    leaveEcho(NEW);
    await settle();
    expect(store()).toMatchObject({ currentChannelId: null, voiceStatus: "idle" });
    expect(voice.isVoiceSessionActive()).toBe(false);
  });

  it("ends in the last clicked channel when three switches cross their answers", async () => {
    sidebar.onVoiceJoin(NEW);
    await granted(NEW);
    // Back to the old channel before its leave from the first switch arrived.
    sidebar.onVoiceJoin(OLD);
    expect(store()).toMatchObject({ ...inCall(NEW), switchingTo: OLD });

    // The first switch's leave: about the first stay in the old channel.
    leaveEcho(OLD);
    await settle();
    expect(store()).toMatchObject({ ...inCall(NEW), switchingTo: OLD });

    leaveEcho(NEW);
    await granted(OLD);
    expect(store()).toMatchObject(inCall(OLD));
    expect(voice.isVoiceSessionActive()).toBe(true);
    expect(left()).toBe(0);
  });

  it("keeps the call when an earlier stay's leave arrives while a refused switch waits", async () => {
    widget.onDisconnect();
    sidebar.onVoiceJoin(OLD);
    await granted(OLD);
    sidebar.onVoiceJoin(NEW);

    // The Disconnect's leave, late: not the server acting on the switch.
    leaveEcho(OLD);
    expect(store()).toMatchObject({ ...inCall(OLD), switchingTo: NEW });

    refuse("PASSWORD_REQUIRED");
    await settle();
    expect(store()).toMatchObject({ ...inCall(OLD), switchingTo: null });
    expect(voice.isVoiceSessionActive()).toBe(true);
    expect(left()).toBe(1);
  });

  it("ends on no call on both sides when a third channel refuses after a granted second", async () => {
    sidebar.onVoiceJoin(NEW);
    leaveEcho(OLD);
    // On to a third channel before the second one's token arrived.
    vi.setSystemTime(Date.now() + 5_000);
    sidebar.onVoiceJoin(THIRD);
    expect(store()).toMatchObject({ currentChannelId: THIRD, voiceStatus: "joining" });

    await granted(NEW);
    expect(store()).toMatchObject({ currentChannelId: THIRD, voiceStatus: "joining" });
    expect(left()).toBe(0);

    refuse("FORBIDDEN");
    await settle();

    // The server held the second channel: one leave gives it back.
    expect(store()).toMatchObject({ currentChannelId: null, voiceStatus: "idle" });
    expect(voice.isVoiceSessionActive()).toBe(false);
    expect(left()).toBe(1);
  });
});
