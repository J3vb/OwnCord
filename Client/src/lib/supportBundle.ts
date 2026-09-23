/**
 * Local support bundle (B7-15c, PRD decision 7): a zip the user saves through
 * the OS dialog. Nothing is uploaded and no server is called.
 *
 * Contents are an allowlist: the persisted log files, the voice diagnostics,
 * the settings keys named in `SETTINGS_ALLOWLIST`, and the listed fields of
 * each saved server profile. Passwords and tokens live in the OS keychain,
 * which this module never reads. Log lines are copied verbatim — the logger
 * does not redact — and both the bundle's README and the Logs tab say so.
 *
 * Loaded lazily from the Logs tab button, so none of it is on the startup path.
 * It has no runtime import on purpose: a startup module imported from this
 * lazy chunk is split out of the entry chunk, which grows startup. So the
 * caller hands in the `desktop` registry, and the settings prefix is repeated
 * here (pinned equal to `preferences.STORAGE_PREFIX` by the unit test).
 */
import type { Platform } from "../platform/contracts";
import { settingsText } from "../i18n/settings";

export const SETTINGS_PREFIX = "owncord:settings:";

export interface BundleEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

// ---------------------------------------------------------------------------
// Store-only zip writer
// ---------------------------------------------------------------------------

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

/** CRC-32 (IEEE), the checksum every zip entry carries. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Little-endian fields, each `[value, byteWidth]`. */
function le(...fields: [number, 2 | 4][]): Uint8Array {
  const out = new Uint8Array(fields.reduce((n, [, width]) => n + width, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const [value, width] of fields) {
    if (width === 2) view.setUint16(at, value, true);
    else view.setUint32(at, value, true);
    at += width;
  }
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Zip `entries` without compression: a local header plus the bytes per entry,
 * then the central directory and its end record. Names are flagged UTF-8.
 * ponytail: no zip64, so the archive must stay under 4 GiB and 65,535
 * entries; five rotated log days are far below either.
 */
export function zipStore(entries: readonly BundleEntry[], date: Date): Uint8Array {
  const encoder = new TextEncoder();
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const size = entry.data.length;
    // Version needed through extra-field length: identical in both records.
    const shared: [number, 2 | 4][] = [
      [20, 2],
      [0x0800, 2],
      [0, 2],
      [time, 2],
      [day, 2],
      [crc32(entry.data), 4],
      [size, 4],
      [size, 4],
      [name.length, 2],
      [0, 2],
    ];
    const local = concat([le([0x04034b50, 4], ...shared), name, entry.data]);
    centrals.push(
      concat([
        le([0x02014b50, 4], [20, 2], ...shared, [0, 2], [0, 2], [0, 2], [0, 4], [offset, 4]),
        name,
      ]),
    );
    locals.push(local);
    offset += local.length;
  }
  const directory = concat(centrals);
  const end = le(
    [0x06054b50, 4],
    [0, 2],
    [0, 2],
    [entries.length, 2],
    [entries.length, 2],
    [directory.length, 4],
    [offset, 4],
    [0, 2],
  );
  return concat([...locals, directory, end]);
}

// ---------------------------------------------------------------------------
// Bundle contents
// ---------------------------------------------------------------------------

/**
 * The `owncord:settings:` keys copied into the bundle. An allowlist, never a
 * denylist: a key that is not named here stays on the machine whatever it
 * holds. Device ids and the custom status text are left out on purpose.
 */
const SETTINGS_ALLOWLIST = [
  "accentColor",
  "compactMode",
  "fontSize",
  "reducedMotion",
  "highContrast",
  "roleColors",
  "syncOsMotion",
  "largeFont",
  "showLinkPreviews",
  "showEmbeds",
  "inlineMedia",
  "animateGifs",
  "desktopNotifications",
  "flashTaskbar",
  "suppressEveryone",
  "notificationSounds",
  "echoCancellation",
  "noiseSuppression",
  "autoGainControl",
  "enhancedNoiseSuppression",
  "inputVolume",
  "outputVolume",
  "voiceSensitivity",
  "pttVk",
  "screenShareFps",
  "streamQuality",
  "developerMode",
  "logs_min_level",
] as const;

/** The saved-profile fields copied into the bundle (no id, no colour). */
const PROFILE_FIELDS = [
  "name",
  "host",
  "username",
  "autoConnect",
  "rememberPassword",
  "lastConnected",
] as const;

const README = settingsText("logs.bundleReadme");

export interface SupportBundleSources {
  readonly appVersion: string;
  readonly logs: readonly { readonly name: string; readonly text: string }[];
  /** Saved profiles as stored; only `PROFILE_FIELDS` are read. */
  readonly profiles: unknown;
  readonly storage: Pick<Storage, "getItem">;
  readonly voiceDiagnostics: unknown;
  readonly now: Date;
}

function json(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value, null, 2) + "\n");
}

function allowlistedSettings(storage: Pick<Storage, "getItem">): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SETTINGS_ALLOWLIST) {
    const raw = storage.getItem(SETTINGS_PREFIX + key);
    if (raw === null) continue;
    try {
      out[key] = JSON.parse(raw);
    } catch {
      out[key] = "(unreadable)";
    }
  }
  return out;
}

function allowlistedProfiles(profiles: unknown): Record<string, unknown>[] {
  if (!Array.isArray(profiles)) return [];
  return profiles.map((profile: unknown) => {
    const out: Record<string, unknown> = {};
    for (const field of PROFILE_FIELDS) {
      const value = (profile as Record<string, unknown> | null)?.[field];
      if (["string", "number", "boolean"].includes(typeof value) || value === null) {
        out[field] = value;
      }
    }
    return out;
  });
}

/** Assemble the bundle's zip bytes from already-read sources. */
export function buildSupportBundle(src: SupportBundleSources): Uint8Array {
  const encoder = new TextEncoder();
  return zipStore(
    [
      { name: "README.txt", data: encoder.encode(README) },
      {
        name: "app.json",
        data: json({ version: src.appVersion, exportedAt: src.now.toISOString() }),
      },
      {
        name: "settings.json",
        data: json({
          settings: allowlistedSettings(src.storage),
          profiles: allowlistedProfiles(src.profiles),
        }),
      },
      { name: "voice-diagnostics.json", data: json(src.voiceDiagnostics) },
      ...src.logs.map((file) => ({ name: `logs/${file.name}`, data: encoder.encode(file.text) })),
    ],
    src.now,
  );
}

/**
 * Ask where to save, then read the sources and write the bundle there.
 * Resolves false when the user cancels the dialog; nothing is read then.
 */
export async function exportSupportBundle(
  desktop: Pick<Platform, "fileSaver" | "appMetadata" | "logFiles" | "settings">,
  voiceDiagnostics: unknown,
): Promise<boolean> {
  const now = new Date();
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const path = await desktop.fileSaver.pickSaveLocation(`owncord-support-${stamp}.zip`);
  if (path === null) return false;
  const [appVersion, logs, snapshot] = await Promise.all([
    desktop.appMetadata.getVersion(),
    desktop.logFiles.readAll(),
    desktop.settings.load(),
  ]);
  const bundle = buildSupportBundle({
    appVersion,
    logs,
    profiles: snapshot?.profiles,
    storage: localStorage,
    voiceDiagnostics,
    now,
  });
  await desktop.fileSaver.writeFile(path, bundle);
  return true;
}
