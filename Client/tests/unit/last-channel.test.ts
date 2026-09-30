import { beforeEach, describe, expect, it } from "vitest";
import { loadLastChannel, rememberLastChannel, setLastChannelHost } from "@lib/last-channel";

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
});
