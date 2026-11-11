// The real voice store, the dispatcher's own voice frame handlers and the
// session they reach, on two voice channels. The test file mocks LiveKit and
// the native edges (tests/helpers/livekitSessionMocks); everything here is the
// production code.
import { vi } from "vitest";
import * as mocks from "./livekitSessionMocks";
import * as voice from "../../src/lib/voice/livekitSession";
import { handleVoiceState, handleVoiceTokenFrame } from "../../src/features/voice/wsHandlers";
import type {
  DispatchWs,
  Payload,
  ReconnectClock,
} from "../../src/features/connection/dispatchContext";
import { resetVoiceStore, voiceStore } from "@stores/voice.store";
import { channelsStore, resetChannelsStore } from "@stores/channels.store";
import { resetJoinRequest } from "../../src/features/voice/joinRequest";

export const OLD = 1;
export const NEW = 9;
/** Nobody is signed in here, so this client's own user id reads 0. */
export const SELF = 0;

export function selfRow(channelId: number): Payload<"voice_state"> {
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

export function tokenFor(channelId: number): Payload<"voice_token"> {
  return {
    token: `token-${channelId}`,
    url: "/livekit",
    channel_id: channelId,
    direct_url: "ws://localhost:7880",
    is_key_holder: true,
  };
}

export const send = vi.fn<(msg: { type: string }) => string | undefined>();
export const onError = vi.fn<(message: string) => void>();
export const ws = { send, disconnect: vi.fn() } as unknown as DispatchWs;
export const clock = { voiceRejoinChannelId: null } as ReconnectClock;
/** How many voice_leave frames this client has sent. */
export const left = (): number => send.mock.calls.filter(([m]) => m.type === "voice_leave").length;
export const store = () => voiceStore.getState();

/** Two voice channels and a session on a live chat socket. */
export function wireVoice(): void {
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
}

export function unwireVoice(): void {
  voice.cleanupAll();
  resetJoinRequest();
  resetVoiceStore();
  resetChannelsStore();
  vi.useRealTimers();
}

/** The server's answer to an accepted join: its token, then the member's row. */
export async function granted(channelId: number): Promise<void> {
  handleVoiceTokenFrame(tokenFor(channelId));
  handleVoiceState(ws, selfRow(channelId));
  await vi.advanceTimersByTimeAsync(0);
}
