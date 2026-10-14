import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { clearUnread } = vi.hoisted(() => ({ clearUnread: vi.fn() }));
vi.mock("@stores/channels.store", () => ({ clearUnread }));
vi.mock("@lib/preferences", () => ({ loadPref: (_k: string, f: unknown) => f, savePref: vi.fn() }));

import { resetChannelFocus, viewChannel } from "@lib/last-channel";
import type { WsClient } from "@lib/ws";

function makeWs(): { ws: WsClient; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  return { ws: { send } as unknown as WsClient, send };
}

function focusedIds(send: ReturnType<typeof vi.fn>): number[] {
  return send.mock.calls.map(
    (c) => (c[0] as { payload: { channel_id: number } }).payload.channel_id,
  );
}

describe("viewChannel focus throttle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetChannelFocus();
    clearUnread.mockClear();
  });
  afterEach(() => {
    resetChannelFocus();
    vi.useRealTimers();
  });

  it("sends a single call immediately", () => {
    const { ws, send } = makeWs();
    viewChannel(1, "text", ws);
    expect(focusedIds(send)).toEqual([1]);
    vi.advanceTimersByTime(1000);
    expect(focusedIds(send)).toEqual([1]);
  });

  it("sends the first of a burst at once and only the last after the quiet window", () => {
    const { ws, send } = makeWs();
    for (let i = 1; i <= 10; i++) {
      viewChannel(i, "text", ws);
      if (i < 10) vi.advanceTimersByTime(10);
    }
    expect(focusedIds(send)).toEqual([1]);
    vi.advanceTimersByTime(149);
    expect(focusedIds(send)).toEqual([1]);
    vi.advanceTimersByTime(1);
    expect(focusedIds(send)).toEqual([1, 10]);
    expect(clearUnread).toHaveBeenCalledTimes(10);
  });

  it("sends two calls 200 ms apart both immediately", () => {
    const { ws, send } = makeWs();
    viewChannel(1, "text", ws);
    vi.advanceTimersByTime(200);
    viewChannel(2, "text", ws);
    expect(focusedIds(send)).toEqual([1, 2]);
  });

  it("skips the trailing send when the burst ends on the channel already sent", () => {
    const { ws, send } = makeWs();
    viewChannel(1, "text", ws);
    viewChannel(2, "text", ws);
    viewChannel(1, "text", ws);
    vi.advanceTimersByTime(500);
    expect(focusedIds(send)).toEqual([1]);
  });

  it("sends the same channel again after a new connection resets the throttle", () => {
    const { ws, send } = makeWs();
    viewChannel(1, "text", ws);
    resetChannelFocus();
    viewChannel(1, "text", ws);
    vi.advanceTimersByTime(150);
    expect(focusedIds(send)).toEqual([1, 1]);
  });
});
