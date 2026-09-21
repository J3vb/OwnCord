// Voice E2EE worker-side key provider — extracted from livekitE2EE.ts.
// Owns the ExternalE2EEKeyProvider every Room's E2EE worker reads its key
// from, and the single write queue that installs room keys into it in order,
// skipping any key superseded before its turn. The room key and the session
// generation stay owned by E2EEManager; this module reads them through
// E2EEWorkerHost.
import { ExternalE2EEKeyProvider } from "livekit-client";
import { roomKeyToBase64 } from "../../lib/e2eeCrypto";

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
      await this.keyProvider.setKey(roomKeyToBase64(roomKey));
      return ownsKey();
    });
    this._keyApplyChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
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
