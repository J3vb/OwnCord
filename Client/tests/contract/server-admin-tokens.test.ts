// CONTRACT TEST. The artifact under test is owned by Server/admin; the runner
// lives here because placement follows capability, not ownership — the Go
// module carries no JavaScript engine (see docs/contributing.md#testing).
//
// AO-1 (admin UI overhaul) hand-copies the client's Refined Neon (neon-glow)
// token values into Server/admin/static/admin.css's :root. There is no build
// step and no generated file to keep the two in step, so this test is the tie:
// every admin token that mirrors a client token must resolve to the same value
// as Client/src/styles/tokens.css overridden by theme-neon-glow.css. Change
// either side and this fails.
//
// Both sides go through a real CSS cascade (JSDOM, scripts off) and are read
// back as computed custom properties, so a later overriding rule, a matching
// media query or a commented-out block changes what the test sees.
import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { adminPanelHtml } from "../helpers/admin-panel";
import { readFileSync } from "node:fs";
import path from "node:path";

const CLIENT = path.resolve(__dirname, "../../src/styles");
const adminWindow = new JSDOM(adminPanelHtml()).window;
const adminStyle = adminWindow.getComputedStyle(adminWindow.document.documentElement);

const clientWindow = new JSDOM(
  "<!doctype html><html><head>" +
    `<style>${readFileSync(path.join(CLIENT, "tokens.css"), "utf8")}</style>` +
    `<style>${readFileSync(path.join(CLIENT, "theme-neon-glow.css"), "utf8")}</style>` +
    '</head><body class="theme-neon-glow"></body></html>',
).window;
const clientStyle = clientWindow.getComputedStyle(clientWindow.document.body);

/** Computed `name`, with a whole-value `var(--x)` resolved (JSDOM leaves those as written). */
function computed(style: CSSStyleDeclaration, name: string): string {
  const raw = style.getPropertyValue(name).trim();
  const reference = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(raw);
  return reference === null ? raw : computed(style, reference[1]!);
}

function adminValue(name: string): string {
  return computed(adminStyle, name);
}

function clientValue(name: string): string {
  const value = computed(clientStyle, name);
  if (value === "") throw new Error(`client has no token ${name}`);
  return value;
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

describe("Server/admin/static — Refined Neon tokens equal the client's (AO-1)", () => {
  it.each(MIRRORED)("%s equals the client's %s", (adminName, clientName) => {
    const actual = adminValue(adminName);
    expect(actual, `admin ${adminName} is missing from :root`).not.toBe("");
    expect(normalise(actual)).toBe(normalise(clientValue(clientName)));
  });

  it("maps the admin-only aliases onto the client tokens they stand for", () => {
    // --bg-card is the client's --bg-secondary; --bg-table-hover is --bg-hover.
    expect(normalise(adminValue("--bg-card"))).toBe(normalise(clientValue("--bg-secondary")));
    expect(normalise(adminValue("--bg-table-hover"))).toBe(normalise(clientValue("--bg-hover")));
    // --accent-glow is a 15% tint of --accent.
    const accent = normalise(clientValue("--accent"));
    const rgb = [1, 3, 5].map((i) => parseInt(accent.slice(i, i + 2), 16)).join(",");
    expect(normalise(adminValue("--accent-glow"))).toBe(`rgba(${rgb},0.15)`);
  });
});
