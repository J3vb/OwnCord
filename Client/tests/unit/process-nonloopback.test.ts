import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { pickNonLoopbackIPv4 } from "../e2e/support/process";

function ipv4(address: string, internal: boolean): NetworkInterfaceInfo {
  return {
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal,
    cidr: `${address}/24`,
  };
}

describe("pickNonLoopbackIPv4", () => {
  it("returns the first non-internal IPv4", () => {
    expect(
      pickNonLoopbackIPv4({
        lo: [ipv4("127.0.0.1", true)],
        eth0: [ipv4("192.168.1.50", false)],
      }),
    ).toBe("192.168.1.50");
  });

  it("returns null when only loopback exists", () => {
    expect(pickNonLoopbackIPv4({ lo: [ipv4("127.0.0.1", true)] })).toBeNull();
    expect(pickNonLoopbackIPv4({})).toBeNull();
    expect(pickNonLoopbackIPv4({ lo: undefined })).toBeNull();
  });

  it("skips an internal alias before an external one", () => {
    expect(
      pickNonLoopbackIPv4({
        lo: [ipv4("127.0.0.1", true)],
        "lo:1": [ipv4("127.0.0.2", true)],
        eth0: [ipv4("10.0.0.7", false)],
      }),
    ).toBe("10.0.0.7");
  });
});
