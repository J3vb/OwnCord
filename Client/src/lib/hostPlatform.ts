// Which host the webview runs in, for the layers below `features/` that cannot
// import `features/voice/native/platform.ts`. A leaf: no imports.

/** True in the Tauri app on Android (a Tauri host and an Android user agent).
 *  A phone browser is not this: it has no native host. */
export function isAndroidHost(): boolean {
  if (typeof navigator === "undefined" || !("__TAURI_INTERNALS__" in globalThis)) return false;
  return /Android/.test(navigator.userAgent);
}
