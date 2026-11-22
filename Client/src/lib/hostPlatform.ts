// Which host the webview runs in, for the layers below `features/` that cannot
// import `features/voice/native/platform.ts`. A leaf: no imports.

/** True in the Tauri app on Android (a Tauri host and an Android user agent).
 *  A phone browser is not this: it has no native host. */
export function isAndroidHost(): boolean {
  if (typeof navigator === "undefined" || !("__TAURI_INTERNALS__" in globalThis)) return false;
  return /Android/.test(navigator.userAgent);
}

/** True when the page is served over http(s). The desktop app on Linux runs
 *  from its own `tauri:` address instead, and WebKit sends no Referer from
 *  such a page, so a third-party frame that requires one (YouTube's player)
 *  cannot play there. */
export function pageIsWebOrigin(): boolean {
  return location.protocol === "http:" || location.protocol === "https:";
}
