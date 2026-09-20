declare module "@jitsi/rnnoise-wasm" {
  export function createRNNWasmModule(): Promise<unknown>;
  export function createRNNWasmModuleSync(): unknown;
}

// The deep module (B7-7): the barrel re-exports createRNNWasmModuleSync, whose
// ~1.9 MB embedded-WASM file ships in the livekitSession chunk when the barrel
// is imported (no `sideEffects` field, so it cannot be tree-shaken away). Only
// this async factory is used at runtime.
declare module "@jitsi/rnnoise-wasm/dist/rnnoise" {
  export default function createRNNWasmModule(opts?: Record<string, unknown>): unknown;
}