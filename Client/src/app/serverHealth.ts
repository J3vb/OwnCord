// The connect page's server health checks and the per-host `server-info`
// snapshot they fill. Moved out of main.ts verbatim; the only edits are that
// `api` arrives through configureServerHealth() and the two module-level
// collections are read through serverInfoFor() / serverInfoProbing(). Nothing
// here runs at import time.

import type { ApiClient } from "@lib/api";
import { createLogger } from "@lib/logger";
import { deriveCompatibility, type Compatibility } from "@lib/profiles";
import { PROTOCOL_EPOCH } from "@lib/protocolTypes";
import type { SessionScope } from "@lib/sessionScope";
import type { ServerInfoResponse } from "@lib/types";

const log = createLogger("main");

let api: ApiClient;

/** Hands the module the API client main.ts created; call once at boot. */
export function configureServerHealth(apiClient: ApiClient): void {
  api = apiClient;
}

/**
 * Last `server-info` snapshot per host, fed by `runHealthChecks`. The
 * advisory epoch badge and the incompatible notice read it, and the same
 * snapshot supplies `registration_mode` and the retention notice.
 */
const serverInfoByHost = new Map<string, ServerInfoResponse>();
/** Hosts with a `server-info` probe in flight, so a typed host is not probed twice. */
const serverInfoInFlight = new Set<string>();

/** The connect page's per-server health readouts. */
export interface HealthReadout {
  updateHealthStatus(
    host: string,
    status: {
      status: string;
      latencyMs: number | null;
      version: string | null;
      onlineUsers: number | null;
    },
  ): void;
  updateCompatibility(host: string, compatibility: Compatibility, serverEpoch: number | null): void;
}

/** Run health checks for a list of profiles and update the connect page. */
export function runHealthChecks(
  connectPage: HealthReadout,
  profiles: readonly { host: string }[],
  owner: SessionScope,
): void {
  for (const profile of profiles) void checkHealth(connectPage, profile.host, owner);
}

/**
 * Advisory epoch preflight, beside the health probe and sharing its
 * timeout/dispose shape. Resolves whether `server-info` answered; a failed
 * probe is `unreachable` — no badge, never an error banner (the WebSocket
 * refusal stays authoritative). A degraded server (health 503) still answers it.
 */
export async function probeServerInfo(
  connectPage: HealthReadout,
  host: string,
  owner: SessionScope,
): Promise<boolean> {
  let serverEpoch: number | null = null;
  let compatibility: Compatibility = "unreachable";
  serverInfoInFlight.add(host);
  try {
    const info = await api.getServerInfo(host, 3000, owner.signal);
    owner.assertCurrent();
    serverInfoByHost.set(host, info);
    serverEpoch = info.protocol_epoch;
    compatibility = deriveCompatibility(serverEpoch, PROTOCOL_EPOCH);
  } catch (infoErr) {
    if (!owner.isCurrent()) return false;
    serverInfoByHost.delete(host);
    log.debug("server-info preflight failed", {
      host,
      error: String(infoErr),
    });
  } finally {
    serverInfoInFlight.delete(host);
  }
  connectPage.updateCompatibility(host, compatibility, serverEpoch);
  return compatibility !== "unreachable";
}

/** Probe one server and update its row; resolves whether it answered. */
export async function checkHealth(
  connectPage: HealthReadout,
  host: string,
  owner: SessionScope,
): Promise<boolean> {
  try {
    owner.assertCurrent();
    connectPage.updateHealthStatus(host, {
      status: "checking",
      latencyMs: null,
      version: null,
      onlineUsers: null,
    });
    const start = performance.now();
    const health = await api.getHealth(host, 3000, owner.signal);
    owner.assertCurrent();
    const elapsed = Math.round(performance.now() - start);
    connectPage.updateHealthStatus(host, {
      status: elapsed > 1500 ? "slow" : "online",
      latencyMs: elapsed,
      version: health.version ?? null,
      onlineUsers: health.online_users ?? null,
    });
    await probeServerInfo(connectPage, host, owner);
    return true;
  } catch (err) {
    if (!owner.isCurrent()) return false;
    // Record why the check failed (TLS/cert-pin/network) — otherwise a
    // "can't connect" report has no logged cause to diagnose.
    log.warn("health check failed", { host, error: String(err) });
    connectPage.updateHealthStatus(host, {
      status: "offline",
      latencyMs: null,
      version: null,
      onlineUsers: null,
    });
    // A degraded server (503) fails the health call but may still answer
    // server-info; the probe clears the badge itself when it fails too.
    await probeServerInfo(connectPage, host, owner);
    return false;
  }
}

/** The last `server-info` snapshot for `host`, if a probe has answered. */
export function serverInfoFor(host: string): ServerInfoResponse | undefined {
  return serverInfoByHost.get(host);
}

/** Whether a `server-info` probe for `host` is in flight. */
export function serverInfoProbing(host: string): boolean {
  return serverInfoInFlight.has(host);
}
