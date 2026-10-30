// Makes the page look like the Tauri app on Android (a Tauri host marker and
// an Android user agent), the way `isAndroidApp()` reads it, and puts the
// desktop app back afterwards.
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 16; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0 Mobile Safari/537.36";
const WINDOWS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0 Safari/537.36 Edg/155.0";

function setHost(userAgent: string): void {
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: userAgent });
  (globalThis as Record<string, unknown>)["__TAURI_INTERNALS__"] = {};
}

export function hostAndroidApp(): void {
  setHost(ANDROID_UA);
}

export function hostDesktopApp(): void {
  setHost(WINDOWS_UA);
}

export function clearHost(): void {
  Reflect.deleteProperty(navigator, "userAgent");
  delete (globalThis as Record<string, unknown>)["__TAURI_INTERNALS__"];
}
