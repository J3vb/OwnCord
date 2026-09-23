// Safety handler bodies (B9-15), called only from lib/dispatcher.ts.
import { showToast } from "../../lib/toast";
import { formatUntil, safetyText } from "../../i18n/safety";
import type { DispatchApi, Payload } from "../connection/dispatchContext";
import {
  addNotice,
  refreshOwnModeration,
  safetyStore,
  setActiveTimeout,
  setReadyNotices,
} from "./store";

type SafetyApi = DispatchApi | undefined;

function refresh(api: SafetyApi): void {
  const getOwnModeration = api?.getOwnModeration?.bind(api);
  if (getOwnModeration !== undefined) refreshOwnModeration({ getOwnModeration });
}

/** Every ready (first connect and each reconnect): notices, then the authoritative history. */
export function applyReadySafety(api: SafetyApi, payload: Payload<"ready">): void {
  setReadyNotices(payload.notices ?? []);
  refresh(api);
}

/**
 * auth_ok on a resumed connection: the server replays sequenced frames and
 * sends no ready, and mod_action is never replayed, so re-read the history.
 */
export function refreshSafetyOnResume(api: SafetyApi, payload: Payload<"auth_ok">): void {
  if (payload.replay_source === "buffer" || payload.replay_source === "db") refresh(api);
}

/** A live warning, timeout or lift. Announced once: a duplicate frame is ignored. */
export function handleModAction(api: SafetyApi, payload: Payload<"mod_action">): void {
  if (payload.kind === "warning") {
    if (addNotice(payload.id, payload.reason, new Date().toISOString())) {
      showToast(safetyText("toast.warning", { reason: payload.reason }), "warning");
    }
  } else if (payload.expires_at === null) {
    if (safetyStore.getState().timeout !== null) showToast(safetyText("toast.lifted"), "info");
    setActiveTimeout(null);
  } else {
    setActiveTimeout(payload.expires_at);
    showToast(safetyText("toast.timeout", { time: formatUntil(payload.expires_at) }), "warning");
  }
  refresh(api);
}

/** The server refused an action with TIMED_OUT: learn or revalidate the expiry. */
export function handleTimedOutRefusal(api: SafetyApi, payload: Payload<"error">): void {
  if (payload.code === "TIMED_OUT") refresh(api);
}
