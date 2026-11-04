// Nightly generated fuzzing of every Go package that has Fuzz targets.
// Public CI must never print or upload an unfixed generated reproducer.
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const FUZZ_TIME_SECONDS = 30;
// Building a package's fuzz binary plus the fuzz time; a target that runs past
// this is stuck, not slow.
export const TARGET_TIMEOUT_MS = 180_000;
// Tags a fuzz file behind a build constraint is listed and run with.
export const FUZZ_TAGS = "otel,wazero";

/**
 * Parses `go test -list ^Fuzz <pkgs>` output: target names come first, then
 * the package's "ok" line names the import path they belong to.
 * @returns {Map<string, string[]>} import path -> targets
 */
export function parseFuzzList(stdout) {
  const byPackage = new Map();
  let pending = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (/^Fuzz\w+$/.test(line)) {
      pending.push(line);
      continue;
    }
    const ok = /^ok\s+(\S+)/.exec(line);
    if (ok) {
      if (pending.length) byPackage.set(ok[1], pending);
      pending = [];
    }
  }
  if (pending.length) throw new Error(`Fuzz targets with no package line: ${pending.join(", ")}`);
  return byPackage;
}

/** True when a Go test file declares a fuzz target and carries a build constraint. */
export function isTaggedFuzzFile(source) {
  return /^func Fuzz\w+\(/m.test(source) && /^\/\/go:build /m.test(source);
}

/**
 * The run plan: every default-build target, then targets that exist only
 * under FUZZ_TAGS. A tagged package listed with no targets is not an error;
 * an empty plan is.
 */
export function buildPlan(defaultList, taggedList = new Map()) {
  const plan = [];
  for (const [pkg, targets] of defaultList) {
    for (const target of targets) plan.push({ pkg, target, tags: "" });
  }
  for (const [pkg, targets] of taggedList) {
    const known = new Set(defaultList.get(pkg) ?? []);
    for (const target of targets)
      if (!known.has(target)) plan.push({ pkg, target, tags: FUZZ_TAGS });
  }
  if (!plan.length) throw new Error("No fuzz targets found in Server/");
  return plan;
}

function listTargets(pkgs, tags) {
  const args = ["test", ...(tags ? [`-tags=${tags}`] : []), "-list", "^Fuzz", ...pkgs];
  const listed = spawnSync("go", args, {
    cwd: "Server",
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (listed.status !== 0)
    throw new Error(`Could not enumerate fuzz targets (exit=${listed.status}):\n${listed.stderr}`);
  return parseFuzzList(listed.stdout);
}

function taggedPackages(root) {
  const pkgs = new Set();
  for (const rel of readdirSync(root, { recursive: true, encoding: "utf8" })) {
    const posix = rel.split("\\").join("/");
    if (!posix.endsWith("_test.go") || /(^|\/)(testdata|vendor)\//.test(posix)) continue;
    if (isTaggedFuzzFile(readFileSync(join(root, rel), "utf8"))) {
      const dir = posix.includes("/") ? posix.slice(0, posix.lastIndexOf("/")) : ".";
      pkgs.add(`./${dir}`);
    }
  }
  return [...pkgs].sort();
}

function summary(text) {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

function main() {
  const tagged = taggedPackages("Server");
  const plan = buildPlan(
    listTargets(["./..."], ""),
    tagged.length ? listTargets(tagged, FUZZ_TAGS) : new Map(),
  );
  const packages = new Set(plan.map((p) => p.pkg)).size;
  summary(
    `Fuzzing ${plan.length} targets in ${packages} packages, ${FUZZ_TIME_SECONDS}s each: ` +
      `${Math.ceil((plan.length * FUZZ_TIME_SECONDS) / 60)} min of generated inputs plus builds.`,
  );
  const dir = mkdtempSync(join(tmpdir(), "owncord-fuzz-"));
  const started = Date.now();
  try {
    for (const { pkg, target, tags } of plan) {
      const fd = openSync(join(dir, "output"), "w", 0o600);
      let result;
      try {
        const args = [
          "test",
          ...(tags ? [`-tags=${tags}`] : []),
          pkg,
          "-run=^$",
          `-fuzz=^${target}$`,
        ];
        args.push(`-fuzztime=${FUZZ_TIME_SECONDS}s`, "-parallel=2");
        // go test runs each package in its own directory, so a target's
        // testdata/ paths resolve the same way they do in the unit suite.
        result = spawnSync("go", args, {
          cwd: "Server",
          stdio: ["ignore", fd, fd],
          timeout: TARGET_TIMEOUT_MS,
        });
      } finally {
        closeSync(fd);
      }
      if (result.status !== 0)
        throw new Error(
          `Fuzzing failed in ${pkg} ${target}${tags ? ` (tags ${tags})` : ""} (exit=${result.status}, signal=${result.signal}, error=${result.error?.code ?? "none"}). Reproduce locally; output and generated corpus are not published.`,
        );
      console.log(
        `PASS ${pkg} ${target}${tags ? ` [${tags}]` : ""} (${FUZZ_TIME_SECONDS}s generated inputs)`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  summary(
    `All ${plan.length} fuzz targets passed in ${Math.round((Date.now() - started) / 60_000)} min.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
