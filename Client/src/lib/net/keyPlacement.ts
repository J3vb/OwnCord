// Where a voice room key goes in the key provider. Senders tag every frame
// with their slot, so a receiver holding both slots decrypts the old key and
// the new one while a rotation switches over.

/** The key slots a room key can sit in. */
export type KeySlot = 0 | 1;

/** A room key's slot, and whether it is staged there (received with only,
 *  sending switches later) or sent with at once. */
export interface KeyPlacement {
  readonly slot: KeySlot;
  readonly stage: boolean;
}

/** Slot 0, sent with at once: what every pre-slot client does with any key. */
export const LEGACY_PLACEMENT: KeyPlacement = { slot: 0, stage: false };
