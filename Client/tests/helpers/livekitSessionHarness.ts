import { vi, beforeEach, afterEach } from "vitest";
import { LiveKitSession } from "../../src/lib/voice/livekitSession";
import { channelsStore, resetChannelsStore } from "@stores/channels.store";
import { mockLoadPref, mockVoiceState, mockRoom } from "./livekitSessionMocks";

/** A roster in which the server still holds every membership. */
export const membershipHeld = { get: () => ({ has: () => true }) };

export function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export interface LiveKitSessionHarnessBinding {
  wired(session: LiveKitSession): void;
  currentSession(): LiveKitSession;
}

/** Registers the shared beforeEach/afterEach for the "LiveKitSession" describe. */
export function useLiveKitSessionHarness(binding: LiveKitSessionHarnessBinding): void {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockVoiceState.localMuted = false;
    mockVoiceState.localDeafened = false;
    mockVoiceState.localServerMuted = false;
    mockVoiceState.localServerDeafened = false;
    mockVoiceState.localCamera = false;
    mockVoiceState.localScreenshare = false;
    mockVoiceState.pttGated = false;
    mockVoiceState.inAfkChannel = false;
    mockVoiceState.currentChannelId = 1;
    mockVoiceState.voiceConfigs = new Map();
    mockVoiceState.voiceStatus = "idle";
    mockVoiceState.voiceUsers = membershipHeld;
    // The reconnect loop only retries into a channel that still exists, over a
    // chat socket that is not closed for good.
    channelsStore.setState((prev) => ({
      ...prev,
      channels: new Map([1, 5, 7, 9, 11].map((id) => [id, { id, type: "voice" } as any])),
    }));
    const session = new LiveKitSession();
    session.setWsClient({
      send: vi.fn(),
      getState: () => "connected",
      ping: async () => {},
    } as any);
    // Reset mockRoom state
    mockRoom.state = "connected";
    mockRoom.remoteParticipants = new Map();
    mockRoom.localParticipant.getTrackPublication.mockReturnValue(undefined);
    mockRoom.localParticipant.trackPublications = new Map();
    mockRoom.connect.mockResolvedValue(undefined);
    mockRoom.localParticipant.setMicrophoneEnabled.mockResolvedValue(undefined);
    binding.wired(session);
  });

  afterEach(() => {
    binding.currentSession().cleanupAll();
    resetChannelsStore();
    vi.useRealTimers();
  });
}

type ReconnectInternals = {
  _state: unknown;
  attemptAutoReconnect(
    token: string,
    url: string,
    channelId: number,
    directUrl: string | undefined,
    signal: AbortSignal,
  ): Promise<void>;
};

export interface ReconnectingStateOverrides {
  readonly latestToken?: string;
  readonly lastUrl?: string;
  readonly lastDirectUrl?: string | undefined;
}

/** Puts `session` mid-reconnect into `channelId`, as the connection drop leaves it. */
export function enterReconnecting(
  session: LiveKitSession,
  channelId: number,
  over: ReconnectingStateOverrides = {},
): void {
  (session as unknown as ReconnectInternals)._state = {
    type: "reconnecting",
    channelId,
    latestToken: "reconnect-token",
    lastUrl: "/livekit",
    lastDirectUrl: "ws://localhost:7880",
    ac: new AbortController(),
    ...over,
  };
}

export interface ReconnectAttemptOptions {
  readonly token?: string;
  readonly url?: string;
  readonly directUrl?: string | undefined;
  readonly signal?: AbortSignal;
}

/** Starts `attemptAutoReconnect` and returns its promise without driving the timers. */
export function startReconnect(
  session: LiveKitSession,
  channelId: number,
  opts: ReconnectAttemptOptions = {},
): Promise<void> {
  return (session as unknown as ReconnectInternals).attemptAutoReconnect(
    opts.token ?? "reconnect-token",
    opts.url ?? "/livekit",
    channelId,
    "directUrl" in opts ? opts.directUrl : "ws://localhost:7880",
    opts.signal ?? new AbortController().signal,
  );
}

/** Runs one reconnect attempt through its first backoff wait to its end. */
export async function runReconnect(
  session: LiveKitSession,
  channelId: number,
  opts: ReconnectAttemptOptions = {},
): Promise<void> {
  const attempt = startReconnect(session, channelId, opts);
  await vi.advanceTimersByTimeAsync(3100);
  await attempt;
}

type WsClientArg = Parameters<LiveKitSession["setWsClient"]>[0];

/** Joins channel 1 through a socket whose `send` the caller can inspect. */
export async function joinWithWs(
  session: LiveKitSession,
): Promise<{ send: ReturnType<typeof vi.fn> }> {
  const ws = { send: vi.fn() };
  session.setWsClient(ws as unknown as WsClientArg);
  session.setServerHost("localhost:7880");
  mockRoom.connect.mockResolvedValue(undefined);
  await session.handleVoiceToken("token", "/livekit", 1, "ws://localhost:7880", true);
  return ws;
}

/** Joins channel 1 over a socket that discards what it is sent. */
export async function joinSession(
  session: LiveKitSession,
  token = "test-token",
  url = "/livekit",
): Promise<void> {
  session.setServerHost("localhost:7880");
  session.setWsClient({ send: vi.fn() } as unknown as WsClientArg);
  await session.handleVoiceToken(token, url, 1, "ws://localhost:7880", true);
}

export interface ConnectedStateOverrides {
  readonly room?: unknown;
  readonly latestToken?: string;
  readonly lastUrl?: string;
  readonly lastDirectUrl?: string | undefined;
}

/** Puts `session` in the connected state for `channelId` over `mockRoom`. */
export function enterConnected(
  session: LiveKitSession,
  channelId = 1,
  over: ConnectedStateOverrides = {},
): void {
  (session as unknown as ReconnectInternals)._state = {
    type: "connected",
    room: mockRoom,
    channelId,
    latestToken: "token",
    lastUrl: "/livekit",
    lastDirectUrl: undefined,
    ...over,
  };
}

/** Makes `loadPref` return `values` for their keys and the caller's default for the rest. */
export function stubPrefs(values: Record<string, unknown> = {}): void {
  mockLoadPref.mockImplementation((key: string, defaultVal: unknown) =>
    key in values ? values[key] : defaultVal,
  );
}
