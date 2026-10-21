import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadLastChannel,
  rememberLastChannel,
  setLastChannelHost,
  viewChannel,
} from "@lib/last-channel";
import type { WsClient } from "@lib/ws";

describe("last-channel (UX-8)", () => {
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
