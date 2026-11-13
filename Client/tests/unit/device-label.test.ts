import { describe, it, expect } from "vitest";
import { deviceLabel as labelWith } from "../../src/lib/net/deviceLabel";
import { accountText } from "../../src/i18n/account";

const deviceLabel = (ua: string): string => labelWith(ua, accountText);

const CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.8127.18 Safari/537.36";

describe("deviceLabel", () => {
  it("names a browser by its browser and system", () => {
    const cases: Array<[string, string]> = [
      [CHROME_WINDOWS, "Chrome on Windows"],
      [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
        "Edge on Windows",
      ],
      [
        "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
        "Firefox on Linux",
      ],
      [
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
        "Safari on iOS",
      ],
      [
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
        "Chrome on Android",
      ],
      [
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
        "Safari on macOS",
      ],
      [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0",
        "Opera on Windows",
      ],
      ["Firefox/132.0", "Firefox"],
    ];
    for (const [ua, label] of cases) expect(deviceLabel(ua), ua).toBe(label);
  });

  it("names both desktop User-Agents as the desktop app", () => {
    expect(deviceLabel("OwnCord-Client/1.4.0")).toBe("OwnCord desktop");
    expect(deviceLabel("tauri-plugin-http/2.6.0")).toBe("OwnCord desktop");
  });

  it("says Unknown device for an empty or unrecognised User-Agent", () => {
    expect(deviceLabel("")).toBe("Unknown device");
    expect(deviceLabel("curl/8.0")).toBe("Unknown device");
  });

  it("never echoes an over-long or control-character User-Agent", () => {
    expect(deviceLabel("x".repeat(20_000))).toBe("Unknown device");
    expect(deviceLabel("\u0000\u202e\n<b>evil</b>")).toBe("Unknown device");
    expect(deviceLabel(`\u202eChrome/1.0 ${"y".repeat(20_000)}`)).toBe("Chrome");
  });
});
