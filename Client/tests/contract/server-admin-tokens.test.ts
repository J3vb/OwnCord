// CONTRACT TEST. The artifact under test is owned by Server/admin; the runner
// lives here because placement follows capability, not ownership — the Go
// module carries no JavaScript engine (see docs/contributing.md#testing).
//
// AO-1 (admin UI overhaul) hand-copies the client's Refined Neon (neon-glow)
// token values into Server/admin/static/index.html's :root. There is no build
// step and no generated file to keep the two in step, so this test is the tie:
// every admin token that mirrors a client token must resolve to the same value
// as Client/src/styles/tokens.css overridden by theme-neon-glow.css. Change
// either side and this fails.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const CLIENT = path.resolve(__dirname, "../../src/styles");
const ADMIN_HTML_PATH = path.resolve(__dirname, "../../../Server/admin/static/index.html");
const ADMIN_HTML_SOURCE = readFileSync(ADMIN_HTML_PATH, "utf8");

/** Parse `selector { ... }` custom-property declarations into a name→value map. */
function parseDeclarations(css: string, selector: RegExp): Map<string, string> {
  const block = selector.exec(css);
  if (block === null) throw new Error(`selector ${selector} not found`);
  const out = new Map<string, string>();
  const re = /--([a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block[1] ?? "")) !== null) {
    out.set(`--${m[1]!.toLowerCase()}`, m[2]!.trim());
  }
  return out;
}

const TOKENS_CSS = readFileSync(path.join(CLIENT, "tokens.css"), "utf8");
const NEON_CSS = readFileSync(path.join(CLIENT, "theme-neon-glow.css"), "utf8");

const base = parseDeclarations(TOKENS_CSS, /:root\s*\{([\s\S]*?)\n\}/);
const neon = parseDeclarations(NEON_CSS, /body\.theme-neon-glow\s*\{([\s\S]*?)\n\}/);

/**
 * The client value for `name` under neon-glow: the theme override, else the
 * tokens.css default, with one level of `var(--x)` resolved.
 */
function clientValue(name: string): string {
  const raw = neon.get(name) ?? base.get(name);
  if (raw === undefined) throw new Error(`client has no token ${name}`);
  const reference = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(raw);
  if (reference !== null) {
    const inner = reference[1]!.toLowerCase();
    const value = neon.get(inner) ?? base.get(inner);
    if (value === undefined) throw new Error(`client token ${name} references unknown ${inner}`);
    return value;
  }
  return raw;
}

/** Normalise so #fff/#ffffff and .08/0.08 compare equal. */
function normalise(value: string): string {
  const v = value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/(^|[^\d])\.(\d)/g, (_all, prefix: string, digit: string) => `${prefix}0.${digit}`);
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (short !== null) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return v;
}

const admin = parseDeclarations(ADMIN_HTML_SOURCE, /:root\s*\{([\s\S]*?)\n\s*\}/);
if (admin.size === 0) {
  throw new Error("admin :root token block not found in static/index.html");
}

// Admin token → client token it must equal.
const MIRRORED: ReadonlyArray<readonly [string, string]> = [
  ["--bg-tertiary", "--bg-tertiary"],
  ["--bg-secondary", "--bg-secondary"],
  ["--bg-primary", "--bg-primary"],
  ["--bg-input", "--bg-input"],
  ["--bg-hover", "--bg-hover"],
  ["--bg-active", "--bg-active"],
  ["--bg-overlay", "--bg-overlay"],
  ["--accent", "--accent"],
  ["--accent-hover", "--accent-hover"],
  ["--accent-active", "--accent-active"],
  ["--on-accent", "--on-accent"],
  ["--accent-text", "--accent-text"],
  ["--focus-ring", "--focus-ring"],
  ["--accent-secondary", "--accent-secondary"],
  ["--border", "--border"],
  ["--border-strong", "--border-strong"],
  ["--border-control", "--border-control"],
  ["--text-normal", "--text-normal"],
  ["--text-muted", "--text-muted"],
  ["--header-primary", "--header-primary"],
  ["--text-positive", "--text-positive"],
  ["--text-warning", "--text-warning"],
  ["--text-danger", "--text-danger"],
  ["--text-link", "--text-link"],
  ["--text-faint", "--text-faint"],
  ["--green", "--green"],
  ["--yellow", "--yellow"],
  ["--red", "--red"],
  ["--danger-fill", "--danger-fill"],
  ["--danger-fill-hover", "--danger-fill-hover"],
  ["--on-fill", "--on-fill"],
  ["--on-warning", "--on-warning"],
  ["--radius-sm", "--radius-sm"],
  ["--radius-md", "--radius-md"],
  ["--radius-lg", "--radius-lg"],
  ["--radius-pill", "--radius-pill"],
  ["--font-body", "--font-body"],
  ["--font-mono", "--font-mono"],
  ["--role-owner", "--role-owner"],
  ["--role-admin", "--role-admin"],
  ["--role-mod", "--role-mod"],
  ["--role-member", "--role-member"],
];

describe("Server/admin/static/index.html — Refined Neon tokens equal the client's (AO-1)", () => {
  it.each(MIRRORED)("%s equals the client's %s", (adminName, clientName) => {
    const actual = admin.get(adminName);
    expect(actual, `admin ${adminName} is missing from :root`).toBeDefined();
    expect(normalise(actual!)).toBe(normalise(clientValue(clientName)));
  });

  it("maps the admin-only aliases onto the client tokens they stand for", () => {
    // --bg-card is the client's --bg-secondary; --bg-table-hover is --bg-hover.
    expect(admin.get("--bg-card")?.replace(/\s+/g, "")).toBe("var(--bg-secondary)");
    expect(admin.get("--bg-table-hover")?.replace(/\s+/g, "")).toBe("var(--bg-hover)");
    // --accent-glow is a 15% tint of --accent.
    const accent = normalise(clientValue("--accent"));
    const rgb = [1, 3, 5].map((i) => parseInt(accent.slice(i, i + 2), 16)).join(",");
    expect(admin.get("--accent-glow")?.replace(/\s+/g, "")).toBe(`rgba(${rgb},.15)`);
  });
});
