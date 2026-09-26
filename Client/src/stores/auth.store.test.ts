import { describe, it, expect } from "vitest";
import { authStore, clearAuth } from "./auth.store";
import { voiceStore } from "./voice.store";

// auth.store no longer imports voice.store; voice.store registers its logout
// teardown at load. This fails if that registration is dropped.
describe("clearAuth voice teardown registration", () => {
  it("snapshots then resets the voice store registered by voice.store", () => {
    voiceStore.setState((s) => ({ ...s, currentChannelId: 7 }));

    clearAuth();

    expect(voiceStore.getState().currentChannelId).toBeNull();
    expect(authStore.getState().logoutWasInVoice).toBe(true);
  });
});
