// Windows CI only. Test-specific identifier and ephemeral signing key.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, readdir, copyFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { nativeTestConfig } from "./native-test-config.mjs";
const exec = promisify(execFile);
if (process.platform !== "win32" || !process.env.CI)
  throw new Error("Packaged desktop builds run in Windows CI only");
const root = resolve("tests/e2e/.bin/native-updates");
await mkdir(root, { recursive: true });
const cli = resolve("node_modules/@tauri-apps/cli/tauri.js");
const keyPath = join(root, "test.key");
await exec(process.execPath, [
  cli,
  "signer",
  "generate",
  "--ci",
  "--force",
  "--password",
  "",
  "--write-keys",
  keyPath,
]);
const pubkey = (await readFile(`${keyPath}.pub`, "utf8")).trim();
const signingKey = (await readFile(keyPath, "utf8")).trim();
for (const [label, version] of [
  ["old", "1.2.0-alpha.4"],
  ["new", "1.2.0-alpha.5"],
]) {
  const destination = join(root, label);
  await mkdir(destination, { recursive: true });
  const config = join(destination, "tauri.e2e.json");
  await writeFile(
    config,
    JSON.stringify({
      ...(await nativeTestConfig()),
      version,
      productName: "OwnCord E2E",
      identifier: "com.owncord.e2e",
      bundle: {
        targets: ["nsis"],
        createUpdaterArtifacts: "v1Compatible",
        windows: { nsis: { installMode: "currentUser" } },
      },
      plugins: {
        updater: { pubkey, windows: { installMode: "quiet" } },
        "deep-link": { desktop: { schemes: ["owncord-e2e"] } },
      },
    }),
  );
  console.log(`Building signed test desktop ${version}`);
  // Capture compiler output to a file; never print signer key material.
  try {
    const result = await exec(
      process.execPath,
      [cli, "build", "--bundles", "nsis", "--config", config],
      {
        env: {
          ...process.env,
          TAURI_SIGNING_PRIVATE_KEY: signingKey,
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "",
        },
        maxBuffer: 30 * 1024 * 1024,
        timeout: 30 * 60_000,
      },
    );
    await writeFile(join(destination, "build.log"), result.stdout + result.stderr);
  } catch (error) {
    throw new Error(`Desktop build ${version} failed: ${error.stderr ?? error.message}`);
  }
  const bundle = resolve("src-tauri/target/release/bundle/nsis");
  for (const file of await readdir(bundle)) {
    if (!file.includes(version)) continue;
    if (file.endsWith("-setup.exe"))
      await copyFile(join(bundle, file), join(destination, "installer.exe"));
    if (file.endsWith(".nsis.zip"))
      await copyFile(join(bundle, file), join(destination, "update.nsis.zip"));
    if (file.endsWith(".nsis.zip.sig"))
      await copyFile(join(bundle, file), join(destination, "update.nsis.zip.sig"));
  }
  await copyFile(
    resolve("src-tauri/target/release/owncord-client.exe"),
    join(destination, "owncord-client.exe"),
  );
  for (const file of ["installer.exe", "update.nsis.zip", "update.nsis.zip.sig"])
    await readFile(join(destination, file));
}
