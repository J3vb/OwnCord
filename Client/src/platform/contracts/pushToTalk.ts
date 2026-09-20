/**
 * Push-to-talk. Seam: `initPtt`, `stopPtt`, `updatePttKey` and
 * `captureKeyPress` are the four native-touching exports of `lib/ptt.ts`
 * (`vkName` is a pure display helper, not part of the native seam), so each
 * contract method below has that function's exact signature. Mirrors those
 * four functions, not `lib/ptt.ts`'s module state (the binding/generation
 * bookkeeping, mute-ownership latch) — that orchestration stays in
 * `lib/ptt.ts` and keeps calling this contract's methods after B7-5.
 */
export interface PushToTalk {
  init(): Promise<void>;
  stop(): Promise<void>;
  updateKey(vk: number): Promise<void>;
  /** Capture the next key press for the binding UI. */
  captureKeyPress(): Promise<number>;
}
