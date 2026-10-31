import { describe, it, expect, vi, beforeEach } from "vitest";
import * as dispatcherMocks from "../../helpers/dispatcherMocks";
import { expectConsole } from "../../helpers/console";
import { authStore } from "../../../src/stores/auth.store";
import { voiceStore } from "../../../src/stores/voice.store";
import { uiStore, setTransientError } from "../../../src/stores/ui.store";
import { leaveVoice as mockLeaveVoice } from "@lib/voice/livekitSession";
import { takeJoinRefusal } from "../../../src/features/voice/joinRequest";
import {
  useDispatcherHarness,
  readyChannel,
  readyDm,
  readyMember,
  patchAuth,
  patchVoice,
  mock,
} from "../../helpers/dispatcherHarness";

vi.mock("@lib/notifications", () => dispatcherMocks.notificationsMock());
vi.mock("@lib/voice/livekitSession", () => dispatcherMocks.livekitSessionMock());
vi.mock("@lib/voice/screenShare", () => dispatcherMocks.screenShareMock());
vi.mock("@lib/ui/toast", () => dispatcherMocks.toastMock());
vi.mock("@lib/net/identity", () => dispatcherMocks.identityMock());
vi.mock("../../../src/features/connection/dispatchContext", async (importOriginal) =>
  dispatcherMocks.dispatchContextMock(await importOriginal<object>()),
);

describe("WS Dispatcher", () => {
  useDispatcherHarness();

  it("keeps the session and sets no transient error for any server_restart reason", () => {
    setTransientError(null);
    patchAuth({
      isAuthenticated: true,
      user: { id: 1, username: "stay-user", avatar: null, role: "member" },
    });

    for (const reason of ["update", "backup_restore", "setup", "shutdown", null]) {
      mock.dispatch("server_restart", { reason, delay_seconds: 5 });
      expectConsole("warn", /\[dispatcher\] Server restarting/);
      expect(authStore.getState().isAuthenticated).toBe(true);
      expect(authStore.getState().logoutReason).toBeUndefined();
      expect(uiStore.getState().transientError).toBeNull();
    }
  });

  it("leaves the call intact through an update notice that is then aborted", async () => {
    vi.mocked(mockLeaveVoice).mockClear();
    patchVoice({ currentChannelId: 42, voiceStatus: "connected" });

    mock.dispatch("server_restart", { reason: "update", delay_seconds: 5 });
    expectConsole("warn", /\[dispatcher\] Server restarting/);
    mock.dispatch("server_restart", { reason: "update_aborted", delay_seconds: 0 });
    expectConsole("warn", /\[dispatcher\] Server restarting/);
    // A later, unrelated drop is not the withdrawn restart.
    mock.dispatchState("reconnecting");

    await vi.runAllTimersAsync();
    expect(mockLeaveVoice).not.toHaveBeenCalled();
    const voice = voiceStore.getState();
    expect(voice.currentChannelId).toBe(42);
    expect(voice.voiceStatus).toBe("connected");
  });

  it("keeps the session through an announced restart and ends the call when the socket drops (Q4)", async () => {
    vi.mocked(mockLeaveVoice).mockClear();
    patchAuth({
      isAuthenticated: true,
      user: { id: 1, username: "call-user", avatar: null, role: "member" },
    });
    patchVoice({ currentChannelId: 42, voiceStatus: "connected" });

    // The hub's teardown notice names the restart's intent, not "shutdown".
    mock.dispatch("server_restart", { reason: "update", delay_seconds: 5 });
    expectConsole("warn", /\[dispatcher\] Server restarting/);
    await vi.runAllTimersAsync();
    // The notice alone leaves the call: the restart can still be aborted.
    expect(mockLeaveVoice).not.toHaveBeenCalled();
    expect(voiceStore.getState().currentChannelId).toBe(42);

    mock.dispatchState("reconnecting");

    // Still signed in: ws.ts reconnects and resumes on its own.
    expect(authStore.getState().isAuthenticated).toBe(true);
    expect(authStore.getState().logoutReason).toBeUndefined();

    // The call does not survive the server process: the LiveKit session
    // closes (leaveVoice also turns camera and screenshare off) and the
    // voice channel is left.
    await vi.runAllTimersAsync();
    expect(mockLeaveVoice).toHaveBeenCalledWith(false);
    const voice = voiceStore.getState();
    expect(voice.currentChannelId).toBeNull();
    expect(voice.voiceStatus).toBe("idle");
  });

  it("keeps the call through an ordinary socket drop with no restart announced", async () => {
    vi.mocked(mockLeaveVoice).mockClear();
    patchVoice({ currentChannelId: 42, voiceStatus: "connected" });

    mock.dispatchState("reconnecting");
    await vi.runAllTimersAsync();

    expect(mockLeaveVoice).not.toHaveBeenCalled();
    expect(voiceStore.getState().currentChannelId).toBe(42);
  });

  // RT-12: a planned restart ends server-side voice membership (the hub wipes
  // voice_states on boot), so a plain reconnect leaves the user outside the
  // call. The restart drop records the channel; once ready confirms we are
  // not in it, one normal voice_join puts us back.
  describe("rejoin after a planned restart", () => {
    function announceRestart(reason = "update"): void {
      mock.dispatch("server_restart", { reason, delay_seconds: 5 });
      expectConsole("warn", /\[dispatcher\] Server restarting/);
    }

    function announceRestartAndDrop(reason = "update"): void {
      announceRestart(reason);
      mock.dispatchState("reconnecting");
    }

    const voiceChannels = (): unknown[] => [readyChannel({ id: 42, name: "voice", type: "voice" })];

    function expectNoRejoin(): void {
      expect(mock.ws.send).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "voice_join" }),
      );
    }

    function readyAfterRestart(channels: unknown[], dmChannels: unknown[] = []): void {
      mock.dispatch("ready", {
        channels,
        dm_channels: dmChannels,
        members: [readyMember({ id: 5, username: "me" })],
        // The restarted hub wiped voice_states: we are not in the call.
        voice_states: [],
        roles: [],
      });
    }

    beforeEach(() => {
      patchAuth({
        isAuthenticated: true,
        user: { id: 5, username: "me", avatar: null, role: "member" },
      });
      patchVoice({ currentChannelId: 42, voiceStatus: "connected" });
      vi.mocked(mock.ws.send).mockClear();
      vi.mocked(mockLeaveVoice).mockClear();
    });

    it("sends one voice_join for the channel we were in when ready shows we left", async () => {
      announceRestartAndDrop();
      await vi.runAllTimersAsync();
      expect(voiceStore.getState().currentChannelId).toBeNull();

      readyAfterRestart(voiceChannels());

      expect(mock.ws.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "voice_join", payload: { channel_id: 42 } }),
      );
      expect(takeJoinRefusal("FORBIDDEN", "test-id")).toBe(true);
      expect(voiceStore.getState().currentChannelId).toBe(42);
    });

    it("does not rejoin after a moderator kick", async () => {
      announceRestartAndDrop();
      // The kick lands before ready: it must cancel the pending rejoin.
      mock.dispatch("voice_disconnected", { channel_id: 42, reason: "kicked" });
      await vi.runAllTimersAsync();

      readyAfterRestart(voiceChannels());

      expectNoRejoin();
      expect(voiceStore.getState().currentChannelId).toBeNull();
    });

    it("does not rejoin after the user leaves voice", async () => {
      announceRestartAndDrop();
      // The user leaves for real: a self voice_leave cancels the rejoin.
      mock.dispatch("voice_leave", { channel_id: 42, user_id: 5 });
      await vi.runAllTimersAsync();

      readyAfterRestart(voiceChannels());

      expectNoRejoin();
    });

    it("does not rejoin after a moderator kick during the countdown", async () => {
      announceRestart();
      mock.dispatch("voice_leave", { channel_id: 42, user_id: 5 });
      mock.dispatch("voice_disconnected", { channel_id: 42, reason: "kicked" });
      mock.dispatchState("reconnecting");
      await vi.runAllTimersAsync();

      readyAfterRestart(voiceChannels());

      expectNoRejoin();
    });

    it("does not rejoin after the user leaves voice during the countdown", async () => {
      announceRestart();
      mock.dispatch("voice_leave", { channel_id: 42, user_id: 5 });
      mock.dispatchState("reconnecting");
      await vi.runAllTimersAsync();

      readyAfterRestart(voiceChannels());

      expectNoRejoin();
    });

    it("rejoins the channel the user switched to during the countdown", async () => {
      announceRestart();
      // The switch moves the store optimistically, then the server leaves the old channel.
      patchVoice({ currentChannelId: 43 });
      mock.dispatch("voice_leave", { channel_id: 42, user_id: 5 });
      mock.dispatchState("reconnecting");
      await vi.runAllTimersAsync();

      readyAfterRestart([
        { id: 42, name: "voice", type: "voice", category: null, position: 0 },
        { id: 43, name: "voice-2", type: "voice", category: null, position: 1 },
      ]);

      expect(mock.ws.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "voice_join", payload: { channel_id: 43 } }),
      );
      expect(voiceStore.getState().currentChannelId).toBe(43);
    });

    it("does not rejoin when the channel is gone from ready", async () => {
      announceRestartAndDrop();
      await vi.runAllTimersAsync();

      readyAfterRestart([readyChannel({ id: 7 })]);

      expectNoRejoin();
    });

    it("rejoins a DM call, which ready lists under dm_channels", async () => {
      announceRestartAndDrop("backup_restore");
      await vi.runAllTimersAsync();

      readyAfterRestart(
        [],
        [
          readyDm({
            channel_id: 42,
            recipient: { id: 6, username: "friend", avatar: "", status: "online" },
            recipients: [{ id: 6, username: "friend", avatar: "", status: "online" }],
          }),
        ],
      );

      expect(mock.ws.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "voice_join", payload: { channel_id: 42 } }),
      );
    });

    it("rejoins after a shutdown restart from outside the server within its shorter window", async () => {
      announceRestartAndDrop("shutdown");
      await vi.runAllTimersAsync();
      // D-2: a systemctl/docker restart that is back quickly looks like a blip.
      vi.setSystemTime(Date.now() + 60_000);

      readyAfterRestart(voiceChannels());

      const joins = vi
        .mocked(mock.ws.send)
        .mock.calls.filter(([msg]) => (msg as { type?: string }).type === "voice_join");
      expect(joins).toHaveLength(1);
      expect(voiceStore.getState().currentChannelId).toBe(42);
    });

    it("does not rejoin when ready arrives after a shutdown notice's 2-minute window", async () => {
      announceRestartAndDrop("shutdown");
      await vi.runAllTimersAsync();
      vi.setSystemTime(Date.now() + 3 * 60_000);

      readyAfterRestart(voiceChannels());

      expectNoRejoin();
    });

    it("does not rejoin when ready arrives more than 10 minutes after the notice", async () => {
      announceRestartAndDrop();
      await vi.runAllTimersAsync();
      vi.setSystemTime(Date.now() + 10 * 60_000 + 1);

      readyAfterRestart(voiceChannels());

      expectNoRejoin();
    });

    it("does not rejoin an ordinary reconnect with no restart announced", async () => {
      mock.dispatchState("reconnecting");
      await vi.runAllTimersAsync();

      readyAfterRestart(voiceChannels());

      expectNoRejoin();
    });
  });
});
