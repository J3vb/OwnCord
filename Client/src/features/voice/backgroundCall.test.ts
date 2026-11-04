import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("../../platform/desktop", () => ({ desktop: { callService: { update: host.update } } }));

import { startBackgroundCall } from "./backgroundCall";
import { resetVoiceStore, voiceStore, type VoiceStatus } from "../../stores/voice.store";

function setCall(channel: number | null, status: VoiceStatus, camera = false): void {
  voiceStore.setState((s) => ({
    ...s,
    currentChannelId: channel,
    voiceStatus: status,
    localCamera: camera,
  }));
  voiceStore.flush();
}

describe("background call service", () => {
  let owner: AbortController;

  beforeEach(() => {
    resetVoiceStore();
    host.update.mockReset();
    owner = new AbortController();
  });

  afterEach(() => owner.abort());

  it("starts at joining, follows the camera, and stops on leave", () => {
    startBackgroundCall(owner.signal);
    setCall(7, "joining");
    setCall(7, "connected");
    setCall(7, "connected", true);
    setCall(7, "connected", false);
    setCall(null, "idle");
    expect(host.update.mock.calls).toEqual([
      [{ active: true, camera: false }],
      [{ active: true, camera: true }],
      [{ active: true, camera: false }],
      [{ active: false, camera: false }],
    ]);
  });

  it("keeps one running service through a reconnect and a quick rejoin", () => {
    startBackgroundCall(owner.signal);
    setCall(7, "connected", true);
    setCall(7, "reconnecting", true);
    setCall(7, "connected", true);
    // Leave and rejoin within one store batch: no stop is sent in between.
    voiceStore.setState((s) => ({ ...s, currentChannelId: null, voiceStatus: "idle" }));
    voiceStore.setState((s) => ({ ...s, currentChannelId: 9, voiceStatus: "joining" }));
    voiceStore.flush();
    expect(host.update.mock.calls).toEqual([[{ active: true, camera: true }]]);
  });

  it("never reports a camera outside a call", () => {
    startBackgroundCall(owner.signal);
    setCall(null, "idle", true);
    expect(host.update).not.toHaveBeenCalled();
  });

  it("stops a running service when its owner goes away", () => {
    setCall(7, "connected");
    startBackgroundCall(owner.signal);
    expect(host.update.mock.calls).toEqual([[{ active: true, camera: false }]]);
    owner.abort();
    setCall(null, "idle");
    expect(host.update.mock.calls).toEqual([
      [{ active: true, camera: false }],
      [{ active: false, camera: false }],
    ]);
  });
});
