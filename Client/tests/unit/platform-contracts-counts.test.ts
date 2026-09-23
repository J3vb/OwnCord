// Guard the unchanged count table with registrations and the platform invoke map.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  documentedCommands,
  documentedCount,
  platformInvokes,
  registeredCommands,
} from "../helpers/platform-command-inventory";

const repoRoot = path.resolve(__dirname, "../../..");
const clientRoot = path.join(repoRoot, "Client");
function sources(dir: string, extension: RegExp): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((entry) => extension.test(entry) && !entry.split(path.sep).includes("target"))
    .map((entry) => path.join(dir, entry));
}
const files = sources(path.join(clientRoot, "src"), /\.(ts|tsx)$/).filter(
  (file) => !/\.(test|d)\.tsx?$/.test(file),
);
const config = ts.readConfigFile(path.join(clientRoot, "tsconfig.json"), ts.sys.readFile);
const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, clientRoot);
const program = ts.createProgram(files, options);
const platform = platformInvokes(
  program,
  files.map((file) => program.getSourceFile(file)!),
);
const rustSources = sources(path.join(clientRoot, "src-tauri"), /\.rs$/).map((file) =>
  readFileSync(file, "utf8"),
);
const registered = registeredCommands(rustSources);
const doc = readFileSync(path.join(repoRoot, "docs/architecture/platform-contracts.md"), "utf8");

function checkRegistrations(actual: Set<string>, documentation: string): void {
  expect([...actual].sort()).toEqual([...documentedCommands(documentation)].sort());
  expect(documentedCount(documentation, "handlers in `Client/src-tauri/`")).toBe(actual.size);
}

describe("platform-contracts count table matches registrations", () => {
  it("documents the platform invoke map and real imports", () => {
    expect(documentedCount(doc, "importing `@tauri-apps/*`")).toBe(platform.importers);
    expect(documentedCount(doc, "Distinct `invoke` command names")).toBe(platform.commands.size);
    const missing = [...platform.commands].filter((name) => !registered.has(name));
    expect(missing).toEqual([]);
    expect(documentedCount(doc, "TS calls with no matching Rust handler")).toBe(missing.length);
  });

  it("documents exactly the registered names, including conditional handlers", () => {
    checkRegistrations(registered, doc);
  });

  it("rejects an undocumented registration and a documented but unregistered command", () => {
    expect(() =>
      checkRegistrations(
        registeredCommands([...rustSources, "tauri::generate_handler![new_command]"]),
        doc,
      ),
    ).toThrow();
    const removed = new Set(registered);
    removed.delete("get_settings");
    expect(() => checkRegistrations(removed, doc)).toThrow();
  });

  it("rejects a replacement even when the command count stays the same", () => {
    const replaced = new Set(registered);
    replaced.delete("get_settings");
    replaced.add("renamed_settings");
    expect(() => checkRegistrations(replaced, doc)).toThrow();
    expect(() =>
      checkRegistrations(registered, doc.replace("\nget_settings\n", "\nstale_settings\n")),
    ).toThrow();
  });

  it("ignores comments, strings and unregistered declarations", () => {
    checkRegistrations(
      registeredCommands([
        ...rustSources,
        `
      // #[tauri::command] fn comment() {}
      /* tauri::generate_handler![fake] /* nested */ */
      const EXAMPLE: &str = r##"tauri::generate_handler![fake]"##;
      #[tauri::command] fn unregistered() {}
    `,
      ]),
      doc,
    );
  });

  it("parses multiple lists, paths, attributes and duplicates as a union", () => {
    expect(
      [
        ...registeredCommands([
          'tauri::generate_handler![one::first, #[cfg(any(target_os = "linux", feature = "test"))] two::second,]',
          "generate_handler![one::first, third]",
        ]),
      ].sort(),
    ).toEqual(["first", "second", "third"]);
  });

  it("pins the measurement to a commit", () => {
    expect(doc.match(/^\*\*Measured against:\*\* (.+)$/m)?.[1]?.trim()).toBeTruthy();
  });
});

function invokeFixture(source: string) {
  const root = path.join(clientRoot, "inventory-fixture.ts");
  const sdk = path.join(clientRoot, "node_modules/@tauri-apps/api/core.d.ts");
  const virtual = new Map([
    [root, source],
    [
      sdk,
      "export declare function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;",
    ],
  ]);
  // Binding fixtures need the SDK signature and Promise types, not DOM/Node.
  const fixtureOptions = { ...options, lib: ["lib.es5.d.ts"], types: [] };
  const host = ts.createCompilerHost(fixtureOptions);
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = virtual.get(name);
    return text === undefined
      ? getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(name, text, languageVersion, true);
  };
  host.resolveModuleNames = (names) =>
    names.map((name) =>
      name === "@tauri-apps/api/core"
        ? {
            resolvedFileName: sdk,
            extension: ts.Extension.Dts,
            isExternalLibraryImport: true,
          }
        : undefined,
    );
  const fixture = ts.createProgram([root], fixtureOptions, host);
  return platformInvokes(fixture, [fixture.getSourceFile(root)!]);
}

describe("platform invoke map parser", () => {
  it("follows imports, lazy helpers, assignments and typed callbacks independent of wrapper names", () => {
    const source = `
      import { invoke as send } from "@tauri-apps/api/core";
      import * as core from "@tauri-apps/api/core";
      const service = {
        settings: () => send<Record<string, unknown>>("get_settings"),
        save: () => core.invoke("save_settings"),
      };
      async function loadNative(): Promise<((cmd: string) => Promise<unknown>) | null> {
        const { invoke: native } = await import("@tauri-apps/api/core");
        return native;
      }
      async function credential() {
        const renamed = await loadNative();
        return renamed!("load_credential");
      }
      let socket: ((cmd: string) => Promise<unknown>) | null = null;
      async function connect() {
        const host = await import("@tauri-apps/api/core");
        socket = host.invoke;
        return socket("ws_connect");
      }
      type NativeCall = (typeof import("@tauri-apps/api/core"))["invoke"];
      function broker(ask: (native: NativeCall) => Promise<unknown>) { return ask(send); }
      broker(native => native<ArrayBuffer>("external_image"));
    `;
    const actual = invokeFixture(source);
    expect([...actual.commands].sort()).toEqual([
      "external_image",
      "get_settings",
      "load_credential",
      "save_settings",
      "ws_connect",
    ]);
    expect(actual.importers).toBe(1);
    expect(
      invokeFixture(
        source.replaceAll("send", "renamedBinding").replaceAll("loadNative", "anotherHelper"),
      ),
    ).toEqual(actual);
  });

  it("ignores commented-out imports, calls, strings and unrelated functions named invoke", () => {
    const source = `
      // import { invoke } from "@tauri-apps/api/core";
      // invoke("comment_only");
      /* invoke<Record<string, unknown>>("block_comment"); */
      const example = 'invoke("string_example")';
      function invoke(command: string) { return command; }
      invoke("unrelated");
    `;
    expect(invokeFixture(source)).toEqual({ commands: new Set(), importers: 0 });
    const binding = 'import { invoke as native } from "@tauri-apps/api/core"; native("real");';
    expect(invokeFixture(binding + '\n// native("comment_only");')).toEqual(invokeFixture(binding));
  });

  it("rejects dynamic command names instead of silently undercounting them", () => {
    expect(() =>
      invokeFixture(
        'import { invoke } from "@tauri-apps/api/core"; const command = location.hash; invoke(command);',
      ),
    ).toThrow("Nonliteral platform command");
  });
});
