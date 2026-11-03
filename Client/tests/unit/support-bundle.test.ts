// Local support bundle (B7-15c): the store-only zip writer, the allowlisted
// contents, and the planted-secret negative control.
import { crc32 as nodeCrc32 } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { desktop } = vi.hoisted(() => ({
  desktop: {
    fileSaver: { pickSaveLocation: vi.fn(), writeFile: vi.fn() },
    appMetadata: { getVersion: vi.fn() },
    logFiles: { readAll: vi.fn(), readNative: vi.fn() },
    settings: { load: vi.fn() },
    shareSheet: { available: false, shareFile: vi.fn() },
  },
}));

import { STORAGE_PREFIX } from "../../src/lib/prefs/preferences";
import { settingsText } from "../../src/i18n/settings";
import {
  BUNDLE_CAP_BYTES,
  BUNDLE_FORMAT,
  SETTINGS_PREFIX,
  buildSupportBundle,
  crc32,
  exportSupportBundle,
  zipStore,
  type BundleManifest,
  type SupportBundleSources,
} from "../../src/lib/supportBundle";
import { sha256Hex } from "../../src/lib/diagnostics/sha256";

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
    nativeLogs: [{ name: "owncord-client.log", text: "[startup] frontend ready after 42 ms\n" }],
    environment: { platform: "Win32", userAgent: "Mozilla/5.0 (Windows) OwnCord" },
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
      "manifest.json",
      "redactions.json",
      "app.json",
      "settings.json",
      "voice-diagnostics.json",
      "last-exit.json",
      "logs/2026-09-21.jsonl",
      "logs/2026-09-22.jsonl",
      "logs/owncord-client.log",
    ]);
  });

  it("adds share-diagnostics.json after voice-diagnostics.json only when a timeline exists", () => {
    const timeline = { policy: "legacy", policyVersion: "2b-1", samples: [{ t: 1000 }] };
    const entries = readZip(buildSupportBundle(sources({ shareDiagnostics: timeline })));
    const names = entries.map((e) => e.name);
    expect(names.indexOf("share-diagnostics.json")).toBe(
      names.indexOf("voice-diagnostics.json") + 1,
    );
    expect(
      JSON.parse(text(entries.find((e) => e.name === "share-diagnostics.json")!.data)),
    ).toEqual(timeline);
    for (const none of [null, undefined]) {
      const bare = readZip(buildSupportBundle(sources({ shareDiagnostics: none })));
      expect(bare.map((e) => e.name)).not.toContain("share-diagnostics.json");
    }
  });

  it("lists share-diagnostics.json in the README and keeps the share test settings", () => {
    const entries = readZip(
      buildSupportBundle(
        sources({
          storage: storageWith({
            "owncord:settings:shareDiagnosticsV2": "true",
            "owncord:settings:shareMotionPolicy": '"motion-balanced"',
          }),
        }),
      ),
    );
    expect(text(entries.find((e) => e.name === "README.txt")!.data)).toContain(
      "share-diagnostics.json",
    );
    const settings = JSON.parse(text(entries.find((e) => e.name === "settings.json")!.data));
    expect(settings.settings).toMatchObject({
      shareDiagnosticsV2: true,
      shareMotionPolicy: "motion-balanced",
    });
  });

  it("records OS and webview in app.json, and no server version", () => {
    const entries = readZip(buildSupportBundle(sources()));
    const app = JSON.parse(text(entries.find((e) => e.name === "app.json")!.data));
    expect(app).toEqual({
      version: "1.2.3",
      exportedAt: "2026-09-22T12:00:00.000Z",
      os: "Win32",
      userAgent: "Mozilla/5.0 (Windows) OwnCord",
      serverVersion: null,
      serverVersionNote: "not collected (bundle makes no server call, decision 7)",
    });
  });

  it("carries the Rust log verbatim with the JSONL logs", () => {
    const entries = readZip(
      buildSupportBundle(
        sources({
          nativeLogs: [
            { name: "owncord-client.log", text: "[startup] frontend ready\n" },
            { name: "owncord-client_2026-09-20_10-00-00.log", text: "[panic] boom\n" },
          ],
        }),
      ),
    );
    expect(text(entries.find((e) => e.name === "logs/owncord-client.log")!.data)).toBe(
      "[startup] frontend ready\n",
    );
    expect(
      text(entries.find((e) => e.name === "logs/owncord-client_2026-09-20_10-00-00.log")!.data),
    ).toBe("[panic] boom\n");
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
  // bundle redacts every item on its way into the zip, and says what it can miss.
  it("redacts log files and says so in the README", () => {
    const line = `{"message":"login","data":{"password":"${PLANTED.password}"}}\n`;
    const entries = readZip(
      buildSupportBundle(sources({ logs: [{ name: "2026-09-22.jsonl", text: line }] })),
    );
    expect(text(entries.find((e) => e.name === "logs/2026-09-22.jsonl")!.data)).toBe(
      '{"message":"login","data":{"password":"[redacted]"}}\n',
    );
    const readme = text(entries.find((e) => e.name === "README.txt")!.data);
    expect(readme).toBe(settingsText("logs.bundleReadme"));
    expect(readme).toContain("passes through a redaction step");
  });

  it("does not claim secrets are never read, and warns that logs may hold sensitive values", () => {
    const readme = text(
      readZip(buildSupportBundle(sources())).find((e) => e.name === "README.txt")!.data,
    );
    expect(readme).not.toContain("never read into this bundle");
    expect(readme).toContain("can contain anything the app logged");
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
    desktop.logFiles.readNative.mockResolvedValue([
      { name: "owncord-client.log", text: "[startup] frontend ready\n" },
    ]);
    desktop.settings.load.mockResolvedValue({ schemaVersion: 1, profiles: [] });
    desktop.fileSaver.writeFile.mockResolvedValue(undefined);
  });

  it("still writes the bundle when the app version cannot be read", async () => {
    desktop.fileSaver.pickSaveLocation.mockResolvedValue("bundle.zip");
    desktop.appMetadata.getVersion.mockRejectedValue(new Error("unavailable"));

    await expect(exportSupportBundle(desktop as never, {})).resolves.toBe(true);
    expect(desktop.fileSaver.writeFile).toHaveBeenCalledTimes(1);
  });

  it("reads nothing and writes nothing when the save dialog is cancelled", async () => {
    desktop.fileSaver.pickSaveLocation.mockResolvedValue(null);

    await expect(exportSupportBundle(desktop as never, {})).resolves.toBe(false);
    expect(desktop.logFiles.readAll).not.toHaveBeenCalled();
    expect(desktop.logFiles.readNative).not.toHaveBeenCalled();
    expect(desktop.fileSaver.writeFile).not.toHaveBeenCalled();
  });

  it("hands the zip to the share sheet in the Android app, with no dialog", async () => {
    desktop.shareSheet.available = true;
    try {
      await expect(exportSupportBundle(desktop as never, {})).resolves.toBe(true);
      expect(desktop.fileSaver.pickSaveLocation).not.toHaveBeenCalled();
      expect(desktop.fileSaver.writeFile).not.toHaveBeenCalled();
      const [name, bytes] = desktop.shareSheet.shareFile.mock.calls[0]! as [string, Uint8Array];
      expect(name).toMatch(/^owncord-support-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.zip$/);
      expect(bytes.length).toBeGreaterThan(0);
    } finally {
      desktop.shareSheet.available = false;
    }
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
    expect(entries.map((e) => e.name)).toContain("logs/owncord-client.log");
    expect(
      JSON.parse(text(entries.find((e) => e.name === "voice-diagnostics.json")!.data)),
    ).toEqual({ hasRoom: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("adds the share timeline passed by the caller", async () => {
    desktop.fileSaver.pickSaveLocation.mockResolvedValue("/tmp/bundle.zip");
    const timeline = { policy: "legacy", samples: [{ t: 1000 }] };

    await exportSupportBundle(desktop as never, {}, timeline);

    const [, bytes] = desktop.fileSaver.writeFile.mock.calls[0]! as [string, Uint8Array];
    const entries = readZip(bytes);
    expect(
      JSON.parse(text(entries.find((e) => e.name === "share-diagnostics.json")!.data)),
    ).toEqual(timeline);
  });
});

describe("support bundle JSON entries", () => {
  it("ends every JSON entry with a newline", () => {
    const entries = readZip(buildSupportBundle(sources({ shareDiagnostics: { samples: [] } })));
    for (const name of [
      "manifest.json",
      "redactions.json",
      "app.json",
      "settings.json",
      "voice-diagnostics.json",
      "share-diagnostics.json",
      "last-exit.json",
    ]) {
      expect(text(entries.find((e) => e.name === name)!.data).endsWith("}\n")).toBe(true);
    }
  });

  it("keeps a numeric profile field and drops a structured one", () => {
    const entries = readZip(
      buildSupportBundle(
        sources({
          profiles: [{ name: "Home", host: "h", lastConnected: 1_700_000_000, username: { a: 1 } }],
        }),
      ),
    );
    const settings = JSON.parse(text(entries.find((e) => e.name === "settings.json")!.data));
    expect(settings.profiles).toEqual([{ name: "Home", host: "h", lastConnected: 1_700_000_000 }]);
  });
});

describe("exportSupportBundle without an app version", () => {
  it("records the version as unknown", async () => {
    desktop.fileSaver.pickSaveLocation.mockResolvedValue("bundle.zip");
    desktop.appMetadata.getVersion.mockRejectedValue(new Error("unavailable"));
    desktop.logFiles.readAll.mockResolvedValue([]);
    desktop.logFiles.readNative.mockResolvedValue([]);
    desktop.settings.load.mockResolvedValue(null);
    desktop.fileSaver.writeFile.mockResolvedValue(undefined);

    await exportSupportBundle(desktop as never, {});

    const [, bytes] = desktop.fileSaver.writeFile.mock.calls.at(-1)! as [string, Uint8Array];
    const app = JSON.parse(text(readZip(bytes).find((e) => e.name === "app.json")!.data)) as {
      version: string;
    };
    expect(app.version).toBe("unknown");
  });
});

// Fake secrets and personal values in the shapes the redaction pass looks
// for, planted in every source a bundle item is made from.
const SHAPED = {
  token: "shapedtok3nPlanted9",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzaGFwZWQifQ.c2hhcGVkc2lnbmF0dXJl",
  email: "shaped.person@example.org",
  ipv4: "198.51.100.23",
  ipv6: "2001:db8:1::abcd:ef01",
  user: "shapedosuser",
  path: "/channels/shaped-room",
  kit: "QRST-UVWX-YZ23-4567-ABCD-EFGH-IJKL-MNOP",
} as const;

function shapedLine(): string {
  return [
    `token=${SHAPED.token}`,
    `mail ${SHAPED.email} from ${SHAPED.ipv4} and ${SHAPED.ipv6}`,
    `/home/${SHAPED.user}/x and C:\\Users\\${SHAPED.user}\\y`,
    `https://chat.example.org${SHAPED.path}?invite=${SHAPED.token}`,
    `kit ${SHAPED.kit}`,
    // Last: a header's value runs to the end of the line or string.
    `Authorization: Bearer ${SHAPED.jwt}`,
  ].join(" | ");
}

function plantedEverywhere(): SupportBundleSources {
  const line = shapedLine();
  return sources({
    appVersion: `1.2.3 ${line}`,
    environment: { platform: line, userAgent: line },
    logs: [
      { name: "2026-09-22.jsonl", text: `${JSON.stringify({ message: line, data: { line } })}\n` },
      {
        name: "events-2026-09-22T10-00-00-1.jsonl",
        text: `${JSON.stringify({ code: "x", line })}\n`,
      },
    ],
    nativeLogs: [
      {
        name: "owncord-client.log",
        text: `[2026-09-22][10:00:00][x][ERROR] [crash] fatal signal SIGSEGV (11) ${line}\n${line}\n`,
      },
    ],
    profiles: [{ name: line, host: line, username: line }],
    storage: storageWith({ "owncord:settings:accentColor": JSON.stringify(line) }),
    voiceDiagnostics: { line, nested: [line, { line }] },
    shareDiagnostics: { samples: [{ note: line }] },
  });
}

function manifestOf(entries: readonly ZipEntry[]): BundleManifest {
  return JSON.parse(text(entries.find((e) => e.name === "manifest.json")!.data)) as BundleManifest;
}

describe("support bundle redaction", () => {
  it("leaves no planted value in any entry, whichever source it was planted in", () => {
    const entries = readZip(buildSupportBundle(plantedEverywhere()));
    expect(entries.length).toBeGreaterThan(8);
    for (const entry of entries) {
      const body = text(entry.data);
      for (const value of Object.values(SHAPED)) {
        expect(body, `${entry.name} carries ${value}`).not.toContain(value);
      }
    }
    // A positive control: the redacted lines are still there.
    const log = text(entries.find((e) => e.name === "logs/2026-09-22.jsonl")!.data);
    expect(log).toContain("https://chat.example.org");
    expect(log).toContain("[email]");
  });

  it("keeps every JSON entry valid after redaction", () => {
    const entries = readZip(buildSupportBundle(plantedEverywhere()));
    for (const entry of entries.filter((e) => e.name.endsWith(".json"))) {
      expect(() => JSON.parse(text(entry.data)), entry.name).not.toThrow();
    }
  });

  it("reports the removals per entry and rule", () => {
    const entries = readZip(buildSupportBundle(plantedEverywhere()));
    const report = JSON.parse(text(entries.find((e) => e.name === "redactions.json")!.data)) as {
      redactions: { item: string; rule: string; count: number }[];
    };
    const items = new Set(report.redactions.map((r) => r.item));
    for (const name of [
      "app.json",
      "settings.json",
      "voice-diagnostics.json",
      "logs/owncord-client.log",
    ]) {
      expect(items).toContain(name);
    }
    expect(
      report.redactions.find((r) => r.item === "logs/2026-09-22.jsonl" && r.rule === "email")
        ?.count,
    ).toBe(2);
    const manifest = manifestOf(entries);
    const log = manifest.items.find((i) => i.name === "logs/2026-09-22.jsonl")!;
    expect(log.redactions).toBe(
      report.redactions.filter((r) => r.item === log.name).reduce((n, r) => n + r.count, 0),
    );
  });
});

describe("support bundle manifest", () => {
  it("lists every other entry with its true size and SHA-256", () => {
    const entries = readZip(buildSupportBundle(sources({ shareDiagnostics: { samples: [] } })));
    const manifest = manifestOf(entries);
    expect(manifest.format).toBe(BUNDLE_FORMAT);
    expect(manifest.report_id).toMatch(/^[0-9a-f]{16}$/);
    expect(manifest.app_version).toBe("1.2.3");
    expect(manifest.created_at).toBe("2026-09-22T12:00:00.000Z");
    expect(manifest.cap_bytes).toBe(BUNDLE_CAP_BYTES);
    expect(manifest.omitted).toEqual([]);
    const listed = manifest.items.map((i) => i.name);
    expect(listed.toSorted()).toEqual(
      entries
        .map((e) => e.name)
        .filter((n) => n !== "manifest.json")
        .toSorted(),
    );
    for (const item of manifest.items) {
      const entry = entries.find((e) => e.name === item.name)!;
      expect(item.byte_size).toBe(entry.data.length);
      expect(item.sha256).toBe(sha256Hex(entry.data));
    }
    expect(manifest.items.find((i) => i.name === "settings.json")!.data_classes).toEqual([1]);
  });

  it("gives each bundle its own report id", () => {
    const a = manifestOf(readZip(buildSupportBundle(sources())));
    const b = manifestOf(readZip(buildSupportBundle(sources())));
    expect(a.report_id).not.toBe(b.report_id);
  });

  it("writes how the last run ended into last-exit.json", () => {
    const entries = readZip(
      buildSupportBundle(
        sources({
          nativeLogs: [
            {
              name: "owncord-client.log",
              text: "[2026-09-22][09:00:00][owncord_client_lib::exception_log][ERROR] [crash] unhandled exception 0xC0000005 (access violation) in nvwgf2umx.dll+0x1A on thread 7\n",
            },
          ],
        }),
      ),
    );
    const lastExit = JSON.parse(text(entries.find((e) => e.name === "last-exit.json")!.data));
    expect(lastExit).toMatchObject({
      found: true,
      endings: 1,
      last: {
        at: "2026-09-22T09:00:00Z",
        outcome: "crash",
        kind: "exception",
        module: "nvwgf2umx.dll",
      },
    });
  });

  it("keeps the native logs newest first, as read", () => {
    const names = readZip(
      buildSupportBundle(
        sources({
          nativeLogs: [
            { name: "owncord-client.log", text: "a\n" },
            { name: "owncord-client_2026-09-21.log", text: "b\n" },
          ],
        }),
      ),
    ).map((e) => e.name);
    expect(names.slice(-2)).toEqual([
      "logs/owncord-client.log",
      "logs/owncord-client_2026-09-21.log",
    ]);
  });
});

describe("support bundle size cap", () => {
  // One line per second; the newest 30 minutes are the incident window.
  function logDay(prefix: string, lines: number, width: number): string {
    const pad = "x".repeat(width);
    return (
      Array.from(
        { length: lines },
        (_, i) => `${prefix} ${String(i).padStart(7, "0")} ${pad}`,
      ).join("\n") + "\n"
    );
  }

  it("stays under the cap and keeps the newest lines of every log whole", () => {
    const events = logDay("event", 3_000, 100);
    const bundle = buildSupportBundle(
      sources({
        logs: [
          { name: "2026-09-20.jsonl", text: logDay("old", 20_000, 200) },
          { name: "2026-09-21.jsonl", text: logDay("log", 40_000, 200) },
          { name: "events-2026-09-21T10-00-00-1.jsonl", text: events },
        ],
        nativeLogs: [{ name: "owncord-client.log", text: logDay("native", 10_000, 150) }],
      }),
    );
    expect(bundle.length).toBeLessThanOrEqual(BUNDLE_CAP_BYTES);
    const entries = readZip(bundle);
    const manifest = manifestOf(entries);
    expect(manifest.omitted.map((o) => o.name)).toEqual(["logs/2026-09-20.jsonl"]);
    // The small event file is never touched while the big log gives way.
    expect(
      text(entries.find((e) => e.name === "logs/events-2026-09-21T10-00-00-1.jsonl")!.data),
    ).toBe(events);
    const log = text(entries.find((e) => e.name === "logs/2026-09-21.jsonl")!.data);
    const lines = log.split("\n").filter((l) => l !== "");
    expect(lines.at(-1)).toMatch(/^log 0039999 x+$/);
    for (const line of lines) expect(line).toMatch(/^log \d{7} x{200}$/);
    expect(lines.length).toBeGreaterThan(1_800);
    const item = manifest.items.find((i) => i.name === "logs/2026-09-21.jsonl")!;
    expect(item.trimmed_bytes).toBeGreaterThan(0);
    expect(item.byte_size).toBe(log.length);
  }, 20_000);

  it("trims nothing when the bundle fits", () => {
    const manifest = manifestOf(readZip(buildSupportBundle(sources())));
    expect(manifest.omitted).toEqual([]);
    for (const item of manifest.items) expect(item.trimmed_bytes).toBeUndefined();
  });
});
