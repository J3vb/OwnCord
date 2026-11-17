/**
 * Local support bundle: a zip the user saves through
 * the OS dialog. Nothing is uploaded and no server is called.
 *
 * Contents are an allowlist: the persisted log files (with the diagnostic
 * event files beside them), the native log, the voice diagnostics, the
 * settings keys named in `SETTINGS_ALLOWLIST`, and the listed fields of each
 * saved server profile. Passwords and tokens live in the OS keychain, which
 * this module never reads.
 *
 * Every item made from those sources goes through `redactText` on its way into
 * the zip (`finishItems` is the one path), and the counts per rule become
 * `redactions.json`. `manifest.json` lists each item with its size, SHA-256
 * and data classes, and the whole bundle is kept under `BUNDLE_CAP_BYTES` by
 * dropping the oldest log lines first.
 *
 * Loaded lazily from the Logs tab button, so none of it is on the startup path.
 * It has no runtime import on purpose: a startup module imported from this
 * lazy chunk is split out of the entry chunk, which grows startup. So the
 * caller hands in the `desktop` registry, and the settings prefix is repeated
 * here (pinned equal to `preferences.STORAGE_PREFIX` by the unit test).
 */
import type { Platform } from "../platform/contracts";
import { settingsText } from "../i18n/settings";
import { readStored } from "./prefs/preferences";
import { findLastExit } from "./diagnostics/lastExit";
import { REDACTION_RULES, redactText, type RedactionCounts } from "./diagnostics/redact";
import { sha256Hex } from "./diagnostics/sha256";

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
  "callSounds",
  "voiceSounds",
  "soundStyle",
  "echoCancellation",
  "noiseSuppression",
  "autoGainControl",
  "enhancedNoiseSuppression",
  "softSpeech",
  "inputVolume",
  "outputVolume",
  "voiceSensitivity",
  "autoInputSensitivity",
  "pttVk",
  "inputMode",
  "pttReleaseDelayMs",
  "screenShareBackupLayer",
  "screenShareFps",
  "screenShareQuality",
  "streamQuality",
  "shareDiagnosticsV2",
  "shareMotionPolicy",
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

export interface SupportBundleSources {
  readonly appVersion: string;
  readonly logs: readonly { readonly name: string; readonly text: string }[];
  /** The Rust log files (`owncord-client*.log`), newest first, tail-capped. */
  readonly nativeLogs: readonly { readonly name: string; readonly text: string }[];
  /** The OS and webview identity the bundle records in `app.json`. */
  readonly environment: { readonly platform: string; readonly userAgent: string };
  /** Saved profiles as stored; only `PROFILE_FIELDS` are read. */
  readonly profiles: unknown;
  readonly storage: Pick<Storage, "getItem">;
  readonly voiceDiagnostics: unknown;
  /** The recorded screen-share timeline; absent or null when nothing was
   *  recorded, which leaves `share-diagnostics.json` out. */
  readonly shareDiagnostics?: unknown;
  readonly now: Date;
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

/** The bundle's format: 2 added the manifest, redaction and last exit. */
export const BUNDLE_FORMAT = 2;

/** The largest bundle written; the oldest log lines go first past it. */
export const BUNDLE_CAP_BYTES = 4 * 1024 * 1024;

/** Room kept under the cap for the manifest, the report and zip headers. */
const RESERVED_BYTES = 64 * 1024;

type Group = "logs" | "events" | "native";

interface SourceItem {
  readonly name: string;
  readonly text: string;
  /** Data-lifecycle classes the item can touch (data-lifecycle.md). */
  readonly classes: readonly number[];
  /** Log-like items that may be trimmed, oldest first within the group. */
  readonly group?: Group;
}

interface FinishedItem {
  readonly name: string;
  data: Uint8Array;
  readonly classes: readonly number[];
  readonly group?: Group;
  readonly counts: RedactionCounts;
  trimmedBytes: number;
}

export interface BundleManifestItem {
  readonly name: string;
  readonly byte_size: number;
  readonly sha256: string;
  readonly data_classes: readonly number[];
  readonly redactions: number;
  readonly trimmed_bytes?: number;
}

export interface BundleManifest {
  readonly format: number;
  readonly report_id: string;
  readonly app_version: string;
  readonly created_at: string;
  readonly cap_bytes: number;
  readonly items: readonly BundleManifestItem[];
  readonly omitted: readonly { readonly name: string; readonly byte_size: number }[];
  readonly redaction_rules: readonly string[];
}

function reportId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function total(counts: RedactionCounts): number {
  return Object.values(counts).reduce((n, c) => n + c, 0);
}

/**
 * Redact every item, then trim the log groups until the bundle fits the cap.
 * The largest group gives first, from the start of its oldest file, at a line
 * boundary (a file cut to nothing is dropped): the newest lines, where the
 * incident is, stay whole. Returns the kept items and the files dropped.
 */
function finishItems(
  items: readonly SourceItem[],
  cap: number,
): { kept: FinishedItem[]; omitted: { name: string; byte_size: number }[] } {
  const encoder = new TextEncoder();
  const kept: FinishedItem[] = items.map((item) => {
    const redacted = redactText(item.text);
    return {
      name: item.name,
      data: encoder.encode(redacted.text),
      classes: item.classes,
      ...(item.group === undefined ? {} : { group: item.group }),
      counts: redacted.counts,
      trimmedBytes: 0,
    };
  });
  const omitted: { name: string; byte_size: number }[] = [];
  const size = (): number => kept.reduce((n, item) => n + item.data.length, 0);
  let over = size() - cap;
  while (over > 0) {
    const groups = new Map<Group, FinishedItem[]>();
    for (const item of kept) {
      if (item.group === undefined || item.data.length === 0) continue;
      groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
    }
    let largest: FinishedItem[] | undefined;
    let largestBytes = 0;
    for (const members of groups.values()) {
      const bytes = members.reduce((n, item) => n + item.data.length, 0);
      if (bytes > largestBytes) {
        largest = members;
        largestBytes = bytes;
      }
    }
    if (largest === undefined) break;
    const oldest = largest[0]!;
    const newline = over >= oldest.data.length ? -1 : oldest.data.indexOf(0x0a, over - 1);
    if (newline === -1 || newline + 1 >= oldest.data.length) {
      kept.splice(kept.indexOf(oldest), 1);
      omitted.push({ name: oldest.name, byte_size: oldest.data.length });
    } else {
      oldest.trimmedBytes += newline + 1;
      oldest.data = oldest.data.slice(newline + 1);
    }
    over = size() - cap;
  }
  return { kept, omitted };
}

function text(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function describe(item: Omit<FinishedItem, "group">): BundleManifestItem {
  return {
    name: item.name,
    byte_size: item.data.length,
    sha256: sha256Hex(item.data),
    data_classes: item.classes,
    redactions: total(item.counts),
    ...(item.trimmedBytes > 0 ? { trimmed_bytes: item.trimmedBytes } : {}),
  };
}

/** Assemble the bundle's zip bytes from already-read sources. */
export function buildSupportBundle(src: SupportBundleSources): Uint8Array {
  const reversedNative = [...src.nativeLogs].toReversed();
  const items: SourceItem[] = [
    { name: "README.txt", text: settingsText("logs.bundleReadme"), classes: [] },
    {
      name: "app.json",
      text: text({
        version: src.appVersion,
        exportedAt: src.now.toISOString(),
        os: src.environment.platform,
        userAgent: src.environment.userAgent,
        serverVersion: null,
        serverVersionNote: "not collected (bundle makes no server call, decision 7)",
      }),
      classes: [],
    },
    {
      name: "settings.json",
      text: text({
        settings: allowlistedSettings(src.storage),
        profiles: allowlistedProfiles(src.profiles),
      }),
      classes: [1],
    },
    { name: "voice-diagnostics.json", text: text(src.voiceDiagnostics), classes: [] },
    ...(src.shareDiagnostics === undefined || src.shareDiagnostics === null
      ? []
      : [{ name: "share-diagnostics.json", text: text(src.shareDiagnostics), classes: [] }]),
    { name: "last-exit.json", text: text(findLastExit(src.nativeLogs)), classes: [] },
    ...src.logs.map((file): SourceItem =>
      file.name.startsWith("events-")
        ? { name: `logs/${file.name}`, text: file.text, classes: [1, 19], group: "events" }
        : { name: `logs/${file.name}`, text: file.text, classes: [1], group: "logs" },
    ),
    // Newest first as read; the trim wants the oldest first.
    ...reversedNative.map((file): SourceItem => ({
      name: `logs/${file.name}`,
      text: file.text,
      classes: [],
      group: "native",
    })),
  ];
  const { kept, omitted } = finishItems(items, BUNDLE_CAP_BYTES - RESERVED_BYTES);
  // Back in the order the sources came: native logs newest first again.
  const ordered = [
    ...kept.filter((item) => item.group !== "native"),
    ...kept.filter((item) => item.group === "native").toReversed(),
  ];

  const redactions = ordered.flatMap((item) =>
    REDACTION_RULES.filter((rule) => (item.counts[rule] ?? 0) > 0).map((rule) => ({
      item: item.name,
      rule,
      count: item.counts[rule]!,
    })),
  );
  const report = new TextEncoder().encode(text({ redactions }));
  const manifest: BundleManifest = {
    format: BUNDLE_FORMAT,
    report_id: reportId(),
    app_version: redactText(src.appVersion).text,
    created_at: src.now.toISOString(),
    cap_bytes: BUNDLE_CAP_BYTES,
    items: [
      describe({ name: "redactions.json", data: report, classes: [], counts: {}, trimmedBytes: 0 }),
      ...ordered.map(describe),
    ],
    omitted,
    redaction_rules: REDACTION_RULES,
  };
  const [readme, ...rest] = ordered;
  return zipStore(
    [
      { name: readme!.name, data: readme!.data },
      { name: "manifest.json", data: new TextEncoder().encode(text(manifest)) },
      { name: "redactions.json", data: report },
      ...rest.map((item) => ({ name: item.name, data: item.data })),
    ],
    src.now,
  );
}

/**
 * Ask where to save, then read the sources and write the bundle there. Where
 * the host has a share sheet (the Android app) the bundle goes to it instead,
 * so the user sends it straight to mail or Drive.
 * Resolves false when the user cancels the dialog; nothing is read then.
 */
export async function exportSupportBundle(
  desktop: Pick<Platform, "fileSaver" | "appMetadata" | "logFiles" | "settings" | "shareSheet">,
  voiceDiagnostics: unknown,
  shareDiagnostics?: unknown,
): Promise<boolean> {
  const now = new Date();
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const name = `owncord-support-${stamp}.zip`;
  const share = desktop.shareSheet.available;
  const path = share ? null : await desktop.fileSaver.pickSaveLocation(name);
  if (!share && path === null) return false;
  const [appVersion, logs, nativeLogs, snapshot] = await Promise.all([
    desktop.appMetadata.getVersion().catch(() => "unknown"),
    desktop.logFiles.readAll(),
    desktop.logFiles.readNative(),
    desktop.settings.load(),
  ]);
  const bundle = buildSupportBundle({
    appVersion,
    logs,
    nativeLogs,
    environment: {
      platform: navigator.platform,
      userAgent: navigator.userAgent,
    },
    profiles: snapshot?.profiles,
    storage: { getItem: readStored },
    voiceDiagnostics,
    shareDiagnostics,
    now,
  });
  if (path === null) await desktop.shareSheet.shareFile(name, bundle);
  else await desktop.fileSaver.writeFile(path, bundle);
  return true;
}
