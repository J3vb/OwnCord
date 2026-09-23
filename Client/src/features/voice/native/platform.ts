// Where voice runs natively. The Linux desktop webview (WebKitGTK) has no
// WebRTC, so `livekitSession` swaps the browser Room for the Rust backend's
// (`src-tauri/src/native_voice/`) behind this one check. A leaf module: it is
// imported statically from the voice chunk, so it must stay dependency-free.

/** True in the Tauri app on a Linux desktop — the only place the native
 *  LiveKit backend exists. Keyed on the host, not on `RTCPeerConnection`, so
 *  a WebKitGTK built with WebRTC still takes the native path; a Linux
 *  browser (no Tauri host) keeps the web path. Android also reports "Linux"
 *  but has no desktop webview, hence the exclusion. */
export function isLinuxDesktop(): boolean {
  if (typeof navigator === "undefined" || !("__TAURI_INTERNALS__" in globalThis)) return false;
  const ua = navigator.userAgent;
  return /\bLinux\b/.test(ua) && !/Android/.test(ua);
}
