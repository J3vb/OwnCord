import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { certPinsFile, pinOfCertificate } from "../e2e/support/artifact-app";

// A throwaway self-signed certificate; its SHA-256 is what `openssl x509
// -fingerprint -sha256` prints, lowercased the way the Rust cert store keeps it.
const PEM = `-----BEGIN CERTIFICATE-----
MIIBfTCCASOgAwIBAgIUHbkF1pq60eNtg13VA5cE3ThBDdQwCgYIKoZIzj0EAwIw
EzERMA8GA1UEAwwIcGluLXRlc3QwIBcNMjYxMDA2MTgwODIyWhgPMjEyNjA5MTIx
ODA4MjJaMBMxETAPBgNVBAMMCHBpbi10ZXN0MFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEk6KAgpMkSuX69J42XCOwGS/+Y/uIzro5FFCmap4934BZXHOYButlUAYD
gv1Ps4CcE6UFOtfH7fGjXfHUwRI0l6NTMFEwHQYDVR0OBBYEFNsIr92VS7y7J/v7
mbApKYDj5509MB8GA1UdIwQYMBaAFNsIr92VS7y7J/v7mbApKYDj5509MA8GA1Ud
EwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIgPoSOQQkkAGoTx4Pr7lOqk+RA
WwhYfgQgnFszw7KZmE0CIQDGN3uN1PMpkzGxUOZvQ2ykzrlDQtSuMHhoHkM6J4uF
+g==
-----END CERTIFICATE-----
`;
const FINGERPRINT =
  "d9:b3:3c:90:2d:b6:1a:db:5e:a5:22:7b:0e:c4:5a:bc:a7:32:c3:20:50:fe:0e:7b:b4:08:f2:8c:fd:f4:89:1c";

describe("artifact smoke certificate pin seed", () => {
  it("reads a server certificate as the lowercase colon-hex pin the app stores", () => {
    expect(pinOfCertificate(PEM)).toBe(FINGERPRINT);
  });

  it("writes certs.json keyed the way the app's cert store keys a host", async () => {
    const dir = await mkdtemp(join(tmpdir(), "owncord-pin-test-"));
    try {
      const file = await certPinsFile(dir, {
        "127.0.0.1:8443": FINGERPRINT,
        "Example.COM:8443": "x",
      });
      expect(file).toBe(join(dir, "certs.json"));
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
        "127.0.0.1:8443": FINGERPRINT,
        "example.com:8443": "x",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
