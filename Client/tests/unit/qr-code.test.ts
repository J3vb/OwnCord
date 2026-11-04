import { describe, it, expect } from "vitest";
import { encodeQr, qrCodeSvg } from "../../src/lib/ui/qrCode";
import { totpSecretOf } from "../../src/features/settings/AccountSecurity";

/** Modules as hex, four per digit, row-major (the last digit padded with light modules). */
function toHex(modules: readonly boolean[]): string {
  let hex = "";
  for (let i = 0; i < modules.length; i += 4) {
    let v = 0;
    for (let k = 0; k < 4; k++) v = v * 2 + (modules[i + k] === true ? 1 : 0);
    hex += v.toString(16);
  }
  return hex;
}

describe("encodeQr", () => {
  it("matches a reference encoder's version 1-M symbol bit for bit", () => {
    // Checked against python-qrcode (byte mode, level M, the same mask).
    const qr = encodeQr("hi")!;
    expect(qr.size).toBe(21);
    expect(toHex(qr.modules)).toBe(
      "fe7bfc13506eb6bb7595dba9aec16507faafe01700be0be3a9484cd53dd0834ea14a804f27f8ac505fc9ba8925d7492ea53904c34feb4f0",
    );
  });

  it("picks the smallest version that fits and stops after version 20", () => {
    const size = (n: number): number | null => encodeQr("q".repeat(n))?.size ?? null;
    expect(size(14)).toBe(21);
    expect(size(15)).toBe(25);
    expect(size(213)).toBe(57);
    expect(size(666)).toBe(97);
    expect(size(667)).toBeNull();
  });

  it("draws the three finder patterns and the timing lines", () => {
    const qr = encodeQr("otpauth://totp/OwnCord:testuser?secret=JBSWY3DPEHPK3PXP&issuer=OwnCord")!;
    const at = (x: number, y: number): boolean => qr.modules[y * qr.size + x]!;
    for (const [cx, cy] of [
      [3, 3],
      [qr.size - 4, 3],
      [3, qr.size - 4],
    ] as const) {
      expect(at(cx, cy)).toBe(true);
      expect(at(cx - 2, cy)).toBe(false);
      expect(at(cx - 3, cy)).toBe(true);
    }
    for (let i = 8; i < qr.size - 8; i++) {
      expect(at(i, 6)).toBe(i % 2 === 0);
      expect(at(6, i)).toBe(i % 2 === 0);
    }
    expect(at(8, qr.size - 8)).toBe(true);
  });

  it("encodes text as UTF-8", () => {
    expect(encodeQr("é")!.size).toBe(21);
    expect(encodeQr("é".repeat(8))!.size).toBe(25);
  });
});

describe("qrCodeSvg", () => {
  it("draws dark modules on white with a four-module margin and a label", () => {
    const svg = qrCodeSvg("hi", "Setup code")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 29 29");
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("Setup code");
    expect(svg.querySelector("rect")?.getAttribute("fill")).toBe("#fff");
    expect(svg.querySelector("path")?.getAttribute("d")).toMatch(/^M4 4h1v1h-1z/);
  });

  it("returns null for text too long to encode", () => {
    expect(qrCodeSvg("x".repeat(700), "Setup code")).toBeNull();
  });
});

describe("totpSecretOf", () => {
  it("reads the secret from an otpauth link", () => {
    expect(totpSecretOf("otpauth://totp/A:b?secret=jbsw%20y3dp&issuer=A")).toBe("JBSWY3DP");
    expect(totpSecretOf("otpauth://totp/A:b?issuer=A&secret=ABC")).toBe("ABC");
  });

  it("is null without a secret or with a broken one", () => {
    expect(totpSecretOf("otpauth://totp/A:b?issuer=A")).toBeNull();
    expect(totpSecretOf("otpauth://totp/A:b?secret=%E0%A4%A")).toBeNull();
  });
});
