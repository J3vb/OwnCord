import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("./protocol-n1-compat.mjs", import.meta.url).href;
const args = ["run", "a path with spaces # % & symbols", "--outputFile.json=report # %.json"];

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "owncord-compat spaces # %-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const installation = join(dir, "npm installation");
  const bin = join(installation, "node_modules", "npm", "bin");
  mkdirSync(bin, { recursive: true });
  const record = join(dir, "argv.json");
  const cli = `import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));
    console.log("fixture output"); process.exitCode = Number(process.env.FIXTURE_EXIT ?? 0);`;
  for (const name of ["npm", "npx"]) writeFileSync(join(bin, `${name}-cli.js`), cli);
  return { dir, installation, bin, record };
}

function invoke(
  f,
  {
    cmd = "npm",
    captured = false,
    missing = false,
    startError = false,
    fromPath = false,
    exit = 0,
    native = false,
  } = {},
) {
  const code = native ? "" : 'Object.defineProperty(process, "platform", { value: "win32" });';
  const preload =
    "data:text/javascript," +
    encodeURIComponent(
      code +
        (missing
          ? 'import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module"; const exists = fs.existsSync; fs.existsSync = p => /[\\\\/]np[mx]-cli\\.js$/.test(String(p)) ? false : exists(p); syncBuiltinESMExports();'
          : "") +
        (startError
          ? 'import cp from "node:child_process"; import { syncBuiltinESMExports } from "node:module"; cp.spawnSync = () => ({ status: null, error: Object.assign(new Error("fixture spawn error"), { code: "ENOENT" }) }); syncBuiltinESMExports();'
          : ""),
    );
  const env = { ...process.env, PATH: fromPath ? f.installation : "", FIXTURE_EXIT: String(exit) };
  delete env.npm_execpath;
  if (!fromPath) env.npm_execpath = join(f.bin, "npm-cli.js");
  const command = native ? process.execPath : cmd;
  const commandArgs = native ? [join(f.bin, "npm-cli.js"), ...args] : args;
  const driver = `import { run, runCaptured } from ${JSON.stringify(script)};
    try {
      const result = ${captured ? "runCaptured" : "run"}(${JSON.stringify(command)}, ${JSON.stringify(commandArgs)}, { cwd: ${JSON.stringify(f.dir)} });
      console.log("\\nRESULT " + JSON.stringify(result));
      process.exitCode = ${captured ? "result.status" : "result"};
    } catch (err) { console.error(err.message); process.exitCode = err.code ?? 99; }`;
  return spawnSync(process.execPath, ["--import", preload, "--input-type=module", "-e", driver], {
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
}

for (const cmd of ["npm", "npx"]) {
  for (const captured of [false, true]) {
    test(`Windows ${cmd} ${captured ? "captured" : "inherited"} launch preserves arguments and exit code`, (t) => {
      const f = fixture(t);
      const run = invoke(f, { cmd, captured, exit: 7 });
      assert.equal(run.status, 7, run.stderr || run.stdout);
      assert.deepEqual(JSON.parse(readFileSync(f.record, "utf8")), args);
      assert.match(run.stdout, /fixture output/);
      if (captured) assert.match(run.stdout, /"status":7,"out":"fixture output\\n"/);
    });
  }
}

test("Windows launch finds npm beside a PATH installation without npm_execpath", (t) => {
  const f = fixture(t);
  const run = invoke(f, { fromPath: true });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(readFileSync(f.record, "utf8")), args);
});

for (const captured of [false, true]) {
  test(`missing Windows launcher reports could-not-run (${captured ? "captured" : "inherited"})`, (t) => {
    const f = fixture(t);
    const run = invoke(f, { captured, missing: true });
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /cannot locate npm's JavaScript CLI/);
    assert.match(run.stderr, /cwd:/);
    assert.equal(existsSync(f.record), false);
  });
  test(`spawn failure reports command and cwd (${captured ? "captured" : "inherited"})`, (t) => {
    const f = fixture(t);
    const run = invoke(f, { captured, startError: true });
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /npm.*ENOENT/);
    assert.match(run.stderr, /cwd:/);
    assert.equal(existsSync(f.record), false);
  });
}

test("native executable launch retains captured output and genuine failure status", (t) => {
  const f = fixture(t);
  const run = invoke(f, { native: true, captured: true, exit: 1 });
  assert.equal(run.status, 1, run.stderr);
  assert.deepEqual(JSON.parse(readFileSync(f.record, "utf8")), args);
  assert.match(run.stdout, /fixture output/);
});

test("importing the helpers does not start the compatibility workflow", () => {
  const run = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(script)});`],
    {
      env: { ...process.env, PATH: "" },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "");
  assert.equal(run.stderr, "");
});
