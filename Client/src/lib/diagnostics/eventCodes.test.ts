import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CAMERA_STALL_THRESHOLD_MS,
  EVENT_AREAS,
  EVENT_CODES,
  EVENT_LOG_CAPS,
  FIELD_PATTERNS,
  FIELD_TYPES,
  type EventArea,
  type EventCode,
  type EventCodeSpec,
  type FieldSpec,
} from "./eventCodes";
import { STALL_THRESHOLD_MS } from "../voice/cameraStallWatchdog";
import { repoRoot } from "../../../tests/helpers/repoRoot";

// Codes in the catalogue whose emitter is not built yet. Each is removed from
// this list when its owner starts recording it; the test below fails if a code
// here gains an emitter, or a code not here has none.
const NOT_EMITTED_YET = new Set<EventCode>([]);

const clientRoot = process.cwd();
const entries = Object.entries(EVENT_CODES) as [EventCode, EventCodeSpec][];

// Field names that suggest a value which could hold a person's name, a
// secret, message content or a full address. A field named like this is
// rejected whatever its type.
const FORBIDDEN_NAME_PARTS = new Set([
  "label",
  "name",
  "username",
  "nickname",
  "title",
  "url",
  "uri",
  "path",
  "file",
  "filename",
  "query",
  "email",
  "mail",
  "ip",
  "addr",
  "address",
  "candidate",
  "token",
  "secret",
  "key",
  "password",
  "pwd",
  "cookie",
  "authorization",
  "auth",
  "text",
  "message",
  "content",
  "body",
  "invite",
]);

function serverCodes(): Set<string> {
  const dir = join(repoRoot, "Server", "admin");
  const files = readdirSync(dir).filter(
    (f) =>
      (f.startsWith("support_event_codes") || f === "support_redaction.go") &&
      !f.endsWith("_test.go"),
  );
  const codes = new Set<string>(["log_event"]);
  for (const file of files) {
    const source = readFileSync(join(dir, file), "utf8");
    for (const match of source.matchAll(/":\s*"([a-z0-9_]+)",/g)) {
      codes.add(match[1] as string);
    }
  }
  return codes;
}

function fieldProblems(spec: FieldSpec): string | null {
  if (!FIELD_TYPES.includes(spec.type)) return `unknown type ${String(spec.type)}`;
  if (spec.type !== "enum") return null;
  if (spec.values.length === 0) return "enum has no values";
  const bad = spec.values.find((v) => !/^[a-z0-9_]{1,32}$/.test(v));
  return bad === undefined ? null : `enum value "${bad}" is not a short snake_case word`;
}

describe("client diagnostic event catalogue", () => {
  it("has codes", () => {
    expect(entries.length).toBeGreaterThan(30);
  });

  it("names every code area.event in a known area", () => {
    for (const [code] of entries) {
      expect(code, code).toMatch(/^[a-z]+\.[a-z][a-z_]*$/);
      const area = code.split(".")[0] as EventArea;
      expect(EVENT_AREAS, code).toContain(area);
    }
  });

  it("gives every code a plain label, an owner and a field allowlist", () => {
    for (const [code, spec] of entries) {
      expect(spec.label.trim().length, code).toBeGreaterThan(3);
      expect(spec.label.length, code).toBeLessThanOrEqual(60);
      expect(spec.owners.length, code).toBeGreaterThan(0);
      expect(spec.fields, code).toBeTypeOf("object");
    }
  });

  it("points every owner at a file that exists", () => {
    for (const [code, spec] of entries) {
      for (const owner of spec.owners) {
        // The event log itself is added with the recorder.
        if (owner.startsWith("src/lib/diagnostics/")) continue;
        expect(existsSync(join(clientRoot, owner)), `${code} owner ${owner}`).toBe(true);
      }
    }
  });

  it("allows only typed fields with snake_case names", () => {
    for (const [code, spec] of entries) {
      for (const [field, fieldSpec] of Object.entries(spec.fields)) {
        expect(field, `${code}.${field}`).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
        expect(fieldProblems(fieldSpec), `${code}.${field}`).toBeNull();
      }
    }
  });

  it("rejects a field that could hold a name, secret, content or address", () => {
    for (const [code, spec] of entries) {
      for (const field of Object.keys(spec.fields)) {
        const hit = field.split("_").find((part) => FORBIDDEN_NAME_PARTS.has(part));
        expect(hit, `${code}.${field}`).toBeUndefined();
      }
    }
  });

  it("has no free-text field type", () => {
    expect(FIELD_TYPES).not.toContain("string");
    expect(FIELD_TYPES).not.toContain("text");
  });

  it("marks the privacy class of every pseudonym", () => {
    for (const [code, spec] of entries) {
      const classes = spec.dataClasses as readonly number[];
      const pseudonyms = Object.entries(spec.fields)
        .filter(([, f]) => f.type === "pseudonym")
        .map(([field]) => field);
      for (const field of pseudonyms) {
        expect(["participant", "channel"], `${code}.${field}`).toContain(field);
      }
      expect(classes.includes(1), code).toBe(pseudonyms.includes("participant"));
      expect(classes.includes(19), code).toBe(pseudonyms.includes("channel"));
    }
  });

  it("allows a host only on the connect event", () => {
    const withHost = entries
      .filter(([, spec]) => Object.values(spec.fields).some((f) => f.type === "host"))
      .map(([code]) => code);
    expect(withHost).toEqual(["ws.connecting"]);
  });

  it("keeps the string patterns from passing a URL, path, email or address", () => {
    const leaks = [
      "https://chat.example.org/path?q=1",
      "chat.example.org:8443",
      "C:\\Users\\someone",
      "/home/someone/.config",
      "someone@example.org",
      "Bearer eyJhbGciOi",
      "Someone's iPhone",
    ];
    for (const value of leaks) {
      expect(FIELD_PATTERNS.host.test(value), value).toBe(false);
      expect(FIELD_PATTERNS.token.test(value), value).toBe(false);
      expect(FIELD_PATTERNS.version.test(value), value).toBe(false);
      expect(FIELD_PATTERNS.hash.test(value), value).toBe(false);
      expect(FIELD_PATTERNS.pseudonym.test(value), value).toBe(false);
    }
    expect(FIELD_PATTERNS.host.test("chat.example.org")).toBe(true);
    expect(FIELD_PATTERNS.version.test("131.0.2903.70")).toBe(true);
    expect(FIELD_PATTERNS.token.test("libvpx")).toBe(true);
    expect(FIELD_PATTERNS.token.test("0xC0000005")).toBe(true);
    expect(FIELD_PATTERNS.hash.test("9f86d081")).toBe(true);
    expect(FIELD_PATTERNS.pseudonym.test("u3")).toBe(true);
  });

  it("never reuses a server event code with another meaning", () => {
    const server = serverCodes();
    expect(server.size).toBeGreaterThan(100);
    for (const [code] of entries) {
      expect(server.has(code.replace(".", "_")), code).toBe(false);
    }
  });

  it("keeps the readable doc in step with the catalogue", () => {
    const doc = readFileSync(
      join(repoRoot, "docs", "architecture", "client-diagnostics.md"),
      "utf8",
    );
    for (const [code, spec] of entries) {
      expect(doc, code).toContain(`\`${code}\``);
      for (const field of Object.keys(spec.fields)) {
        expect(doc, `${code}.${field}`).toContain(field);
      }
    }
    expect(doc).toContain(`${EVENT_LOG_CAPS.maxEvents.toLocaleString("en-US")} events`);
    expect(doc).toContain(`${CAMERA_STALL_THRESHOLD_MS / 1000} s`);
  });

  it("has every emitted code recorded by the files it names", () => {
    for (const [code, spec] of entries) {
      const tsOwners = spec.owners.filter((o) => o.endsWith(".ts"));
      const recorded = tsOwners.some((owner) => {
        const path = join(clientRoot, owner);
        return existsSync(path) && readFileSync(path, "utf8").includes(`"${code}"`);
      });
      expect(recorded, code).toBe(!NOT_EMITTED_YET.has(code));
    }
  });

  it("uses the catalogue's stall threshold in the camera watchdog", () => {
    expect(STALL_THRESHOLD_MS).toBe(CAMERA_STALL_THRESHOLD_MS);
  });

  it("keeps the caps bounded", () => {
    expect(EVENT_LOG_CAPS.maxEvents).toBeLessThanOrEqual(5000);
    expect(EVENT_LOG_CAPS.maxBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(EVENT_LOG_CAPS.maxAgeMs).toBeLessThanOrEqual(60 * 60 * 1000);
    expect(CAMERA_STALL_THRESHOLD_MS).toBeGreaterThanOrEqual(1000);
  });
});
