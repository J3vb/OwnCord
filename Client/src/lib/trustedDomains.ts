/**
 * Domains the viewer chose to stop being warned about when following a masked
 * link (`[label](url)`). Client-side only, in localStorage: a trust decision is
 * the viewer's own and never reaches the server. Storage can be missing,
 * blocked or hold anything, so every read and write is guarded and a bad
 * value reads as "no trusted domains".
 */

// i18n-exempt: localStorage key, not display text
const KEY = "owncord:trustedLinkDomains";

/** Oldest entries are dropped past this, so the list cannot grow without bound. */
export const MAX_TRUSTED_DOMAINS = 200;

/** The comparable form of a URL's host, or null when `url` is not an http(s) URL. */
export function linkDomain(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
    return host === "" ? null : host;
  } catch {
    return null;
  }
}

function read(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((d): d is string => typeof d === "string" && d !== "");
  } catch {
    return [];
  }
}

/** Whether the viewer asked to open links to `domain` without the warning. */
export function isDomainTrusted(domain: string): boolean {
  return read().includes(domain.toLowerCase());
}

/** Remember `domain`; the list keeps only the newest {@link MAX_TRUSTED_DOMAINS}. */
export function trustDomain(domain: string): void {
  const normalized = domain.toLowerCase();
  if (normalized === "") return;
  const next = read().filter((d) => d !== normalized);
  next.push(normalized);
  try {
    localStorage.setItem(KEY, JSON.stringify(next.slice(-MAX_TRUSTED_DOMAINS)));
  } catch {
    // Storage full or blocked: the warning simply shows again next time.
  }
}
