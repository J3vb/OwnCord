import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ enableCamera: vi.fn(), disableCamera: vi.fn() }));
vi.mock("../../lib/voice/livekitSession", () => session);

import { startBackgroundCamera } from "./backgroundCamera";
import { resetVoiceStore, voiceStore } from "../../stores/voice.store";

let vis: DocumentVisibilityState = "visible";

function setVisibility(next: DocumentVisibilityState): void {
  vis = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

function setCall(channel: number | null, camera: boolean, joinedAt: number | null = 1000): void {
  voiceStore.setState((s) => ({
    ...s,
    currentChannelId: channel,
    voiceStatus: channel === null ? "idle" : "connected",
    localCamera: camera,
    joinedAt: channel === null ? null : joinedAt,
  }));
  voiceStore.flush();
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

describe("background camera", () => {
  let owner: AbortController;

  beforeEach(() => {
    vis = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => vis });
    resetVoiceStore();
    session.enableCamera.mockReset().mockImplementation(async () => {
      voiceStore.setState((s) => ({ ...s, localCamera: true }));
    });
    session.disableCamera.mockReset().mockImplementation(async () => {
      voiceStore.setState((s) => ({ ...s, localCamera: false }));
    });
    owner = new AbortController();
  });

  afterEach(() => owner.abort());

  it("pauses the camera in the background and resumes it on return", async () => {
    setCall(7, true);
    startBackgroundCamera(owner.signal);
    setVisibility("hidden");
    await vi.waitFor(() => expect(session.disableCamera).toHaveBeenCalledTimes(1));
    expect(session.enableCamera).not.toHaveBeenCalled();
    setVisibility("visible");
    await vi.waitFor(() => expect(session.enableCamera).toHaveBeenCalledTimes(1));
    expect(session.disableCamera).toHaveBeenCalledTimes(1);
  });

  it("leaves a camera that was off alone on return", async () => {
    setCall(7, false);
    startBackgroundCamera(owner.signal);
    setVisibility("hidden");
    await settle();
    setVisibility("visible");
    await settle();
    expect(session.disableCamera).not.toHaveBeenCalled();
    expect(session.enableCamera).not.toHaveBeenCalled();
  });

  it("does not turn the camera on after leaving the call while hidden", async () => {
    setCall(7, true);
    startBackgroundCamera(owner.signal);
    setVisibility("hidden");
    await vi.waitFor(() => expect(session.disableCamera).toHaveBeenCalledTimes(1));
    setCall(null, false);
    setVisibility("visible");
    await settle();
    expect(session.enableCamera).not.toHaveBeenCalled();
  });

  it("does not turn the camera on in another channel joined while hidden", async () => {
    setCall(7, true);
    startBackgroundCamera(owner.signal);
    setVisibility("hidden");
    await vi.waitFor(() => expect(session.disableCamera).toHaveBeenCalledTimes(1));
    setCall(9, false, 2000);
    setVisibility("visible");
    await settle();
    expect(session.enableCamera).not.toHaveBeenCalled();
  });

  it("does not start the camera twice or leave it on through quick flips", async () => {
    setCall(7, true);
    startBackgroundCamera(owner.signal);
    setVisibility("hidden");
    setVisibility("visible");
    setVisibility("hidden");
    setVisibility("visible");
    await vi.waitFor(() => expect(voiceStore.getState().localCamera).toBe(true));
    await settle();
    expect(session.disableCamera.mock.calls.length).toBeLessThanOrEqual(2);
    expect(session.enableCamera.mock.calls.length).toBe(session.disableCamera.mock.calls.length);
    expect(voiceStore.getState().localCamera).toBe(true);
    const order = [
      ...session.disableCamera.mock.invocationCallOrder.map((n) => [n, "off"] as const),
      ...session.enableCamera.mock.invocationCallOrder.map((n) => [n, "on"] as const),
    ]
      .toSorted((a, b) => a[0] - b[0])
      .map((e) => e[1]);
    order.forEach((e, i) => expect(e).toBe(i % 2 === 0 ? "off" : "on"));
  });

  it("keeps the camera off if the app is hidden again before it resumes", async () => {
    setCall(7, true);
    startBackgroundCamera(owner.signal);
    setVisibility("hidden");
    setVisibility("visible");
    setVisibility("hidden");
    await vi.waitFor(() => expect(voiceStore.getState().localCamera).toBe(false));
    await settle();
    expect(session.enableCamera).not.toHaveBeenCalled();
    setVisibility("visible");
    await vi.waitFor(() => expect(voiceStore.getState().localCamera).toBe(true));
  });

  it("stops listening when its owner aborts", async () => {
    setCall(7, true);
    startBackgroundCamera(owner.signal);
    owner.abort();
    setVisibility("hidden");
    await settle();
    expect(session.disableCamera).not.toHaveBeenCalled();
  });
});
