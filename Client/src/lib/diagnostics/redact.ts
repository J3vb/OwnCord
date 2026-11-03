// The support bundle's redaction pass. Every text item in the bundle (log
// files, the native log, the event files, the JSON items) goes through
// redactText before it is zipped, and the per-rule counts become the bundle's
// redaction report. Pure functions: no state, no I/O.
//
// The rules look for shapes, not for known values: a value in a key=value or
// "key":"value" pair whose name says it is secret, bearer and JWT tokens,
// auth and cookie headers, recovery secrets, long hex tokens, URLs (cut to
// scheme and host), email and IP addresses, and home folders (written as ~).
// Each also matches the JSON-escaped and URL-encoded forms a log line can
// hold. Text that has no shape, such as a message someone typed, cannot be
// found this way; the logger and the event log are what keep it out.

export const REDACTION_RULES = [
  "url",
  "auth_header",
  "bearer",
  "jwt",
  "secret_pair",
  "recovery_secret",
  "long_hex",
  "email",
  "home_path",
  "ipv4",
  "ipv6",
] as const;

export type RedactionRule = (typeof REDACTION_RULES)[number];

export type RedactionCounts = Partial<Record<RedactionRule, number>>;

export interface Redacted {
  readonly text: string;
  readonly counts: RedactionCounts;
}

const MASK = "[redacted]";

// Hosts that serve the app's own files: their paths are chunk names in stack
// traces and hold nothing about the user, so only the query goes.
const APP_ASSET_HOST = /^(?:localhost|tauri\.localhost|ipc\.localhost|asset\.localhost)(?::\d+)?$/i;

const IPV4_TEXT =
  "(?:(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4_ONLY = new RegExp(`^${IPV4_TEXT}$`);
const LOOPBACK_V4 = /^(?:127\.\d+\.\d+\.\d+|0\.0\.0\.0)$/;

// scheme, then :// with each slash optionally JSON-escaped, the authority,
// then the rest; the rest stops at a backslash unless it escapes a slash, so
// an escaped closing quote stays in place.
const URL_RE =
  /\b([a-z][a-z0-9+.-]{1,15}):((?:\\{0,3}\/){2})([^\s"'<>\\/?#]*)((?:(?:[/?#]|\\\/)(?:[^\s"'<>\\]|\\\/)*)?)/gi;

const AUTH_HEADER_RE =
  /\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key)(\\{0,3}["']?\s*:\s*\\{0,3}["']?)(?!\[redacted\])([^\r\n"'\\]+)/gi;

const BEARER_RE = /\b(bearer|basic)((?:\s|\\[nrt])+)(?!\[redacted\])([A-Za-z0-9._~+/=-]{8,})/gi;

const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;

// A name ending in one of the secret words, a separator (: or =, also as
// \u003d or %3D, with optional escaped quotes), then a quoted or bare value.
const SECRET_NAME =
  "[A-Za-z0-9_.-]*?(?:token|tokens|password|passwd|passphrase|pwd|secret|key|apikey|sessionid|session_id|cookie|invite|invitecode|invite_code|credential|credentials|otp|totp)";
const SECRET_PAIR_RE = new RegExp(
  `\\b(${SECRET_NAME})((?:\\\\{0,3}["'])?\\s*(?::|=|\\\\u003[dD]|%3[dD])\\s*(?:\\\\{0,3}["'])?)` +
    `(?:((?<=["'])[^"'\\r\\n]*?)(?=\\\\{0,3}["'])|([^\\s"'\\\\&,;{}\\[\\]<>]+))`,
  "gi",
);
const NOT_SECRET_VALUE = /^(?:true|false|null|undefined|none|\[redacted\]|\[jwt\]|\[hex\])$/i;

// A recovery kit secret (base32 in groups of four) or a recovery code
// (two groups of five from the code alphabet).
const RECOVERY_RE =
  /\b(?:[A-Z2-7]{4}(?:-[A-Z2-7]{4}){5,7}|[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5})\b/g;

// A session token is 64 hex characters; a git commit (40) stays readable.
const LONG_HEX_RE = /\b[0-9a-fA-F]{48,}\b/g;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;

const HOME_RE =
  /(?:(?:\/var)?\/home|\/Users)\/[^/\s"'\\:]+|\b[A-Za-z]:(?:\\{1,4}|\/)(?:Users|Documents and Settings)(?:\\{1,4}|\/)[^\\/\s"':]+/gi;

// Not after a slash, word character or dot, so "Chrome/130.0.0.0" and longer
// dotted version numbers stay.
const IPV4_RE = new RegExp(`(?<![\\w./-])${IPV4_TEXT}(?![\\w]|\\.\\d)`, "g");

const IPV6_CANDIDATE_RE = /(?<![\w:.])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![\w:.])/g;

function isIpv6(candidate: string): boolean {
  if (!/[0-9A-Fa-f]/.test(candidate)) return false;
  if (candidate === "::1") return false;
  const colons = candidate.split(":").length - 1;
  return candidate.includes("::") || colons >= 5;
}

function hostOnly(authority: string): string {
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  const bare = host.replace(/:\d+$/, "");
  if (IPV4_ONLY.test(bare) && !LOOPBACK_V4.test(bare)) return host.replace(bare, "[ip]");
  if (bare.startsWith("[") && bare !== "[::1]") return host.replace(bare, "[ip]");
  return host;
}

type Counter = (rule: RedactionRule) => void;

function redactUrls(text: string, count: Counter): string {
  return text.replace(
    URL_RE,
    (match, scheme: string, slashes: string, authority: string, rest: string) => {
      const host = hostOnly(authority);
      let kept = rest;
      if (rest !== "") {
        kept = APP_ASSET_HOST.test(host) ? rest.replace(/[?#].*$/, "") : "";
      }
      const out = `${scheme}:${slashes}${host}${kept}`;
      if (out !== match) count("url");
      return out;
    },
  );
}

function replaceAll(
  text: string,
  re: RegExp,
  rule: RedactionRule,
  count: Counter,
  mask: string,
): string {
  return text.replace(re, () => {
    count(rule);
    return mask;
  });
}

/** Strip every shape the rules know from `text`, counting each hit by rule. */
export function redactText(input: string): Redacted {
  const counts: Record<string, number> = {};
  const count: Counter = (rule) => {
    counts[rule] = (counts[rule] ?? 0) + 1;
  };
  let text = redactUrls(input, count);
  text = text.replace(AUTH_HEADER_RE, (_m, name: string, sep: string) => {
    count("auth_header");
    return `${name}${sep}${MASK}`;
  });
  text = text.replace(BEARER_RE, (_m, scheme: string, gap: string) => {
    count("bearer");
    return `${scheme}${gap}${MASK}`;
  });
  text = replaceAll(text, JWT_RE, "jwt", count, "[jwt]");
  text = text.replace(
    SECRET_PAIR_RE,
    (match, name: string, sep: string, quoted: string | undefined, bare: string | undefined) => {
      const value = quoted ?? bare ?? "";
      if (value === "" || NOT_SECRET_VALUE.test(value)) return match;
      count("secret_pair");
      return `${name}${sep}${MASK}`;
    },
  );
  text = replaceAll(text, RECOVERY_RE, "recovery_secret", count, MASK);
  text = replaceAll(text, LONG_HEX_RE, "long_hex", count, "[hex]");
  text = replaceAll(text, EMAIL_RE, "email", count, "[email]");
  text = replaceAll(text, HOME_RE, "home_path", count, "~");
  text = text.replace(IPV4_RE, (ip) => {
    if (LOOPBACK_V4.test(ip)) return ip;
    count("ipv4");
    return "[ip]";
  });
  text = text.replace(IPV6_CANDIDATE_RE, (candidate) => {
    if (!isIpv6(candidate)) return candidate;
    count("ipv6");
    return "[ip]";
  });
  return { text, counts };
}

/** Sum two count records. */
export function addCounts(a: RedactionCounts, b: RedactionCounts): RedactionCounts {
  const out: Record<string, number> = { ...a };
  for (const [rule, n] of Object.entries(b)) out[rule] = (out[rule] ?? 0) + n;
  return out;
}
