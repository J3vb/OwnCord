/**
 * A file name fit to pre-fill a save dialog, from a name a server sent. The
 * same rule as the server's upload name cleaner (Server/api/upload_handler.go),
 * so a name it stored passes through unchanged in the usual case: the part
 * after the last `/` or `\`, without control or format characters (format
 * covers the bidi overrides and isolates, which can make a name show a
 * different extension). On top of that, leading dots and spaces go (no hidden
 * or dot-only names), the characters Windows refuses in a name become `_`,
 * and a long name is cut to MAX_FILE_NAME_UNITS keeping its extension.
 */

export const MAX_FILE_NAME_UNITS = 180;
/** The name used when nothing of the given one is left. */
export const FALLBACK_FILE_NAME = "file";
/** The longest tail kept as an extension when a long name is cut. */
const MAX_EXTENSION_UNITS = 16;

const DROPPED = /[\p{Cc}\p{Cf}]/gu;
const WINDOWS_RESERVED = /[<>:"|?*]/g;

/** `text` cut to at most `units` UTF-16 units, never splitting a surrogate pair. */
function cutUnits(text: string, units: number): string {
  if (text.length <= units) return text;
  const last = text.charCodeAt(units - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? units - 1 : units);
}

function capLength(name: string): string {
  if (name.length <= MAX_FILE_NAME_UNITS) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot) : "";
  if (ext.length === 0 || ext.length > MAX_EXTENSION_UNITS) {
    return cutUnits(name, MAX_FILE_NAME_UNITS);
  }
  return cutUnits(name.slice(0, dot), MAX_FILE_NAME_UNITS - ext.length) + ext;
}

/** `name` made safe to suggest in a save dialog; FALLBACK_FILE_NAME when nothing is left. */
export function cleanFileName(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  const cleaned = base
    .replace(DROPPED, "")
    .replace(WINDOWS_RESERVED, "_")
    .replace(/^[\s.]+/u, "")
    .replace(/[\s.]+$/u, "");
  const capped = capLength(cleaned).replace(/[\s.]+$/u, "");
  return capped === "" ? FALLBACK_FILE_NAME : capped;
}
