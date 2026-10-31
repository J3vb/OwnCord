/**
 * Tests for src/app/serverHealth.ts (WP 7.4f): the connect page's health
 * checks and the per-host `server-info` snapshot, moved out of main.ts.
 * configureServerHealth() gets a fake API client whose probes stay pending
 * until the test settles them, and checkHealth() a recording connect page.
 *
 * The two edge cases the move must keep: a probe that resolves after its page
 * left (owner.isCurrent() false) writes nothing, and a host with a probe in
 * flight is reported as such so a typed host is not probed twice.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createDeferred as deferred, type Deferred } from "../helpers/deferred";
import { SessionScope } from "@lib/net/sessionScope";
import type { ApiClient } from "@lib/api";
import type { ServerInfoResponse } from "@lib/types";
import { PROTOCOL_EPOCH } from "@lib/protocolTypes";

const hoisted = vi.hoisted(() => ({ warn: vi.fn(), debug: vi.fn() }));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: hoisted.debug,
    info: vi.fn(),
    warn: hoisted.warn,
    error: vi.fn(),
  }),
}));

import {
  checkHealth,
  configureServerHealth,
  probeServerInfo,
  runHealthChecks,
  serverInfoFor,
  serverInfoProbing,
} from "../../src/app/serverHealth";

const health = { version: "1.2.3", online_users: 4 };
function info(epoch: number): ServerInfoResponse {
  return {
    name: "S",
    protocol_epoch: epoch,
    browser_client_enabled: false,
  };
}

let healthCalls: Array<{ host: string; d: Deferred<typeof health> }>;
let infoCalls: Array<{ host: string; d: Deferred<ServerInfoResponse> }>;
type Readout = Parameters<typeof checkHealth>[0];
let page: {
  updateHealthStatus: Mock<Readout["updateHealthStatus"]>;
  updateCompatibility: Mock<Readout["updateCompatibility"]>;
};
let owner: SessionScope;
let n = 0;
let host: string;

beforeEach(() => {
  healthCalls = [];
  infoCalls = [];
  hoisted.warn.mockClear();
  hoisted.debug.mockClear();
  configureServerHealth({
    getHealth: (h: string) => {
      const d = deferred<typeof health>();
      healthCalls.push({ host: h, d });
      return d.promise;
    },
    getServerInfo: (h: string) => {
      const d = deferred<ServerInfoResponse>();
      infoCalls.push({ host: h, d });
      return d.promise;
    },
  } as unknown as ApiClient);
  page = {
    updateHealthStatus: vi.fn<Readout["updateHealthStatus"]>(),
    updateCompatibility: vi.fn<Readout["updateCompatibility"]>(),
  };
  owner = new SessionScope({ host: "", generation: 0 });
  // Each test gets its own host: the snapshot map is module state.
  host = `h${++n}.example:8443`;
});

const statuses = () => page.updateHealthStatus.mock.calls.map((c) => c[1].status);

describe("checkHealth", () => {
  it("marks the row checking, online, then records the compatibility", async () => {
    const result = checkHealth(page, host, owner);
    expect(statuses()).toEqual(["checking"]);
    healthCalls[0]!.d.resolve(health);
    await vi.waitFor(() => expect(infoCalls).toHaveLength(1));
    expect(page.updateHealthStatus).toHaveBeenLastCalledWith(
      host,
      expect.objectContaining({ status: "online", version: "1.2.3", onlineUsers: 4 }),
    );
    infoCalls[0]!.d.resolve(info(PROTOCOL_EPOCH));
    expect(await result).toBe(true);
    expect(page.updateCompatibility).toHaveBeenCalledWith(host, "compatible", PROTOCOL_EPOCH);
    expect(serverInfoFor(host)?.protocol_epoch).toBe(PROTOCOL_EPOCH);
  });

  it("marks the row offline when health fails, still probing server-info", async () => {
    const result = checkHealth(page, host, owner);
    healthCalls[0]!.d.reject(new Error("refused"));
    await vi.waitFor(() => expect(infoCalls).toHaveLength(1));
    expect(statuses()).toEqual(["checking", "offline"]);
    expect(hoisted.warn).toHaveBeenCalledWith("health check failed", {
      host,
      error: "Error: refused",
    });
    infoCalls[0]!.d.resolve(info(PROTOCOL_EPOCH));
    expect(await result).toBe(false);
  });

  it("writes nothing when the page left before the health answer arrived", async () => {
    const result = checkHealth(page, host, owner);
    owner.dispose();
    healthCalls[0]!.d.resolve(health);
    expect(await result).toBe(false);
    expect(statuses()).toEqual(["checking"]);
    expect(infoCalls).toHaveLength(0);
    expect(serverInfoFor(host)).toBeUndefined();
    expect(page.updateCompatibility).not.toHaveBeenCalled();
  });

  it("writes nothing when the page left before a failing health call settled", async () => {
    const result = checkHealth(page, host, owner);
    owner.dispose();
    healthCalls[0]!.d.reject(new Error("aborted"));
    expect(await result).toBe(false);
    expect(statuses()).toEqual(["checking"]);
    expect(hoisted.warn).not.toHaveBeenCalled();
    expect(infoCalls).toHaveLength(0);
    expect(page.updateCompatibility).not.toHaveBeenCalled();
  });

  it("does not even mark checking on a page that is already gone", async () => {
    owner.dispose();
    expect(await checkHealth(page, host, owner)).toBe(false);
    expect(page.updateHealthStatus).not.toHaveBeenCalled();
    expect(healthCalls).toHaveLength(0);
  });
});

describe("probeServerInfo", () => {
  it("stores the snapshot and reports an incompatible epoch", async () => {
    const result = probeServerInfo(page, host, owner);
    infoCalls[0]!.d.resolve(info(PROTOCOL_EPOCH + 1));
    expect(await result).toBe(true);
    expect(page.updateCompatibility).toHaveBeenCalledWith(
      host,
      expect.not.stringMatching(/^(compatible|unreachable)$/),
      PROTOCOL_EPOCH + 1,
    );
    expect(serverInfoFor(host)?.protocol_epoch).toBe(PROTOCOL_EPOCH + 1);
  });

  it("clears a stale snapshot and reports unreachable when the probe fails", async () => {
    const first = probeServerInfo(page, host, owner);
    infoCalls[0]!.d.resolve(info(PROTOCOL_EPOCH));
    await first;
    expect(serverInfoFor(host)).toBeDefined();

    const second = probeServerInfo(page, host, owner);
    infoCalls[1]!.d.reject(new Error("down"));
    expect(await second).toBe(false);
    expect(serverInfoFor(host)).toBeUndefined();
    expect(page.updateCompatibility).toHaveBeenLastCalledWith(host, "unreachable", null);
    expect(hoisted.debug).toHaveBeenCalledWith("server-info preflight failed", {
      host,
      error: "Error: down",
    });
  });

  it("writes no snapshot and no compatibility when the page left mid-probe", async () => {
    const result = probeServerInfo(page, host, owner);
    owner.dispose();
    infoCalls[0]!.d.resolve(info(PROTOCOL_EPOCH));
    expect(await result).toBe(false);
    expect(serverInfoFor(host)).toBeUndefined();
    expect(page.updateCompatibility).not.toHaveBeenCalled();
    expect(serverInfoProbing(host)).toBe(false);
  });

  it("leaves an existing snapshot alone when a probe fails after its page left", async () => {
    const live = new SessionScope({ host: "", generation: 0 });
    const first = probeServerInfo(page, host, live);
    infoCalls[0]!.d.resolve(info(PROTOCOL_EPOCH));
    await first;

    const result = probeServerInfo(page, host, owner);
    owner.dispose();
    infoCalls[1]!.d.reject(new Error("aborted"));
    expect(await result).toBe(false);
    expect(serverInfoFor(host)).toBeDefined();
    expect(page.updateCompatibility).toHaveBeenCalledTimes(1);
  });

  it("reports the host as in flight until the probe settles, on success and failure", async () => {
    expect(serverInfoProbing(host)).toBe(false);
    const ok = probeServerInfo(page, host, owner);
    expect(serverInfoProbing(host)).toBe(true);
    infoCalls[0]!.d.resolve(info(PROTOCOL_EPOCH));
    await ok;
    expect(serverInfoProbing(host)).toBe(false);

    const bad = probeServerInfo(page, host, owner);
    expect(serverInfoProbing(host)).toBe(true);
    infoCalls[1]!.d.reject(new Error("down"));
    await bad;
    expect(serverInfoProbing(host)).toBe(false);
  });
});

describe("runHealthChecks", () => {
  it("checks every profile's host", () => {
    const a = `a${host}`;
    const b = `b${host}`;
    runHealthChecks(page, [{ host: a }, { host: b }], owner);
    expect(healthCalls.map((c) => c.host)).toEqual([a, b]);
    expect(statuses()).toEqual(["checking", "checking"]);
  });
});
