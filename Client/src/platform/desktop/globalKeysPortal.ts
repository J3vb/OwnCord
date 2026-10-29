// The Wayland portal half of the global-shortcuts binding: the `global_keys_*`
// commands, narrowing the host's `GlobalKeysStatus` payload and turning a bind
// or configure rejection into a typed `GlobalKeysError`. Every invoke is in a
// try/catch: status reads as `none`, bind and configure reject with a code. A sibling of `globalShortcuts.ts` that it imports
// lazily, so this code stays out of the startup chunk.
import type {
  GlobalKeysError,
  GlobalKeysErrorCode,
  GlobalKeysStatus,
} from "../contracts/globalShortcuts";

const ERROR_CODES: readonly GlobalKeysErrorCode[] = [
  "unsupported",
  "bind_in_progress",
  "bind_cancelled",
  "bind_timeout",
  "bind_failed",
  "portal_lost",
];

function noKeys(): GlobalKeysStatus {
  return {
    backend: "none",
    portalVersion: 0,
    triggers: { ptt: null, mute: null, deafen: null },
    canConfigure: false,
    triggersUnnamed: false,
    sessionRefused: false,
  };
}

function trigger(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Narrow a host payload; anything malformed reads as no global keys. */
export function parseStatus(raw: unknown): GlobalKeysStatus {
  if (typeof raw !== "object" || raw === null) return noKeys();
  const r = raw as Record<string, unknown>;
  const backend = r.backend;
  if (backend !== "polling" && backend !== "portal" && backend !== "none") return noKeys();
  const t = typeof r.triggers === "object" && r.triggers !== null ? r.triggers : {};
  const triggers = t as Record<string, unknown>;
  return {
    backend,
    portalVersion: typeof r.portalVersion === "number" ? r.portalVersion : 0,
    triggers: {
      ptt: trigger(triggers.ptt),
      mute: trigger(triggers.mute),
      deafen: trigger(triggers.deafen),
    },
    canConfigure: r.canConfigure === true,
    triggersUnnamed: r.triggersUnnamed === true,
    sessionRefused: r.sessionRefused === true,
  };
}

class HostGlobalKeysError extends Error implements GlobalKeysError {
  readonly code: GlobalKeysErrorCode;
  constructor(code: GlobalKeysErrorCode) {
    super(code);
    this.name = "GlobalKeysError";
    this.code = code;
  }
}

/** The host rejects with a bare code string; anything else is `unknown`. */
function toError(err: unknown): GlobalKeysError {
  const code = ERROR_CODES.find((c) => c === err);
  return new HostGlobalKeysError(code ?? "unknown");
}

export async function portalStatus(): Promise<GlobalKeysStatus> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return parseStatus(await invoke<unknown>("global_keys_status"));
  } catch {
    // Not a Tauri host, or the command was refused: nothing delivers a key.
    return noKeys();
  }
}

export async function portalBind(keys: {
  pttVk: number;
  muteVk: number;
  deafenVk: number;
}): Promise<GlobalKeysStatus> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return parseStatus(
      await invoke<unknown>("global_keys_portal_bind", {
        pttVk: keys.pttVk,
        muteVk: keys.muteVk,
        deafenVk: keys.deafenVk,
      }),
    );
  } catch (err) {
    throw toError(err);
  }
}

export async function portalConfigure(): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("global_keys_portal_configure");
  } catch (err) {
    throw toError(err);
  }
}
