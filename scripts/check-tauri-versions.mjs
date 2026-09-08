#!/usr/bin/env node
// Check the resolved lockfiles before spending time on a desktop build.
// Tauri CLI compares major/minor for tauri ↔ @tauri-apps/api and paired
// official plugins; patch versions are allowed to differ. Reference:
// https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.10.1/crates/tauri-cli/src/info/plugins.rs
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function majorMinor(version, name) {
  const match = /^(\d+)\.(\d+)\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.exec(version ?? "");
  if (!match) throw new Error(`${name} has no resolved semantic version: ${version}`);
  return `${match[1]}.${match[2]}`;
}

// Cargo generates a deliberately regular lockfile. Read only its package
// name/version fields and string dependency arrays; do not parse Cargo.toml
// requirements or mistake a transitive duplicate for the app's direct crate.
function cargoPackages(source) {
  return source
    .split(/^\[\[package\]\]\s*$/m)
    .slice(1)
    .map((block) => {
      const scalar = (key) => {
        const value = block.match(new RegExp(`^${key} = ("[^"\\n]+")\\s*$`, "m"));
        if (!value) throw new Error(`Cargo.lock package is missing ${key}`);
        return JSON.parse(value[1]);
      };
      const dependencies = block.match(/^dependencies = (\[[\s\S]*?\])/m);
      return {
        name: scalar("name"),
        version: scalar("version"),
        dependencies: dependencies ? JSON.parse(dependencies[1].replace(/,\s*\]$/, "]")) : [],
      };
    });
}

export function checkTauriVersions(npmLock, cargoLock) {
  if (![2, 3].includes(npmLock.lockfileVersion) || !npmLock.packages?.[""]?.name)
    throw new Error("Expected an npm v2/v3 lockfile with a root package");
  const packages = cargoPackages(cargoLock);
  const roots = packages.filter((pkg) => pkg.name === npmLock.packages[""].name);
  if (roots.length !== 1) throw new Error("Cannot identify the application package in Cargo.lock");
  const direct = roots[0].dependencies;
  const mismatches = [];
  let checked = 0;
  for (const [path, npmPackage] of Object.entries(npmLock.packages)) {
    const name = path.replace(/^node_modules\//, "");
    const crate =
      name === "@tauri-apps/api"
        ? "tauri"
        : /^@tauri-apps\/plugin-[\w-]+$/.test(name)
          ? name.replace("@tauri-apps/", "tauri-")
          : undefined;
    if (!crate) continue;
    const dependency = direct.find((item) => item.split(" ")[0] === crate);
    // Rust-only and JS-only plugins are not version pairs in Tauri CLI.
    if (!dependency) continue;
    const [, lockedVersion] = dependency.split(" ");
    const candidates = packages.filter(
      (pkg) => pkg.name === crate && (!lockedVersion || pkg.version === lockedVersion),
    );
    if (candidates.length !== 1)
      throw new Error(`Cannot resolve the app's ${crate} dependency in Cargo.lock`);
    const rustVersion = candidates[0].version;
    checked++;
    if (majorMinor(npmPackage.version, name) !== majorMinor(rustVersion, crate))
      mismatches.push(`${crate} ${rustVersion} ↔ ${name} ${npmPackage.version}`);
  }
  if (!checked) throw new Error("No paired Tauri packages found in the lockfiles");
  return { checked, mismatches };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = checkTauriVersions(
      JSON.parse(readFileSync(join(ROOT, "Client/package-lock.json"), "utf8")),
      readFileSync(join(ROOT, "Client/src-tauri/Cargo.lock"), "utf8"),
    );
    if (result.mismatches.length) {
      console.error(
        `Tauri npm/Rust major.minor versions must match:\n${result.mismatches.join("\n")}`,
      );
      console.error(
        "Update the paired dependency in the other lockfile before building the desktop app.",
      );
      process.exitCode = 1;
    } else console.log(`Tauri version alignment: ${result.checked} resolved package pairs match`);
  } catch (error) {
    console.error(`Tauri version alignment: ${error.message}`);
    process.exitCode = 1;
  }
}
