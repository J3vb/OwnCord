// An explicit CC/CXX override must still be clang >= 21: webrtc-sys needs it,
// and silently accepting gcc only fails much later inside the native build.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "../../scripts/linux-webrtc-toolchain.sh");
const dirs: string[] = [];

/** A fake compiler answering `-dumpversion` with `major` and `--version` with `banner`. */
function fake(dir: string, name: string, major: string, banner: string): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    `#!/bin/sh\ncase "$1" in -dumpversion) echo ${major};; --version) echo '${banner}';; esac\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

function run(major: string, banner: string) {
  const dir = mkdtempSync(join(tmpdir(), "tc-"));
  dirs.push(dir);
  const cache = join(dir, "cache");
  const arch = process.arch === "arm64" ? "linux-arm64-release" : "linux-x64-release";
  mkdirSync(join(cache, arch, "lib"), { recursive: true });
  writeFileSync(join(cache, arch, "lib", "libwebrtc.a"), "");
  const cc = fake(dir, "cc", major, banner);
  const cxx = fake(dir, "cxx", major, banner);
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: dir,
    CC: cc,
    CXX: cxx,
    OWNCORD_LINUX_WEBRTC_CACHE: cache,
  };
  return { cc, ...spawnSync("bash", [SCRIPT], { env, encoding: "utf8" }) };
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "linux")("linux-webrtc-toolchain CC/CXX override", () => {
  it("rejects a gcc override", () => {
    const r = run("13", "gcc (GCC) 13");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/clang >= 21/);
  });

  it("accepts a clang 21 override", () => {
    const r = run("21", "clang version 21.1.0");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`export CC=${r.cc}`);
  });
});
