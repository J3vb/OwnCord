// A switch to another voice channel during an auto-reconnect, end to end: the
// real voice store, the dispatcher's own frame handlers and the session they
// reach. Only LiveKit and the native edges are stand-ins.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/livekitSessionMocks";
import * as voice from "../../../src/lib/voice/livekitSession";
import {
  handleVoiceJoinRollback,
  handleVoiceLeave,
  handleVoiceState,
  handleVoiceTokenFrame,
} from "../../../src/features/voice/wsHandlers";
import type {
  DispatchWs,
  Payload,
  ReconnectClock,
} from "../../../src/features/connection/dispatchContext";
import { joinVoiceChannel, resetVoiceStore, voiceStore } from "@stores/voice.store";
import { channelsStore, resetChannelsStore } from "@stores/channels.store";
import { noteJoinSent, resetJoinRequest } from "../../../src/features/voice/joinRequest";
import { captureDisconnectedHandler } from "../../helpers/livekitSessionHarness";

vi.mock("livekit-client", () => mocks.livekitClientMock());
vi.mock("@tauri-apps/api/core", () => mocks.apiCoreMock());
vi.mock("@lib/prefs/preferences", (importOriginal) => mocks.prefsPreferencesMock(importOriginal));
vi.mock("@lib/logger", () => mocks.loggerMock());
vi.mock("@lib/ui/toast", () => mocks.uiToastMock());
vi.mock("@lib/voice/noiseSuppression", () => mocks.voiceNoiseSuppressionMock());
vi.mock("@lib/net/e2eeCrypto", () => mocks.netE2eeCryptoMock());
vi.mock("@lib/net/identity", () => mocks.netIdentityMock());

const OLD = 1;
const NEW = 9;
/** Nobody is signed in here, so this client's own user id reads 0. */
const SELF = 0;

function selfRow(channelId: number): Payload<"voice_state"> {
  return {
    channel_id: channelId,
    user_id: SELF,
    username: "me",
    muted: false,
    deafened: false,
    speaking: false,
    camera: false,
    screenshare: false,
  };
}

function tokenFor(channelId: number): Payload<"voice_token"> {
  return {
    token: `token-${channelId}`,
    url: "/livekit",
    channel_id: channelId,
    direct_url: "ws://localhost:7880",
    is_key_holder: true,
  };
}

describe("a switch to another voice channel during an auto-reconnect", () => {
  const send = vi.fn<(msg: { type: string }) => string | undefined>();
  const onError = vi.fn<(message: string) => void>();
  const ws = { send, disconnect: vi.fn() } as unknown as DispatchWs;
  const clock = { voiceRejoinChannelId: null } as ReconnectClock;
  const left = () => send.mock.calls.filter(([m]) => m.type === "voice_leave").length;
  const store = () => voiceStore.getState();

  /** In the old channel, the room drops, the user clicks the new channel, and
   *  the loop hands the session to that join at its next check. */
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    channelsStore.setState((prev) => ({
      ...prev,
      channels: new Map([OLD, NEW].map((id) => [id, { id, type: "voice" } as never])),
    }));
    mocks.mockRoom.state = "connected";
    mocks.mockRoom.connect.mockResolvedValue(undefined);
    voice.setServerHost("localhost:7880");
    voice.setWsClient({ send, getState: () => "connected", ping: async () => {} } as never);
    voice.setOnError(onError);
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

  afterEach(() => {
    voice.cleanupAll();
    resetJoinRequest();
    resetVoiceStore();
    resetChannelsStore();
    vi.useRealTimers();
  });

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
    handleVoiceJoinRollback({ code: "FORBIDDEN", message: "" }, "join-new");
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
});
