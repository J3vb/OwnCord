// The host side of `pushRegistration`, loaded in the Android app only
// (`src-tauri/src/push.rs`, `PushPlugin.kt`). The plugin answers a
// registration once the push app has, and sends `resume`, `endpoint` and
// `unregistered` events.
import { addPluginListener, type PluginListener } from "@tauri-apps/api/core";
import { createLogger } from "@lib/logger";
import { tryInvoke } from "./nativeInvoke";
import { callNotificationText } from "../../i18n/callNotification";
import type {
  PushHostEvent,
  PushKeys,
  PushRegisterFailure,
  PushRegisterRequest,
  PushRegisterResult,
  PushStatus,
} from "../contracts/pushRegistration";
import { isRecord } from "@lib/isRecord";

const log = createLogger("push");

const PLUGIN = "owncord-push";

/** Bumped by each `follow`: the newest follower gets the events. */
let generation = 0;

function readStatus(value: unknown): PushStatus | null {
  if (!isRecord(value) || !Array.isArray(value.distributors)) return null;
  const distributors = value.distributors.flatMap((d: unknown) =>
    isRecord(d) && typeof d.id === "string" && typeof d.name === "string"
      ? [{ id: d.id, name: d.name }]
      : [],
  );
  const current = typeof value.current === "string" ? value.current : null;
  return { distributors, current };
}

function readKeys(value: unknown): PushKeys | null {
  if (!isRecord(value)) return null;
  const { endpoint, p256dh, auth } = value;
  return typeof endpoint === "string" && typeof p256dh === "string" && typeof auth === "string"
    ? { endpoint, p256dh, auth }
    : null;
}

/** The plugin's refusal codes (`PushErrors` in PushPlugin.kt). */
export function failureOf(message: string): PushRegisterFailure {
  if (message.includes("NO_DISTRIBUTOR")) return "no-distributor";
  if (message.includes("CHOOSE_DISTRIBUTOR")) return "choose";
  return "failed";
}

export async function status(): Promise<PushStatus | null> {
  const result = await tryInvoke<unknown>("push_status");
  if (!result.ok) {
    log.warn("Push status unavailable", result.error.message);
    return null;
  }
  return readStatus(result.value);
}

export async function choose(distributor: string): Promise<boolean> {
  const result = await tryInvoke<void>("push_choose", { distributor });
  return result.ok;
}

/** What a call's ring from push shows while no page runs (`ShowRingArgs`):
 *  no caller, since a push names nobody, but the server it came from. */
function ringText(request: PushRegisterRequest): Record<string, string | boolean> {
  const quiet = request.ringQuiet;
  return {
    title: callNotificationText("pushRingTitle", { server: request.serverName }),
    text: callNotificationText("pushRingText"),
    acceptLabel: callNotificationText("accept"),
    declineLabel: callNotificationText("decline"),
    channelName: callNotificationText(quiet ? "quietRingChannel" : "ringChannel"),
    channelDescription: callNotificationText(quiet ? "quietRingChannelDesc" : "ringChannelDesc"),
    quiet,
  };
}

export async function register(request: PushRegisterRequest): Promise<PushRegisterResult> {
  const { instance, vapid, serverName, title, body } = request;
  const result = await tryInvoke<unknown>("push_register", {
    instance,
    vapid,
    serverName,
    title,
    body,
    ring: ringText(request),
  });
  if (!result.ok) return { ok: false, reason: failureOf(result.error.message) };
  const keys = readKeys(result.value);
  return keys === null ? { ok: false, reason: "failed" } : { ok: true, keys };
}

export async function unregister(instance: string): Promise<void> {
  const result = await tryInvoke<void>("push_unregister", { instance });
  if (!result.ok) log.warn("Push unregister failed", result.error.message);
}

function readEvent(kind: "endpoint" | "unregistered", payload: unknown): PushHostEvent | null {
  return isRecord(payload) && typeof payload.instance === "string"
    ? { kind, instance: payload.instance }
    : null;
}

function stop(listener: PluginListener): void {
  void listener.unregister().catch((err: unknown) => log.debug("Unlisten failed", err));
}

export function follow(signal: AbortSignal, onEvent: (event: PushHostEvent) => void): void {
  if (signal.aborted) return;
  const mine = ++generation;
  const live = (): boolean => !signal.aborted && mine === generation;
  const listen = (event: string, read: (payload: unknown) => PushHostEvent | null) =>
    addPluginListener<unknown>(PLUGIN, event, (payload) => {
      if (!live()) return;
      const parsed = read(payload);
      if (parsed !== null) onEvent(parsed);
    });
  void Promise.allSettled([
    listen("resume", () => ({ kind: "resume" })),
    listen("endpoint", (p) => readEvent("endpoint", p)),
    listen("unregistered", (p) => readEvent("unregistered", p)),
  ]).then((settled) => {
    const listeners = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
    if (listeners.length < settled.length) log.warn("Some push events unavailable");
    if (!live()) {
      listeners.forEach(stop);
      return;
    }
    signal.addEventListener("abort", () => listeners.forEach(stop), { once: true });
  });
}
