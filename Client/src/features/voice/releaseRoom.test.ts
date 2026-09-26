import { afterEach, describe, expect, it, vi } from "vitest";
import { Room, RoomEvent } from "livekit-client";
import { detachRoom, onRoom } from "./releaseRoom";

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
