// The client reads each ready capability by name, and a name the server never
// sends reads as false forever. Compare the client's wire type with the
// server's struct tags so a flag cannot exist on one side only.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../helpers/repoRoot";

function serverNames(): string[] {
  const source = readFileSync(path.join(repoRoot, "Server/ws/ready_capabilities.go"), "utf8");
  const body = /type readyCapabilitiesPayload struct \{([\s\S]*?)\n\}/.exec(source)?.[1];
  if (body === undefined) throw new Error("readyCapabilitiesPayload not found");
  return [...body.matchAll(/`json:"([a-z_]+)"`/g)].map((m) => m[1]!).toSorted();
}

function fieldNames(source: string, from: number, to: number): string[] {
  return [...source.slice(from, to).matchAll(/^\s+readonly ([a-z_]+)\?:/gm)]
    .map((m) => m[1]!)
    .toSorted();
}

/** The wire type of `ready.capabilities`. */
function clientNames(): string[] {
  const source = readFileSync(path.join(repoRoot, "Client/src/lib/wireServer.ts"), "utf8");
  const start = source.indexOf("export interface ReadyPayload {");
  const open = source.indexOf("readonly capabilities?: {", start);
  const close = source.indexOf("\n  };", open);
  if (start === -1 || open === -1 || close === -1) throw new Error("ready capabilities not found");
  return fieldNames(source, open, close);
}

/** The flags the capability module answers questions about. */
function readFlags(): string[] {
  const file = "Client/src/lib/net/serverCapabilities.ts";
  const source = readFileSync(path.join(repoRoot, file), "utf8");
  const open = source.indexOf("export interface ReadyCapabilityFlags {");
  const close = source.indexOf("\n}", open);
  if (open === -1 || close === -1) throw new Error("ReadyCapabilityFlags not found");
  return fieldNames(source, open, close);
}

describe("ready capabilities", () => {
  it("names the same flags on the client and the server", () => {
    expect(serverNames().length).toBeGreaterThan(10);
    expect(clientNames()).toEqual(serverNames());
  });

  it("reads only flags a server sends", () => {
    const sent = new Set(serverNames());
    expect(readFlags().filter((name) => !sent.has(name))).toEqual([]);
  });

  it("includes id_mentions, which the composer needs to send picked mentions as ids", () => {
    expect(serverNames()).toContain("id_mentions");
  });
});
