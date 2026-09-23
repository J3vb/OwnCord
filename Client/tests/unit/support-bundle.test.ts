// Local support bundle (B7-15c): the store-only zip writer, the allowlisted
// contents, and the planted-secret negative control.
import { crc32 as nodeCrc32 } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { desktop } = vi.hoisted(() => ({
  desktop: {
    fileSaver: { pickSaveLocation: vi.fn(), writeFile: vi.fn() },
    appMetadata: { getVersion: vi.fn() },
    logFiles: { readAll: vi.fn() },
    settings: { load: vi.fn() },
  },
}));

import { STORAGE_PREFIX } from "../../src/lib/preferences";
import {
  SETTINGS_PREFIX,
  buildSupportBundle,
  crc32,
  exportSupportBundle,
  zipStore,
  type SupportBundleSources,
} from "../../src/lib/supportBundle";

interface ZipEntry {
  readonly name: string;
  readonly crc: number;
  readonly data: Uint8Array;
}

/** Read a zip back through its central directory, checking each local header
 *  agrees with it — the path every unzip tool takes. */
function readZip(zip: Uint8Array): ZipEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.length - 22;
  expect(view.getUint32(eocd, true)).toBe(0x06054b50);
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  expect(at + view.getUint32(eocd + 12, true)).toBe(eocd);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    expect(view.getUint16(at + 10, true)).toBe(0); // stored
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    expect(view.getUint32(at + 24, true)).toBe(size);
    const nameLen = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLen));
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    expect(view.getUint32(local + 14, true)).toBe(crc);
    expect(view.getUint16(local + 26, true)).toBe(nameLen);
    const start = local + 30 + nameLen + view.getUint16(local + 28, true);
    entries.push({ name, crc, data: zip.subarray(start, start + size) });
    at += 46 + nameLen;
  }
  return entries;
}

const text = (data: Uint8Array): string => new TextDecoder().decode(data);

describe("crc32", () => {
  it("matches Node's zlib.crc32", () => {
    const random = Uint8Array.from({ length: 4096 }, (_, i) => (i * 7919 + 13) & 0xff);
    for (const input of [new Uint8Array(0), new TextEncoder().encode("OwnCord"), random]) {
      expect(crc32(input)).toBe(nodeCrc32(input));
    }
  });
});

describe("zipStore", () => {
  it("writes entries a zip reader recovers byte for byte, with checked CRCs", () => {
    const entries = [
      { name: "a.txt", data: new TextEncoder().encode("hello") },
      { name: "logs/é.jsonl", data: Uint8Array.from({ length: 300 }, (_, i) => i & 0xff) },
      { name: "empty", data: new Uint8Array(0) },
    ];
    const read = readZip(zipStore(entries, new Date(2026, 8, 22, 13, 45, 30)));
    expect(read.map((e) => e.name)).toEqual(["a.txt", "logs/é.jsonl", "empty"]);
    read.forEach((entry, i) => {
      expect([...entry.data]).toEqual([...entries[i]!.data]);
      expect(entry.crc).toBe(nodeCrc32(entries[i]!.data));
    });
  });

  it("stamps the DOS date and time", () => {
    const zip = zipStore(
      [{ name: "x", data: new Uint8Array(1) }],
      new Date(2026, 8, 22, 13, 45, 30),
    );
    const view = new DataView(zip.buffer);
    expect(view.getUint16(10, true)).toBe((13 << 11) | (45 << 5) | 15);
    expect(view.getUint16(12, true)).toBe(((2026 - 1980) << 9) | (9 << 5) | 22);
  });
});

// Every class the bundle must never carry (docs/architecture/diagnostics.md's
// forbidden classes, client side), planted wherever the sources could reach.
const PLANTED = {
  token: "planted-session-token-5f1c",
  password: "planted-password-hunter2",
  kitSecret: "PLNT-KITS-ECRE-TABC-DEFG-HIJK-LMNO-PQRS",
  recoveryCode: "PLNT1-RCODE",
  totpSecret: "PLANTEDTOTPSECRETBASE32",
} as const;

function storageWith(entries: Record<string, string>): Pick<Storage, "getItem"> {
  return { getItem: (key) => entries[key] ?? null };
}

function sources(overrides: Partial<SupportBundleSources> = {}): SupportBundleSources {
  return {
    appVersion: "1.2.3",
    logs: [
      { name: "2026-09-21.jsonl", text: '{"message":"one"}\n' },
      { name: "2026-09-22.jsonl", text: '{"message":"two"}\n' },
    ],
    profiles: [
      {
        id: "p1",
        name: "Home",
        host: "chat.example:8443",
        username: "alice",
        autoConnect: true,
        rememberPassword: true,
        color: "#fff",
        lastConnected: null,
      },
    ],
    storage: storageWith({ "owncord:settings:fontSize": "16" }),
    voiceDiagnostics: { hasRoom: false },
    now: new Date("2026-09-22T12:00:00Z"),
    ...overrides,
  };
}

describe("buildSupportBundle", () => {
  it("reads settings under the same prefix preferences writes them", () => {
    expect(SETTINGS_PREFIX).toBe(STORAGE_PREFIX);
  });

  it("contains exactly the enumerated files", () => {
    const names = readZip(buildSupportBundle(sources())).map((e) => e.name);
    expect(names).toEqual([
      "README.txt",
      "app.json",
      "settings.json",
      "voice-diagnostics.json",
      "logs/2026-09-21.jsonl",
      "logs/2026-09-22.jsonl",
    ]);
  });

  it("copies allowlisted settings and profile fields only", () => {
    const entries = readZip(buildSupportBundle(sources()));
    const settings = JSON.parse(text(entries.find((e) => e.name === "settings.json")!.data));
    expect(settings).toEqual({
      settings: { fontSize: 16 },
      profiles: [
        {
          name: "Home",
          host: "chat.example:8443",
          username: "alice",
          autoConnect: true,
          rememberPassword: true,
          lastConnected: null,
        },
      ],
    });
    const app = JSON.parse(text(entries.find((e) => e.name === "app.json")!.data));
    expect(app).toEqual({ version: "1.2.3", exportedAt: "2026-09-22T12:00:00.000Z" });
  });

  it("carries no planted token, password, kit secret, recovery code or TOTP secret", () => {
    const planted = Object.values(PLANTED);
    const storage: Record<string, string> = {
      // A positive control: an allowlisted key must come through, or the
      // absence checks below prove nothing about where the search looked.
      "owncord:settings:accentColor": JSON.stringify("#123456"),
      "owncord:settings:customStatus": JSON.stringify(PLANTED.password),
      "owncord:settings:token": JSON.stringify(PLANTED.token),
      "owncord:settings:totpSecret": JSON.stringify(PLANTED.totpSecret),
      "owncord:credentials": PLANTED.kitSecret,
      "owncord:recovery": PLANTED.recoveryCode,
    };
    const profiles = [
      {
        name: "Home",
        host: "chat.example",
        username: "alice",
        password: PLANTED.password,
        token: PLANTED.token,
        kitSecret: PLANTED.kitSecret,
        recoveryCodes: [PLANTED.recoveryCode],
        totpSecret: PLANTED.totpSecret,
        autoConnect: { nested: PLANTED.token },
      },
    ];
    const bundle = text(
      buildSupportBundle(sources({ storage: storageWith(storage), profiles, logs: [] })),
    );

    expect(bundle).toContain("#123456");
    for (const secret of planted) expect(bundle).not.toContain(secret);
  });

  // Logs are the one part not allowlisted: the logger does not redact, so the
  // bundle states that they are verbatim instead of pretending to scrub them.
  it("exports log files verbatim and says so in the README", () => {
    const line = `{"message":"login","data":{"password":"${PLANTED.password}"}}\n`;
    const entries = readZip(
      buildSupportBundle(sources({ logs: [{ name: "2026-09-22.jsonl", text: line }] })),
    );
    expect(text(entries.find((e) => e.name === "logs/2026-09-22.jsonl")!.data)).toBe(line);
    expect(text(entries.find((e) => e.name === "README.txt")!.data)).toContain(
      "The log files are NOT redacted",
    );
  });

  it("tolerates a malformed profile list and an unreadable setting", () => {
    const entries = readZip(
      buildSupportBundle(
        sources({ profiles: "nope", storage: storageWith({ "owncord:settings:fontSize": "{" }) }),
      ),
    );
    const settings = JSON.parse(text(entries.find((e) => e.name === "settings.json")!.data));
    expect(settings).toEqual({ settings: { fontSize: "(unreadable)" }, profiles: [] });
  });
});

describe("exportSupportBundle", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    desktop.appMetadata.getVersion.mockResolvedValue("1.2.3");
    desktop.logFiles.readAll.mockResolvedValue([{ name: "2026-09-22.jsonl", text: "x\n" }]);
    desktop.settings.load.mockResolvedValue({ schemaVersion: 1, profiles: [] });
    desktop.fileSaver.writeFile.mockResolvedValue(undefined);
  });

  it("reads nothing and writes nothing when the save dialog is cancelled", async () => {
    desktop.fileSaver.pickSaveLocation.mockResolvedValue(null);

    await expect(exportSupportBundle(desktop as never, {})).resolves.toBe(false);
    expect(desktop.logFiles.readAll).not.toHaveBeenCalled();
    expect(desktop.fileSaver.writeFile).not.toHaveBeenCalled();
  });

  it("writes the zip to the chosen path without calling any server", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    desktop.fileSaver.pickSaveLocation.mockResolvedValue("/tmp/bundle.zip");

    await expect(exportSupportBundle(desktop as never, { hasRoom: true })).resolves.toBe(true);

    expect(desktop.fileSaver.pickSaveLocation.mock.calls[0]![0]).toMatch(
      /^owncord-support-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.zip$/,
    );
    const [path, bytes] = desktop.fileSaver.writeFile.mock.calls[0]! as [string, Uint8Array];
    expect(path).toBe("/tmp/bundle.zip");
    const entries = readZip(bytes);
    expect(entries.map((e) => e.name)).toContain("logs/2026-09-22.jsonl");
    expect(
      JSON.parse(text(entries.find((e) => e.name === "voice-diagnostics.json")!.data)),
    ).toEqual({ hasRoom: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
