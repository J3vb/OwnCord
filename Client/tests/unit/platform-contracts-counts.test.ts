// The counts table in docs/architecture/platform-contracts.md is the record B7
// plans the desktop/browser seam against, and its maintenance rule is "update
// the counts in the same change". Re-derive the three numbers from the tree and
// fail when the table disagrees, so a forgotten update is red in CI instead of
// drifting quietly.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../../..");
const clientSrc = path.join(repoRoot, "Client/src");
const srcTauri = path.join(repoRoot, "Client/src-tauri");

/** Every matching file's text under dir, skipping build output — `target/`
 *  holds Cargo-generated sources that `git grep` never sees, so counting them
 *  would make the numbers disagree between a clean and a built checkout. */
function readSources(dir: string, name: RegExp): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((entry) => name.test(entry) && !entry.split(path.sep).includes("target"))
    .map((entry) => readFileSync(path.join(dir, entry), "utf8"));
}

const srcTexts = readSources(clientSrc, /\.(ts|tsx)$/);

// "Imports @tauri-apps" is the whole-file text test the doc's own recipe uses.
const tauriImporters = srcTexts.filter((text) => text.includes("@tauri-apps")).length;

// The alias is the trap this count exists to survive: lib/ws.ts binds
// core.invoke to a local tauriInvoke, so matching only invoke("…") misses four.
// A nested generic is the other blind spot: invoke<Record<string, unknown>>(…)
// does not match either, which is why get_settings — called exactly that way in
// platform/desktop/settings.ts — is counted at 45 rather than 46.
const invokeNames = new Set(
  srcTexts.flatMap((text) =>
    [...text.matchAll(/(tauriInvoke|invoke)(<[^>]*>)?\(\s*"([a-z_]+)"/g)].map((m) => m[3]),
  ),
).size;

// Both spellings count: 39 `#[tauri::command]` plus 12
// `#[tauri::command(async)]`. Matching the exact bracket form undercounts to 39.
const commandHandlers = readSources(srcTauri, /\.rs$/).reduce(
  (total, text) => total + (text.match(/#\[tauri::command/g)?.length ?? 0),
  0,
);

const doc = readFileSync(path.join(repoRoot, "docs/architecture/platform-contracts.md"), "utf8");

/** The value cell of the table row whose text contains label, or undefined. */
function documentedCount(label: string): number | undefined {
  const row = doc.split("\n").find((line) => line.startsWith("|") && line.includes(label));
  const cell = row?.split("|")[2]?.trim();
  return cell !== undefined && /^\d+$/.test(cell) ? Number(cell) : undefined;
}

describe("platform-contracts count table matches the tree", () => {
  it("counts what the table says it counts", () => {
    expect(tauriImporters).toBe(22);
    expect(invokeNames).toBe(45);
    expect(commandHandlers).toBe(51);
  });

  it("states those same counts in the table", () => {
    expect(documentedCount("importing `@tauri-apps/*`")).toBe(tauriImporters);
    expect(documentedCount("Distinct `invoke` command names")).toBe(invokeNames);
    expect(documentedCount("handlers in `Client/src-tauri/`")).toBe(commandHandlers);
  });

  it("pins the measurement to a commit", () => {
    expect(doc.match(/^\*\*Measured against:\*\* (.+)$/m)?.[1]?.trim()).toBeTruthy();
  });
});
