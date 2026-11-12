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

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
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

  it("matches the reference encoder past version 1", async () => {
    // Checked against python-qrcode 8 (byte mode, level M) with the mask this
    // encoder picks: these cover alignment patterns, split and uneven blocks,
    // the version blocks and the 16-bit length field. Big symbols are pinned
    // by the SHA-256 of their hex.
    const v2 = encodeQr("q".repeat(21))!;
    expect(v2.size).toBe(25);
    expect(toHex(v2.modules)).toBe(
      "fee5bfc123506e9cebb758e5dba8daec157507faaafe0127008bb8fcc086e495e054988e704b2a8e6e652e489d0548129704d7b6fe8055c4bfb7aa9042914ba8cffdd33b0ee986cd0454a6fe977f8",
    );
    const v5 = encodeQr("https://example.com/a-longer-text-for-version-five-or-so-0123456789")!;
    expect(v5.size).toBe(37);
    expect(toHex(v5.modules)).toBe(
      "fe3068e3fc119893906eb14724bb75c3a7e5dba983102ec15c110d07faaaaaafe01f112700be3a2f5be2a33c2d098eb612b7df48f14d7f95650cbe6fcac77e868348ad1357723e0cc3b20a899546b4c20b7f21bb9c759e479a863e5615bbfdae6e321b4d8422b8cea94f733131063362e72f52a4408c2f4822981a2ebf12e94a4e2821260dfe80747ec463f9a510aaf051ddd11abadd845fadd7cb5f376eab659a0704b63c591febbdae6b8",
    );
    const big: Array<[string, number, string]> = [
      ["x".repeat(140), 49, "96af2317c6e3d9961da2cd22d717a6e67aaf2de10f83450ec5d387125f7d5999"],
      ["é".repeat(150), 69, "258b69b96967145b3b6520133fde1475c10d87a062af5e3efeff6793d6d5c043"],
      ["Z".repeat(400), 77, "66704d6faf140594ae39830be922288f91253eebf98301161836be341b8adcb3"],
      ["k".repeat(666), 97, "0e1656025252d4c45de8818662c3b5c64fcd5b1256387e0d9fc4e00a55b6e4d4"],
    ];
    const symbols = big.map(([text]) => encodeQr(text)!);
    const digests = await Promise.all(symbols.map((qr) => sha256(toHex(qr.modules))));
    expect(symbols.map((qr) => qr.size)).toEqual(big.map(([, size]) => size));
    expect(digests).toEqual(big.map(([, , digest]) => digest));
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
