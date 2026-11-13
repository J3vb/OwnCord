/**
 * Registers this phone for push with the connected server, after each
 * sign-in's `ready`: the server's VAPID key, then the push app's endpoint and
 * keys for this account, then POST /push/subscriptions (the server updates the
 * row when the endpoint is the same, which keeps it from going stale).
 *
 * Each attempt belongs to the API session it started in: a sign-out, server
 * switch or newer attempt supersedes it, and a superseded attempt writes
 * nothing. A server with push off (503 PUSH_DISABLED) is not asked again until
 * the next sign-in. Coming back into view tries again when the last attempt
 * found no push app or failed, so installing ntfy needs no second tap.
 */

import { ApiClientError, type ApiClient } from "@lib/api";
import { createLogger } from "@lib/logger";
import { RestErrorCode } from "@lib/protocolTypes";
import type { SessionScope } from "@lib/net/sessionScope";
import { registerSessionReset } from "@lib/net/sessionRegistry";
import { loadPref, onPrefChange } from "@lib/prefs/preferences";
import { authStore } from "@stores/auth.store";
import { connectText } from "../../i18n/connect";
import { desktop } from "../../platform/desktop";
import type { PushHostEvent, PushRegisterFailure } from "../../platform/contracts/pushRegistration";
import { deviceLabel, pushInstance } from "./pushInstance";
import { INITIAL_PUSH_STATE, pushStore, setPushSetting, type PushSetting } from "./store";

const log = createLogger("push");

/** Settings → Notifications' message switch: off means no push either. */
const NOTIFICATIONS_PREF = "desktopNotifications";

export type PushApi = Pick<ApiClient, "getPushVapid" | "subscribePush" | "getSession">;

interface Session {
  readonly api: PushApi;
  readonly scope: SessionScope;
  readonly instance: string;
  readonly serverName: string;
}

/** The session push is set up for; null after sign-out. */
let session: Session | null = null;
/** Bumped by every attempt: only the newest may write. */
let attempt = 0;

// App-lifetime reset hook, registered at module load. Every sign-out ("user":
// the button, sign out everywhere, an ended or refused session, a ban) also
// drops the push app's registration, so nothing more shows for that account;
// the server deletes its subscription with the session. A quick switch, an
// epoch refusal or an unreadable reply keep the session, and so the push.
void registerSessionReset(
  "push:session",
  (reason) => {
    if (reason === "user" && session !== null) {
      void desktop.pushRegistration.unregister(session.instance);
    }
    session = null;
    attempt += 1;
    pushStore.setState(() => INITIAL_PUSH_STATE);
  },
  { phase: "session" },
);

const FAILURE_SETTING: Readonly<Record<PushRegisterFailure, PushSetting>> = {
  "no-distributor": "install",
  choose: "choose",
  failed: "failed",
};

/** Settings that a later look should retry; "on" and "server-off" hold for the session. */
const RETRY_ON_RESUME: ReadonlySet<PushSetting> = new Set(["install", "choose", "failed"]);

/** The account push is set up for, or null; for the session-reset check. */
export function pushSessionInstance(): string | null {
  return session?.instance ?? null;
}

/** `ready` arrived. Once per session: a reconnect's `ready` changes nothing. */
export function onReady(api: PushApi): void {
  if (!desktop.pushRegistration.supported) return;
  const scope = api.getSession();
  if (session?.scope === scope) return;
  const user = authStore.getState().user;
  if (user === null) return;
  session = {
    api,
    scope,
    instance: pushInstance(scope.identity.host, user.id),
    serverName: authStore.getState().serverName ?? scope.identity.host,
  };
  const current = session;
  desktop.pushRegistration.follow(scope.signal, onHostEvent);
  onPrefChange([NOTIFICATIONS_PREF], () => void registerPush(current), scope.signal);
  void registerPush(current);
}

/** The user picked a push app in Settings. */
export async function chooseDistributor(id: string): Promise<void> {
  const current = session;
  if (current === null) return;
  const chosen = await desktop.pushRegistration.choose(id);
  if (session !== current) return;
  if (chosen) await registerPush(current);
  else setPushSetting("failed");
}

function onHostEvent(event: PushHostEvent): void {
  const current = session;
  if (current === null) return;
  if (event.kind === "resume") {
    if (RETRY_ON_RESUME.has(pushStore.getState().setting)) void registerPush(current);
    return;
  }
  // The push app moved or dropped this account's registration: register again.
  if (event.instance === current.instance) void registerPush(current);
}

async function registerPush(current: Session): Promise<void> {
  const mine = ++attempt;
  const owns = (): boolean => mine === attempt && session === current && current.scope.isCurrent();
  if (!owns()) return;
  if (!loadPref<boolean>(NOTIFICATIONS_PREF, true)) {
    void desktop.pushRegistration.unregister(current.instance);
    setPushSetting("muted");
    return;
  }
  setPushSetting("checking");
  try {
    const vapid = await current.api.getPushVapid(current.scope.signal);
    if (!owns()) return;
    const result = await desktop.pushRegistration.register({
      instance: current.instance,
      vapid: vapid.public_key,
      serverName: current.serverName,
      title: connectText("notifications.push.title", { server: current.serverName }),
      body: connectText("notifications.push.body"),
    });
    if (!owns()) return;
    if (!result.ok) {
      await showFailure(result.reason, owns);
      return;
    }
    const { endpoint, p256dh, auth } = result.keys;
    await current.api.subscribePush(
      { endpoint, keys: { p256dh, auth }, device_name: deviceLabel(navigator.userAgent) },
      current.scope.signal,
    );
    if (!owns()) return;
    setPushSetting("on");
  } catch (err) {
    if (!owns()) return;
    if (err instanceof ApiClientError && err.code === RestErrorCode.PUSH_DISABLED) {
      setPushSetting("server-off");
      return;
    }
    log.warn("Push registration failed", { error: String(err) });
    setPushSetting("failed");
  }
}

async function showFailure(reason: PushRegisterFailure, owns: () => boolean): Promise<void> {
  if (reason !== "choose") {
    setPushSetting(FAILURE_SETTING[reason]);
    return;
  }
  const status = await desktop.pushRegistration.status();
  if (!owns()) return;
  setPushSetting("choose", status?.distributors ?? []);
}
