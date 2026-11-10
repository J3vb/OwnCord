// What E2EEManager's announce, setup and leave modules (e2eeAnnounce.ts,
// e2eeSetup.ts, e2eeLeave.ts) reach it through. The owner modules are passed as
// objects, the scalars the manager itself owns (session generation, key-holder
// role, channel, the join's room-key waiter) as accessors that are read on every
// use and never captured, so each value keeps its single owner.
import type { WsClient } from "../../lib/ws";
import type { E2EEIdentity } from "./e2eeIdentity";
import type { E2EEEpoch } from "./e2eeEpoch";
import type { E2EEPeerState } from "./e2eePeerState";
import type { E2EEWorker } from "./e2eeWorker";
import type { E2EEOffer } from "./e2eeOffer";

export interface E2EEHost {
  readonly identity: E2EEIdentity;
  readonly epoch: E2EEEpoch;
  readonly peers: E2EEPeerState;
  readonly worker: E2EEWorker;
  readonly offers: E2EEOffer;
  getWs(): WsClient | null;
  getServerHost(): string | null;
  getCurrentChannelId(): number | null;
  /** Bumped by every clearState(). */
  getSessionGeneration(): number;
  /** The channel this exchange runs in, set at setupKeyExchange entry. */
  getChannelId(): number | null;
  setChannelId(channelId: number): void;
  isKeyHolder(): boolean;
  setKeyHolder(value: boolean): void;
  /** The resolver a non-holder's join waits on for the holder's offer. */
  getRoomKeyResolver(): (() => void) | null;
  setRoomKeyWaiter(resolver: (() => void) | null, rejector: ((err: Error) => void) | null): void;
  peerHasKeySlots(userId: number): boolean;
  /** The announce body, past the queued-join hold (see E2EEAnnounce.apply). */
  applyAnnounce(
    userId: number,
    publicKeyBase64: string,
    signatureBase64?: string,
    identityKeyBase64?: string,
  ): Promise<void>;
}
