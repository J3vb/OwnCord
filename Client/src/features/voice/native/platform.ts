// Where voice runs natively. The Linux desktop webview (WebKitGTK) has no
// WebRTC, so `livekitSession` swaps the browser Room for the Rust backend's
// (`src-tauri/src/native_voice/`) behind this one check. A leaf module: it is
// imported statically from the voice chunk, so it must stay dependency-free.

/** True on a Linux desktop whose webview has no WebRTC — the defect the
 *  native LiveKit backend exists for. The capability test is what keeps a
 *  Linux Chromium (the browser e2e suites, or any future browser build) on
 *  the web path; the OS check keeps a broken webview elsewhere from being
 *  mistaken for Linux. Android also reports "Linux" but has no desktop
 *  webview, hence the exclusion. */
export function isLinuxDesktop(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (!/\bLinux\b/.test(ua) || /Android/.test(ua)) return false;
  return typeof RTCPeerConnection === "undefined";
}
