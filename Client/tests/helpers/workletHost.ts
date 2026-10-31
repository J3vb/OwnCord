import { afterEach, beforeEach, vi } from "vitest";

/**
 * Registers the beforeEach/afterEach that give a worklet script the globals an
 * AudioWorkletGlobalScope has: `registerProcessor`, forwarded to `onRegister`,
 * and a base `AudioWorkletProcessor` whose port posts through `makePostMessage()`.
 * Modules are reset first so the script registers again for every test.
 */
export function useFakeWorkletHost<Processor>(
  onRegister: (name: string, ctor: new () => Processor) => void,
  makePostMessage: () => unknown = () => () => {},
): void {
  beforeEach(() => {
    vi.resetModules();
    class FakeAudioWorkletProcessor {
      readonly port = { onmessage: null, postMessage: makePostMessage() };
    }
    Object.assign(globalThis, {
      registerProcessor: (name: string, ctor: new () => Processor) => onRegister(name, ctor),
      AudioWorkletProcessor: FakeAudioWorkletProcessor,
    });
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).registerProcessor;
    delete (globalThis as Record<string, unknown>).AudioWorkletProcessor;
  });
}
