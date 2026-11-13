/**
 * Push to a closed app. The Android app registers through UnifiedPush: the
 * user's own push app (a "distributor", such as ntfy) holds the connection, so
 * no Google service is involved. Each signed-in account on a server is one
 * registration (`instance`); its endpoint and keys go to that server, which
 * pushes to them while the app is closed. Hosts without it report
 * `supported: false` and do nothing.
 */
export interface PushDistributor {
  /** The push app's package name. */
  readonly id: string;
  /** Its name as the phone shows it. */
  readonly name: string;
}

export interface PushStatus {
  readonly distributors: readonly PushDistributor[];
  /** The push app in use, or null until one is chosen. */
  readonly current: string | null;
}

/** Where a server sends this device's pushes, with the Web Push keys. */
export interface PushKeys {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

export interface PushRegisterRequest {
  readonly instance: string;
  /** The server's VAPID public key, base64url. */
  readonly vapid: string;
  /** Shown by the push app next to the registration. */
  readonly serverName: string;
  /** The "new messages" notification's text, in the app's language. */
  readonly title: string;
  readonly body: string;
}

/** Why a registration did not happen: no push app installed, several and
 *  none chosen, or the push app did not answer or refused. */
export type PushRegisterFailure = "no-distributor" | "choose" | "failed";

export type PushRegisterResult =
  | { readonly ok: true; readonly keys: PushKeys }
  | { readonly ok: false; readonly reason: PushRegisterFailure };

/** What the host reports while followed: the app came back into view (a push
 *  app may have been installed or chosen meanwhile), or a registration moved
 *  or ended by the push app's own doing. */
export type PushHostEvent =
  | { readonly kind: "resume" }
  | { readonly kind: "endpoint" | "unregistered"; readonly instance: string };

export interface PushRegistration {
  readonly supported: boolean;
  /** Null when the host cannot say. */
  status(): Promise<PushStatus | null>;
  /** Use this push app from now on; false when it is not installed. */
  choose(distributor: string): Promise<boolean>;
  register(request: PushRegisterRequest): Promise<PushRegisterResult>;
  /** Never rejects: a failure only leaves the push app's side behind. */
  unregister(instance: string): Promise<void>;
  /** Until `signal` aborts, report host events. One follower at a time. */
  follow(signal: AbortSignal, onEvent: (event: PushHostEvent) => void): void;
}
