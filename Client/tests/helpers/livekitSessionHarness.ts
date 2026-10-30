import { vi, beforeEach, afterEach } from "vitest";
import { LiveKitSession } from "../../src/lib/voice/livekitSession";
import { channelsStore, resetChannelsStore } from "@stores/channels.store";
import { mockVoiceState, mockRoom } from "./livekitSessionMocks";

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
