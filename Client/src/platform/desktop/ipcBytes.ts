// Raw-bytes IPC responses arrive in one of two shapes. The custom-protocol
// transport hands back an `ArrayBuffer`; once the webview falls back to the
// postMessage interface (Linux, when the CSP blocks `ipc:`), the same response
// is a JSON `number[]`. Plugin paths (http, fs) normalise their own, so only a
// first-party raw-byte command needs this.
export function ipcBytes(
  value: ArrayBuffer | ArrayBufferView | readonly number[],
): Uint8Array<ArrayBuffer> {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    // A copy, so the result is backed by a plain ArrayBuffer (a valid BlobPart).
    return new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  return Uint8Array.from(value);
}
