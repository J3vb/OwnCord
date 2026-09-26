// Public CI must never print or upload an unfixed generated reproducer.
import { spawnSync } from "node:child_process";
import { mkdtempSync, openSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "owncord-fuzz-"));
const packages = ["./ws", "./db", "./permissions", "./storage"];
try {
  for (const pkg of packages) {
    const listed = spawnSync("go", ["test", pkg, "-list", "^Fuzz"], {
      cwd: "Server",
      encoding: "utf8",
    });
    if (listed.status !== 0) throw new Error(`Could not enumerate fuzz targets in ${pkg}`);
    const targets = listed.stdout.split(/\r?\n/).filter((line) => /^Fuzz\w+$/.test(line));
    if (!targets.length) throw new Error(`No fuzz targets found in ${pkg}`);
    for (const target of targets) {
      const fd = openSync(join(dir, "output"), "w", 0o600);
      let result;
      try {
        result = spawnSync(
          "go",
          ["test", pkg, "-run=^$", `-fuzz=^${target}$`, "-fuzztime=30s", "-parallel=2"],
          { cwd: "Server", stdio: ["ignore", fd, fd], timeout: 180_000 },
        );
      } finally {
        closeSync(fd);
      }
      if (result.status !== 0)
        throw new Error(
          `Fuzzing failed in ${pkg}/${target} (exit=${result.status}, signal=${result.signal}, error=${result.error?.code ?? "none"}). Reproduce locally; output and generated corpus are not published.`,
        );
      console.log(`PASS ${pkg}/${target} (30s generated inputs)`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
