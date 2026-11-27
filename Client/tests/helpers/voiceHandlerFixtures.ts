// Shared fixtures for the voice wsHandlers tests: this user is id 9, and a
// call this device holds is in channel 3.
import { vi } from "vitest";
import { authStore } from "../../src/stores/auth.store";
import { joinVoiceChannel, resetVoiceStore, setVoiceStatus } from "../../src/stores/voice.store";
import type { Payload, ReconnectClock } from "../../src/features/connection/dispatchContext";

export const voiceState = (overrides: Partial<Payload<"voice_state">>): Payload<"voice_state"> =>
  ({
    channel_id: 4,
    user_id: 9,
    username: "me",
    muted: false,
    deafened: false,
    speaking: false,
    ...overrides,
  }) as Payload<"voice_state">;

/** This device holds a call in channel 3. */
export const inCall = (): void => {
  joinVoiceChannel(3);
  setVoiceStatus("connected");
};

export const clockStub = (): ReconnectClock => ({ voiceRejoinChannelId: null }) as ReconnectClock;

export const socketStub = () => ({ send: vi.fn(), disconnect: vi.fn() });

export const readyWith = (voiceStates: Payload<"voice_state">[]) =>
  ({ voice_states: voiceStates }) as unknown as Payload<"ready">;

/** A fresh voice store, this user signed in as id 9, and every mock cleared. */
export function resetVoiceHandlerTest(): void {
  resetVoiceStore();
  authStore.setState((prev) => ({
    ...prev,
    user: { id: 9, username: "me", avatar: null, role: "member" },
  }));
  vi.clearAllMocks();
}
