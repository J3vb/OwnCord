import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkTauriVersions } from "./check-tauri-versions.mjs";

function fixture(npm = "2.5.9", rust = "2.5.7") {
  return [
    {
      lockfileVersion: 3,
      packages: {
        "": { name: "owncord-client", dependencies: { "@tauri-apps/plugin-http": "^2" } },
        "node_modules/@tauri-apps/api": { version: "2.11.0" },
        "node_modules/@tauri-apps/plugin-http": { version: npm },
      },
    },
    `version = 4
[[package]]
name = "owncord-client"
version = "1.2.0-alpha.4"
dependencies = [
 "tauri",
 "tauri-plugin-http",
]
[[package]]
name = "tauri"
version = "2.11.5"
[[package]]
name = "tauri-plugin-http"
version = "${rust}"
`,
  ];
}

test("allows different patches and checks resolved versions instead of broad manifest ranges", () => {
  assert.deepEqual(checkTauriVersions(...fixture()), { checked: 2, mismatches: [] });
});

test("catches either direction of the independent npm/Cargo minor bump", () => {
  for (const versions of [
    ["2.6.0", "2.5.9"],
    ["2.5.9", "2.6.0"],
  ]) {
    const { mismatches } = checkTauriVersions(...fixture(...versions));
    assert.equal(mismatches.length, 1);
    assert.match(mismatches[0], /tauri-plugin-http/);
  }
});

test("also checks the core API and major version changes", () => {
  const [npm, cargo] = fixture("3.5.0", "2.5.7");
  npm.packages["node_modules/@tauri-apps/api"].version = "2.12.0";
  assert.equal(checkTauriVersions(npm, cargo).mismatches.length, 2);
});

test("does not compare Rust-only plugins or nested JS transitive dependencies", () => {
  const [npm, cargo] = fixture();
  npm.packages["node_modules/other/node_modules/@tauri-apps/api"] = { version: "1.0.0" };
  assert.deepEqual(
    checkTauriVersions(
      npm,
      cargo + '\n[[package]]\nname = "tauri-plugin-log"\nversion = "2.9.0"\n',
    ),
    {
      checked: 2,
      mismatches: [],
    },
  );
});

test("resolves the app's explicit dependency when Cargo has multiple versions", () => {
  const [npm, cargo] = fixture();
  const duplicated =
    cargo.replace(' "tauri-plugin-http",', ' "tauri-plugin-http 2.5.7",') +
    '\n[[package]]\nname = "tauri-plugin-http"\nversion = "1.0.0"\n';
  assert.deepEqual(checkTauriVersions(npm, duplicated), { checked: 2, mismatches: [] });
  assert.throws(
    () => checkTauriVersions(npm, duplicated.replace(' 2.5.7",', '",')),
    /Cannot resolve/,
  );
});

test("fails closed on missing, malformed, or empty resolved package inputs", () => {
  const [npm, cargo] = fixture();
  assert.throws(() => checkTauriVersions({}, cargo), /Expected an npm/);
  assert.throws(() => checkTauriVersions(npm, "version = 4"), /application package/);
  npm.packages["node_modules/@tauri-apps/plugin-http"].version = "^2";
  assert.throws(() => checkTauriVersions(npm, cargo), /resolved semantic version/);
  delete npm.packages["node_modules/@tauri-apps/plugin-http"];
  delete npm.packages["node_modules/@tauri-apps/api"];
  assert.throws(() => checkTauriVersions(npm, cargo), /No paired Tauri/);
});
