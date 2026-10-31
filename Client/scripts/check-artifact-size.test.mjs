import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkSizes, globToRegExp } from "./check-artifact-size.mjs";

test("a budget pattern matches only its own installer", () => {
  const re = globToRegExp("*_x64-setup.exe");
  assert.ok(re.test("OwnCord_2.5.0_x64-setup.exe"));
  assert.ok(!re.test("OwnCord_2.5.0_x64-setup.exe.sig"));
  assert.ok(!re.test("OwnCord_2.5.0_x64-setupXexe"));
});

test("passes under budget and reports the headroom", () => {
  const { failures, table } = checkSizes(
    [{ name: "OwnCord_2.5.0_x64-setup.exe", size: 7_649_635 }],
    { "*_x64-setup.exe": 7_900_000 },
  );
  assert.deepEqual(failures, []);
  assert.match(table, /250,365 B/);
});

test("fails over budget", () => {
  const { failures } = checkSizes([{ name: "OwnCord_2.6.0_amd64.deb", size: 26_000_000 }], {
    "*_amd64.deb": 25_500_000,
  });
  assert.deepEqual(failures, [
    "OwnCord_2.6.0_amd64.deb: 26000000 B is over its 25500000 B budget by 500000 B",
  ]);
});

test("a missing or doubled installer fails instead of passing silently", () => {
  const files = [
    { name: "a_amd64.AppImage", size: 1 },
    { name: "b_amd64.AppImage", size: 1 },
  ];
  assert.deepEqual(checkSizes(files, { "*_amd64.AppImage": 10, "*_amd64.deb": 10 }).failures, [
    "*_amd64.AppImage: expected one file, found 2",
    "*_amd64.deb: expected one file, found 0",
  ]);
});

test("every smoke target has a budget", () => {
  const config = JSON.parse(
    readFileSync(new URL("../artifact-size-budget.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(Object.keys(config.targets).sort(), [
    "linux-arm64",
    "linux-x64",
    "windows-arm64",
    "windows-x64",
  ]);
});
