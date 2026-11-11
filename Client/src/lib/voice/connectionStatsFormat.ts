// Byte and rate formatting for the voice widget stats pane. Split from
// connectionStats.ts, which re-exports these names.

/**
 * Format a byte count as `B` / `<kiloUnit>` / `MB`, switching units at
 * `base` and `base * base`. Shared by `formatBytes` here (base-1000, "kB")
 * and `formatFileSize` in features/messaging/content/attachments.ts
 * (base-1024, "KB") — those two disagreed on both the base and the unit
 * case before this was unified, so keep each call site's own `base`/
 * `kiloUnit`/`decimals` rather than picking one for both.
 */
export function formatByteSize(
  bytes: number,
  base: number,
  kiloUnit: string,
  decimals: number,
): string {
  if (bytes < base) return `${Math.round(bytes)} B`;
  if (bytes < base * base) return `${(bytes / base).toFixed(decimals)} ${kiloUnit}`;
  return `${(bytes / (base * base)).toFixed(decimals)} MB`;
}

export function formatBytes(bytes: number): string {
  return formatByteSize(bytes, 1000, "kB", 2);
}

/**
 * Compact transfer rate for the voice widget's stats pane: one unit, a
 * rounded value and no second Mbps figure, so a value never wraps at the
 * widget's narrow width (`331 kB/s`, not `331.25 kB/s (2.6 Mbps)`).
 */
export function formatRateCompact(bytesPerSec: number): string {
  const bytes = Math.max(0, bytesPerSec);
  if (Math.round(bytes) < 1000) return `${Math.round(bytes)} B/s`;
  const kb = bytes / 1000;
  if (Number(kb.toFixed(1)) < 100) return `${kb.toFixed(1)} kB/s`;
  if (Math.round(kb) < 1000) return `${Math.round(kb)} kB/s`;
  const mb = bytes / 1_000_000;
  return `${Number(mb.toFixed(1)) < 10 ? mb.toFixed(1) : mb.toFixed(0)} MB/s`;
}
