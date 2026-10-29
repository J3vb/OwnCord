import { afterEach, describe, expect, it, vi } from "vitest";
import { Room, RoomEvent } from "livekit-client";
import { detachRoom, onRoom, releaseRoom } from "./releaseRoom";

describe("detachRoom", () => {
  afterEach(() => vi.useRealTimers());

  it("removes the app's listeners but leaves livekit's own disconnect cleanup", () => {
    vi.useFakeTimers();
    const room = new Room();
    const appDisconnected = vi.fn();
    onRoom(room, RoomEvent.Disconnected, appDisconnected);
    // The SFU confirms a subscription to a camera the app already unpublished
    // (a quick toggle): livekit waits 10 s for the publication and clears
    // that wait from its own once(Disconnected) listener.
    const before = vi.getTimerCount();
    (
      room as unknown as { handleLocalTrackSubscribed(sid: string): void }
    ).handleLocalTrackSubscribed("TR_unpublished");
    expect(vi.getTimerCount()).toBe(before + 1);

    detachRoom(room);
    room.emit(RoomEvent.Disconnected);

    expect(appDisconnected).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(before);
  });
});

describe("detachRoom bookkeeping", () => {
  it("forgets the listeners it removed, so a second detach removes nothing more", () => {
    const room = new Room();
    const off = vi.spyOn(room, "off");
    onRoom(room, RoomEvent.Disconnected, vi.fn());
    onRoom(room, RoomEvent.Reconnecting, vi.fn());

    detachRoom(room);
    expect(off).toHaveBeenCalledTimes(2);
    detachRoom(room);
    expect(off).toHaveBeenCalledTimes(2);
  });
});

describe("releaseRoom", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("detaches the app, drops the devicechange listener and disconnects", async () => {
    const removeEventListener = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { removeEventListener } });
    const room = new Room();
    const handleDeviceChange = vi.fn();
    (room as unknown as { handleDeviceChange: unknown }).handleDeviceChange = handleDeviceChange;
    const appDisconnected = vi.fn();
    onRoom(room, RoomEvent.Disconnected, appDisconnected);
    const disconnect = vi.spyOn(room, "disconnect").mockResolvedValue(undefined);

    await releaseRoom(room);

    expect(removeEventListener).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledWith("devicechange", handleDeviceChange);
    expect(disconnect).toHaveBeenCalledTimes(1);
    room.emit(RoomEvent.Disconnected);
    expect(appDisconnected).not.toHaveBeenCalled();
  });

  it("still disconnects when the browser has no media devices", async () => {
    vi.stubGlobal("navigator", {});
    const room = new Room();
    const disconnect = vi.spyOn(room, "disconnect").mockResolvedValue(undefined);
    await releaseRoom(room);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
