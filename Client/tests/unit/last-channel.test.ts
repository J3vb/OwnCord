import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadLastChannel,
  rememberLastChannel,
  setLastChannelHost,
  viewChannel,
} from "@lib/last-channel";
import type { WsClient } from "@lib/ws";
import { focusPayload } from "@lib/last-channel";
import { applyReadyCapabilities, resetServerCapabilities } from "@lib/serverCapabilities";
import { channelsStore, resetChannelsStore, setChannels } from "@stores/channels.store";

describe("last-channel", () => {
  beforeEach(() => {
    localStorage.clear();
    setLastChannelHost(null);
  });

  it("round-trips the last channel for a server", () => {
    setLastChannelHost("chat.example:8443");
    rememberLastChannel(42);

    expect(loadLastChannel()).toBe(42);
  });

  it("keeps each server's last channel separate", () => {
    setLastChannelHost("a.example:8443");
    rememberLastChannel(1);
    setLastChannelHost("b.example:8443");
    rememberLastChannel(2);

    setLastChannelHost("a.example:8443");
    expect(loadLastChannel()).toBe(1);
    setLastChannelHost("b.example:8443");
    expect(loadLastChannel()).toBe(2);
  });

  it("returns null when nothing was stored for this server", () => {
    setLastChannelHost("fresh.example:8443");
    expect(loadLastChannel()).toBeNull();
  });

  it("ignores a corrupted stored value", () => {
    setLastChannelHost("chat.example:8443");
    localStorage.setItem("owncord:settings:lastChannel:chat.example:8443", JSON.stringify("nope"));
    expect(loadLastChannel()).toBeNull();
  });

  it("remembers a text channel it views but not a voice channel or a DM", () => {
    setLastChannelHost("chat.example:8443");
    const ws = { send: vi.fn() } as unknown as WsClient;

    viewChannel(5, "text", ws);
    viewChannel(6, "voice", ws);
    viewChannel(7, "dm", ws);

    expect(loadLastChannel()).toBe(5);
    // All three are still focused on the server.
    expect(ws.send).toHaveBeenCalledTimes(3);
  });

  it("a voice channel is not remembered", () => {
    setLastChannelHost("chat.example:8443");
    viewChannel(6, "voice", { send: vi.fn() } as unknown as WsClient);

    expect(loadLastChannel()).toBeNull();
  });
});

describe("last-channel storage and focus details", () => {
  beforeEach(() => {
    localStorage.clear();
    setLastChannelHost(null);
    resetServerCapabilities();
    resetChannelsStore();
  });

  it("keeps the unscoped key until a host is set, and scopes by host after", () => {
    rememberLastChannel(9);
    expect(localStorage.getItem("owncord:settings:lastChannel")).toBe("9");
    setLastChannelHost("a.example");
    expect(loadLastChannel()).toBeNull();
    rememberLastChannel(10);
    expect(localStorage.getItem("owncord:settings:lastChannel:a.example")).toBe("10");
    setLastChannelHost(null);
    expect(loadLastChannel()).toBe(9);
  });

  it.each([0, -3, 2.5])("treats a stored %s as nothing stored", (stored) => {
    localStorage.setItem("owncord:settings:lastChannel", JSON.stringify(stored));
    expect(loadLastChannel()).toBeNull();
  });

  it("accepts the smallest valid id", () => {
    rememberLastChannel(1);
    expect(loadLastChannel()).toBe(1);
  });

  it("focuses with the plain payload, or without marking read when the server keeps a read pointer", () => {
    expect(focusPayload(4)).toEqual({ channel_id: 4 });
    applyReadyCapabilities({ read_pointer: true });
    expect(focusPayload(4)).toEqual({ channel_id: 4, read: false });
    applyReadyCapabilities({});
    expect(focusPayload(4)).toEqual({ channel_id: 4 });
  });

  it("sends the focus frame and clears the channel's badge when it is viewed", () => {
    setChannels([
      { id: 4, name: "general", type: "text", category: null, position: 0, unread_count: 3 },
    ]);
    const ws = { send: vi.fn() } as unknown as WsClient;
    viewChannel(4, undefined, ws);
    expect(ws.send).toHaveBeenCalledWith({ type: "channel_focus", payload: { channel_id: 4 } });
    expect(channelsStore.getState().channels.get(4)?.unreadCount).toBe(0);
    expect(loadLastChannel()).toBe(4);
  });
});
