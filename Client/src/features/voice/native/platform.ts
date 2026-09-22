// Where voice runs natively. The Linux desktop webview (WebKitGTK) has no
// WebRTC, so `livekitSession` swaps the browser Room for the Rust backend's
// (`src-tauri/src/native_voice/`) behind this one check. A leaf module: it is
// imported statically from the voice chunk, so it must stay dependency-free.

/** True on a Linux desktop — the only place the native LiveKit backend
 *  exists. The client is the Tauri app on every platform today, so the OS
 *  is the whole test; Android also reports "Linux" but has no desktop
 *  webview, hence the exclusion. */
export function isLinuxDesktop(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /\bLinux\b/.test(ua) && !/Android/.test(ua);
}
