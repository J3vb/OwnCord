import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkNodePolicy } from "./check-node-policy.mjs";

const PATHS = ["package.json", "Client/package.json", "tools/mcp-introspect/package.json"];

// In-memory inputs, so a rule can be broken one at a time without touching the
// working tree the check itself reads.
function fixture(overrides = {}) {
  const {
    nvmrc = "26\n",
    node = "^26",
    npm = ["^11", "^11", "^11"],
    strict = [true, true, true],
    pins = ["26", "26"],
    types = "^26.6.2",
  } = overrides;
  return {
    nvmrc,
    manifests: PATHS.map((path, index) => ({
      path,
      json: {
        engines: { node, npm: npm[index] },
        devDependencies: { "@types/node": types },
      },
    })),
    npmrcs: PATHS.map((path, index) => ({
      path: path.replace("package.json", ".npmrc"),
      // The real file's shape, so the check is exercised against a comment
      // block rather than a bare directive.
      text: `# engine-strict makes the engines block in package.json a hard error.\n${
        strict[index] ? "engine-strict=true\n" : "# engine-strict=true is disabled here\n"
      }`,
    })),
    workflows: [
      {
        path: ".github/workflows/ci.yml",
        text: `${pins.map((pin) => `          node-version: ${pin}`).join("\n")}\n`,
      },
    ],
  };
}

test("agrees when every statement names the supported major", () => {
  const { major, mismatches } = checkNodePolicy(fixture());
  assert.equal(major, "26");
  assert.deepEqual(mismatches, []);
});

test("rejects the open-ended range that engine-strict cannot narrow", () => {
  const { mismatches } = checkNodePolicy(fixture({ node: ">=24" }));
  assert.equal(mismatches.length, 3);
  for (const mismatch of mismatches) assert.match(mismatch, /engines\.node is ">=24"/);
});

test("rejects npm ranges that disagree across roots", () => {
  const { mismatches } = checkNodePolicy(fixture({ npm: ["^11", "^11", "^12"] }));
  assert.deepEqual(mismatches, [
    'engines.npm disagrees across roots: package.json "^11", Client/package.json "^11", tools/mcp-introspect/package.json "^12"',
  ]);
});

test("rejects an npm range that is not a caret major, even when all three agree", () => {
  const { mismatches } = checkNodePolicy(fixture({ npm: [">=10", ">=10", ">=10"] }));
  assert.equal(mismatches.length, 3);
  for (const mismatch of mismatches) assert.match(mismatch, /expected a \^<major> range/);
});

test("rejects a root whose engine-strict is missing or commented out", () => {
  const { mismatches } = checkNodePolicy(fixture({ strict: [true, false, true] }));
  assert.deepEqual(mismatches, [
    "Client/.npmrc: no engine-strict=true, so engines is only a warning here",
  ]);
});

test("rejects a stray node-version pin in any workflow", () => {
  const { mismatches } = checkNodePolicy(fixture({ pins: ["26", "24"] }));
  assert.deepEqual(mismatches, [".github/workflows/ci.yml:2: node-version is 24, expected 26"]);
});

test("rejects a mismatched @types/node range", () => {
  const { mismatches } = checkNodePolicy(fixture({ types: "^24.13.3" }));
  assert.deepEqual(mismatches, [
    'Client/package.json: @types/node is "^24.13.3", expected a ^26. range',
  ]);
});

test("accepts a quoted pin", () => {
  const { mismatches } = checkNodePolicy(fixture({ pins: ['"26"', "'26'"] }));
  assert.deepEqual(mismatches, []);
});

test("accepts a v-prefixed, CRLF .nvmrc", () => {
  const { major, mismatches } = checkNodePolicy(fixture({ nvmrc: "v26\r\n" }));
  assert.equal(major, "26");
  assert.deepEqual(mismatches, []);
});

test("ignores the pin a job installs to prove a wrong major is refused", () => {
  const { mismatches } = checkNodePolicy(
    fixture({ pins: ["26", '"24" # deliberately NOT the supported major'] }),
  );
  assert.deepEqual(mismatches, []);
});

test("fails closed when the .nvmrc names no major, or no pins are found", () => {
  assert.throws(() => checkNodePolicy(fixture({ nvmrc: "lts/*\n" })), /does not name a Node major/);
  assert.throws(() => checkNodePolicy(fixture({ pins: [] })), /No node-version pins found/);
});
