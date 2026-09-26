/**
 * Push-to-talk. The four methods have the exact signatures of `lib/ptt.ts`'s
 * former `initPtt`, `stopPtt`, `updatePttKey` and `captureKeyPress`
 * (`vkName` is a pure display helper and stays there). `pushToTalk.suite.ts`
 * binds `init()` to the persisted key and `stop()`/`updateKey()` to the
 * binding's polling state, so B7-5 moved the whole service with its native
 * calls — the binding/generation bookkeeping and the mute-ownership latch
 * included — to `platform/desktop/pushToTalkService.ts`, loaded lazily by the
 * registered facade (`pushToTalk.ts`) because it gates the mic through the
 * voice store.
 */
export interface PushToTalk {
  init(): Promise<void>;
  stop(): Promise<void>;
  updateKey(vk: number): Promise<void>;
  /** Capture the next key press for the binding UI. */
  captureKeyPress(): Promise<number>;
}
