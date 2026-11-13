// REST calls for push to this device (GET /push/vapid, POST and DELETE
// /push/subscriptions). The server answers 503 PUSH_DISABLED to each while
// its owner has push off.

import type { ApiTransport } from "./apiShared";

/** A sign-out waits at most this long for the DELETE before it revokes the session. */
const PUSH_REVOKE_TIMEOUT_MS = 3_000;

/** The server's VAPID public key (base64url) and its id. */
export interface PushVapidResponse {
  readonly public_key: string;
  readonly key_id: string;
}

export interface PushSubscribeResponse {
  readonly id: number;
}

/** What a push service needs to reach this device, and a label for it. */
export interface PushSubscribeBody {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
  readonly device_name: string;
}

/** The push calls of the REST client. */
export function createPushApi(t: ApiTransport) {
  return {
    getPushVapid(signal?: AbortSignal): Promise<PushVapidResponse> {
      return t.request("PushVapidResponse", "GET", "/push/vapid", undefined, signal);
    },

    /** Adds or refreshes this device's subscription; the same endpoint again
     *  updates the row, so it is sent at every sign-in. */
    subscribePush(body: PushSubscribeBody, signal?: AbortSignal): Promise<PushSubscribeResponse> {
      return t.request("PushSubscribeResponse", "POST", "/push/subscriptions", body, signal);
    },

    /** Removes a subscription at sign-out, with the session's own token: it
     *  runs outside the session's scope, before that token is revoked. */
    revokePushSubscription(id: number, token: string): Promise<void> {
      return t.request("NoBody", "DELETE", `/push/subscriptions/${id}`, undefined, undefined, {
        detached: true,
        skipUnauthorized: true,
        token,
        timeoutMs: PUSH_REVOKE_TIMEOUT_MS,
      });
    },
  };
}
