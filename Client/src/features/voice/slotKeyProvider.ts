// The room key provider every browser-path Room's E2EE worker reads from.
//
// livekit-client's ExternalE2EEKeyProvider holds one key, in slot 0: a new
// room key replaces the old one for sending and receiving at the same moment,
// so frames a peer still encrypts with the old key fail to decrypt until it
// gets the new one, and video then freezes until the next keyframe. This
// provider keeps two slots. A key can be staged in a slot (receive only) and
// sending switched to it later; senders tag each frame with their slot, so a
// receiver holding both keys decrypts frames from either side of a switch.
//
// `setKey` keeps ExternalE2EEKeyProvider's contract (slot 0, used at once),
// which is what a peer on an older client does with every key.
import {
  ExternalE2EEKeyProvider,
  KeyProviderEvent,
  createKeyMaterialFromString,
  type KeyInfo,
} from "livekit-client";
import type { KeySlot } from "../../lib/net/keyPlacement";

export class SlotKeyProvider extends ExternalE2EEKeyProvider {
  private readonly slots = new Map<KeySlot, KeyInfo>();
  private sendSlot: KeySlot = 0;

  /** Slot 0, used for sending at once. */
  override async setKey(key: string | ArrayBuffer): Promise<void> {
    if (typeof key !== "string") {
      // i18n-exempt: internal E2EE guard, never rendered
      throw new TypeError("SlotKeyProvider takes the room key as base64 text");
    }
    await this.useKey(key, 0);
  }

  /** Put `key` in `slot` and send with it from now on. */
  async useKey(key: string, slot: KeySlot): Promise<void> {
    const info = await this.keyInfo(key, slot);
    this.slots.set(slot, info);
    this.sendSlot = slot;
    this.emit(KeyProviderEvent.SetKey, info, true);
  }

  /** Put `key` in `slot` for receiving only; `useSlot` switches sending to it.
   *  Staging into the slot being sent on would replace the sending key, so
   *  that is a `useKey`. */
  async stageKey(key: string, slot: KeySlot): Promise<void> {
    if (slot === this.sendSlot) {
      await this.useKey(key, slot);
      return;
    }
    const info = await this.keyInfo(key, slot);
    this.slots.set(slot, info);
    this.emit(KeyProviderEvent.SetKey, info, false);
  }

  /** Send with the key already in `slot`. False when the slot is empty. */
  useSlot(slot: KeySlot): boolean {
    const info = this.slots.get(slot);
    if (info === undefined) return false;
    this.sendSlot = slot;
    this.emit(KeyProviderEvent.SetKey, info, true);
    return true;
  }

  /** The slot frames are sent with. */
  get currentSlot(): KeySlot {
    return this.sendSlot;
  }

  // The Room's E2EE manager hands its worker every key through these two when
  // it connects: each slot's key, and which one it sends with.
  override getKeys(): KeyInfo[] {
    return [...this.slots.values()];
  }

  override getLatestManuallySetKeyIndex(): number {
    return this.sendSlot;
  }

  private async keyInfo(key: string, slot: KeySlot): Promise<KeyInfo> {
    // The same derivation ExternalE2EEKeyProvider.setKey runs on text, so the
    // Linux engine and older peers derive the identical frame key.
    return { key: await createKeyMaterialFromString(key), keyIndex: slot };
  }
}
