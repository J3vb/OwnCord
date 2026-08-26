declare module "@jitsi/rnnoise-wasm" {
  export function createRNNWasmModule(): Promise<unknown>;
  export function createRNNWasmModuleSync(): unknown;
}
