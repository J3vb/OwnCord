// Voice E2EE worker-side key provider — extracted from livekitE2EE.ts.
// Owns the ExternalE2EEKeyProvider every Room's E2EE worker reads its key
// from, and the single write queue that installs room keys into it in order,
// skipping any key superseded before its turn. The room key and the session
// generation stay owned by E2EEManager; this module reads them through
// E2EEWorkerHost.
import { ExternalE2EEKeyProvider } from "livekit-client";
import { roomKeyToBase64 } from "../../lib/e2eeCrypto";
import { createLogger } from "../../lib/logger";
import { desktop } from "../../platform/desktop";
import { isLinuxDesktop } from "./native/platform";

const log = createLogger("e2eeWorker");

/** What the key provider's write queue needs from E2EEManager. */
export interface E2EEWorkerHost {
  getSessionGeneration(): number;
  getRoomKey(): Uint8Array | null;
}

export class E2EEWorker {
  /** E2EE key provider — shared across Room instances. The room key is generated
   *  and exchanged client-side via ECDH; the server never sees it. */
  readonly keyProvider = new ExternalE2EEKeyProvider();
  /** Provider imports are asynchronous. Keep one write queue across session
   *  resets so an abandoned import cannot overwrite a newer session's key. */
  private _keyApplyChain: Promise<void> = Promise.resolve();

  constructor(private readonly host: E2EEWorkerHost) {}

  // --- Host views, named as the pre-extraction fields so the bodies read the same ---

  private get _sessionGeneration(): number {
    return this.host.getSessionGeneration();
  }
  private get _roomKey(): Uint8Array | null {
    return this.host.getRoomKey();
  }

  /** Serialize provider writes, skipping keys superseded before their turn.
   *  A failed import rejects its caller without blocking later writes. */
  applyRoomKey(roomKey: Uint8Array, isCurrent: () => boolean = () => true): Promise<boolean> {
    const myGeneration = this._sessionGeneration;
    const ownsKey = () =>
      this._sessionGeneration === myGeneration && this._roomKey === roomKey && isCurrent();
    const run = this._keyApplyChain.then(async () => {
      if (!ownsKey()) return false;
      await this.installKey(roomKeyToBase64(roomKey));
      return ownsKey();
    });
    this._keyApplyChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** The one place the room key leaves the TS key exchange. On Linux the
   *  Room lives in the Rust backend, so the same base64 text goes over IPC
   *  to its key provider instead (byte-identical derivation, index 0); the
   *  browser provider is never written there. Everywhere else: unchanged. */
  private async installKey(keyBase64: string): Promise<void> {
    if (isLinuxDesktop()) {
      await desktop.nativeVoice.setRoomKey(keyBase64);
      return;
    }
    await this.keyProvider.setKey(keyBase64);
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
      if (await this.applyRoomKey(this._roomKey, isCurrent)) return;
    }
  }
}
