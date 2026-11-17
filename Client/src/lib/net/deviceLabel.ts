/** A signed-in device's short name, shared by the sign-in alert and the devices list. */

import type { accountText } from "../../i18n/account";

/**
 * Every desktop sign-in records one of two identical User-Agent strings — the
 * saved-password path's `OwnCord-Client/<version>` and tauri-plugin-http's
 * default — so they carry no per-device detail. Name them plainly; IP and
 * last-used are what tell two desktops apart.
 */
const DESKTOP_USER_AGENT = /^(OwnCord-Client|tauri-plugin-http)\//;

// Order matters: Edge and Opera also send "Chrome/", iOS "like Mac OS X" and
// Android "Linux".
const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"], // i18n-exempt: product name
  [/\b(?:OPR|Opera)\//, "Opera"], // i18n-exempt: product name
  [/\b(?:Firefox|FxiOS)\//, "Firefox"], // i18n-exempt: product name
  [/\b(?:Chrome|CriOS|Chromium)\//, "Chrome"], // i18n-exempt: product name
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"], // i18n-exempt: product name
];
const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/\bWindows\b/, "Windows"], // i18n-exempt: product name
  [/\bAndroid\b/, "Android"], // i18n-exempt: product name
  [/\b(?:iPhone|iPad|iPod)\b/, "iOS"], // i18n-exempt: product name
  [/\bCrOS\b/, "ChromeOS"], // i18n-exempt: product name
  [/\b(?:Macintosh|Mac OS X)\b/, "macOS"], // i18n-exempt: product name
  [/\bLinux\b/, "Linux"], // i18n-exempt: product name
];

function firstMatch(table: readonly (readonly [RegExp, string])[], text: string): string | null {
  return table.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

/** "OwnCord desktop", "Chrome on Windows", or "Unknown device". The result
 *  only ever comes from these fixed names, never from the User-Agent text.
 *  The caller hands in the account catalog, so this module imports nothing at
 *  run time and its own small chunk (vite.config.ts) carries nothing else. */
export function deviceLabel(userAgent: string, t: typeof accountText): string {
  if (DESKTOP_USER_AGENT.test(userAgent)) return t("notice.desktop");
  const browser = firstMatch(BROWSERS, userAgent);
  if (browser === null) return t("notice.unknownDevice");
  const os = firstMatch(SYSTEMS, userAgent);
  return os === null ? browser : t("notice.browserOn", { browser, os });
}
