// Voice E2EE worker-side key provider — extracted from livekitE2EE.ts.
// Owns the current Room's SlotKeyProvider, the single write queue that
// installs room keys into it in order, skipping any key superseded before its
// turn, and the delayed switch to a staged key.
// The room key and the session generation stay owned by E2EEManager; this
// module reads them through E2EEWorkerHost.
import { roomKeyToBase64 } from "../../lib/net/e2eeCrypto";
import { LEGACY_PLACEMENT, type KeyPlacement, type KeySlot } from "../../lib/net/keyPlacement";
import { createLogger } from "../../lib/logger";
import { setOwnedTimeout } from "../../lib/dom";
import { Disposable } from "../../lib/disposable";
import { desktop } from "../../platform/desktop";
import { isLinuxDesktop } from "./native/platform";
import { SlotKeyProvider } from "./slotKeyProvider";

const log = createLogger("e2eeWorker");

/** What the key provider's write queue needs from E2EEManager. */
export interface E2EEWorkerHost {
  getSessionGeneration(): number;
  getRoomKey(): Uint8Array | null;
  /** A room key landed in the key provider and is still the session's. */
  onKeyInstalled?(): void;
  /** Where the session's room key went; absent means slot 0. */
  getRoomKeyPlacement?(): KeyPlacement;
}

/** How long a staged room key is only received with before this client sends
 *  with it: room for the key to reach every peer before frames use it. */
export const KEY_SWITCH_DELAY_MS = 2_000;

export class E2EEWorker {
  /** The current Room's key provider. Each Room gets its own: livekit's
   *  E2EEManager subscribes to its provider and never unsubscribes, so a
   *  provider that outlived its Room would keep that Room alive. The room key
   *  is generated and exchanged client-side via ECDH; the server never sees it. */
  private _keyProvider = new SlotKeyProvider();
  /** Provider imports are asynchronous. Keep one write queue across session
   *  resets so an abandoned import cannot overwrite a newer session's key. */
  private _keyApplyChain: Promise<void> = Promise.resolve();
  /** The slot this client sends with. */
  private _sendSlot: KeySlot = 0;
  /** Owns the pending switch to a staged key; aborted by a newer key and by
   *  the session reset. */
  private _switchOwner = new Disposable();
  /** The slot a pending switch will send with, null when none is pending. */
  private _pendingSlot: KeySlot | null = null;

  /** The slot this client sends with: a staged key goes in the other one. */
  get sendSlot(): KeySlot {
    return this._sendSlot;
  }

  constructor(private readonly host: E2EEWorkerHost) {}

  get keyProvider(): SlotKeyProvider {
    return this._keyProvider;
  }

  /** A fresh provider for the Room about to be built. When the session
   *  already has a room key (a connect retry builds its Room after the key
   *  exchange) it is queued into the new provider through the write queue, so
   *  a write still in flight for the previous provider cannot land after it.
   *  The Room subscribes at construction and forwards the key when it lands.
   *  The new Room sends with that key at once, in the slot it already has. */
  newKeyProvider(): SlotKeyProvider {
    const provider = new SlotKeyProvider();
    this._keyProvider = provider;
    const roomKey = this._roomKey;
    if (roomKey !== null) {
      this.applyRoomKey(
        roomKey,
        () => this._keyProvider === provider,
        this.currentPlacement(),
      ).catch((err: unknown) => log.warn("room key install into the new provider failed", err));
    }
    return provider;
  }

  /** Let go of the last Room's provider when the call ends, so nothing keeps
   *  that Room alive while idle. */
  releaseKeyProvider(): void {
    this._keyProvider = new SlotKeyProvider();
  }

  /** The session's room key, used at once in the slot it was placed in. */
  private currentPlacement(): KeyPlacement {
    return { slot: this.host.getRoomKeyPlacement?.().slot ?? 0, stage: false };
  }

  // --- Host views, named as the pre-extraction fields so the bodies read the same ---

  private get _sessionGeneration(): number {
    return this.host.getSessionGeneration();
  }
  private get _roomKey(): Uint8Array | null {
    return this.host.getRoomKey();
  }

  /** Serialize provider writes, skipping keys superseded before their turn.
   *  A failed import rejects its caller without blocking later writes. */
  applyRoomKey(
    roomKey: Uint8Array,
    isCurrent: () => boolean = () => true,
    placement: KeyPlacement = LEGACY_PLACEMENT,
  ): Promise<boolean> {
    const myGeneration = this._sessionGeneration;
    const ownsKey = () =>
      this._sessionGeneration === myGeneration && this._roomKey === roomKey && isCurrent();
    const run = this._keyApplyChain.then(async () => {
      if (!ownsKey()) return false;
      // A key staged into the slot this client still sends on, while its own
      // switch away from that slot is pending, means the sender already
      // switched and rotated again: catch up first, so the new key does not
      // replace the key the rest of the call still sends with.
      const pending = this._pendingSlot;
      if (placement.stage && placement.slot === this._sendSlot && pending !== null) {
        this.cancelPendingSwitch();
        await this.useSlot(pending);
        this._sendSlot = pending;
      }
      // Staging into the slot being sent on would replace the sending key:
      // that is a switch at once.
      const stage = placement.stage && placement.slot !== this._sendSlot;
      // Any key supersedes a switch still waiting for an older one.
      this.cancelPendingSwitch();
      await this.installKey(roomKeyToBase64(roomKey), placement, stage);
      if (!stage) this._sendSlot = placement.slot;
      if (!ownsKey()) return false;
      if (stage) this.scheduleSwitch(placement.slot, ownsKey);
      this.host.onKeyInstalled?.();
      return true;
    });
    this._keyApplyChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** The one place the room key leaves the TS key exchange. On Linux the
   *  Room lives in the Rust backend, so the same base64 text goes over IPC
   *  to its key provider instead (byte-identical derivation); the browser
   *  provider is never written there. A slot-0 key used at once takes the
   *  same path an older client does. */
  private async installKey(
    keyBase64: string,
    placement: KeyPlacement,
    stage: boolean,
  ): Promise<void> {
    const legacy = placement.slot === 0 && !stage;
    if (isLinuxDesktop()) {
      await (legacy
        ? desktop.nativeVoice.setRoomKey(keyBase64)
        : desktop.nativeVoice.setRoomKey(keyBase64, { slot: placement.slot, stage }));
      return;
    }
    if (legacy) await this._keyProvider.setKey(keyBase64);
    else if (stage) await this._keyProvider.stageKey(keyBase64, placement.slot);
    else await this._keyProvider.useKey(keyBase64, placement.slot);
  }

  /** Send with the key staged in `slot` once KEY_SWITCH_DELAY_MS has passed,
   *  if it is still the session's room key then. Queued behind any key write
   *  already in flight, so a newer key always wins. */
  private scheduleSwitch(slot: KeySlot, ownsKey: () => boolean): void {
    this._pendingSlot = slot;
    setOwnedTimeout(
      this._switchOwner.signal,
      () => {
        this._keyApplyChain = this._keyApplyChain
          .then(async () => {
            if (!ownsKey() || this._pendingSlot !== slot) return;
            this._pendingSlot = null;
            await this.useSlot(slot);
            this._sendSlot = slot;
            log.info("E2EE: sending with the new room key", { slot });
          })
          .catch((err) => log.warn("E2EE: switch to the new room key failed", err));
      },
      KEY_SWITCH_DELAY_MS,
    );
  }

  private async useSlot(slot: KeySlot): Promise<void> {
    if (isLinuxDesktop()) {
      await desktop.nativeVoice.useKeySlot(slot);
      return;
    }
    this._keyProvider.useSlot(slot);
  }

  private cancelPendingSwitch(): void {
    this._switchOwner.destroy();
    this._switchOwner = new Disposable();
    this._pendingSlot = null;
  }

  /** Session reset: drop a pending switch and start over on slot 0. The next
   *  session's first key is used at once, whatever slot it names. */
  resetSlots(): void {
    this.cancelPendingSwitch();
    this._sendSlot = 0;
  }

  /** Linux: forget the backend's room key when the session ends. Queued on
   *  the same write queue as installs, so it lands after any write already in
   *  flight and before the next session's key — a quick rejoin's key is never
   *  wiped by the previous session's clear. */
  clearRoomKey(): void {
    if (!isLinuxDesktop()) return;
    this._keyApplyChain = this._keyApplyChain.then(() =>
      desktop.nativeVoice.clearRoomKey().catch((err) => log.warn("native key clear failed", err)),
    );
  }

  /** Setup/reconnect must await the current key even if a rotation or offer
   *  replaces the original snapshot while its provider write is pending. */
  async applyCurrentRoomKey(isCurrent: () => boolean): Promise<void> {
    while (isCurrent() && this._roomKey) {
      // oxlint-disable-next-line no-await-in-loop -- sequential by design: re-reads the live room key after each provider write, retrying until it lands
      if (await this.applyRoomKey(this._roomKey, isCurrent, this.currentPlacement())) return;
    }
  }
}
