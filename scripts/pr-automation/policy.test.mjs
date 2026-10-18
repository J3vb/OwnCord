import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHECKS,
  CODEX_LOGIN,
  CI_CHECKS,
  acceptable,
  classify,
  codexObservation,
  routeReview,
  validateReview,
  checksPassed,
  enforcedProtection,
} from "./policy.mjs";
import { reductions } from "./integrity.mjs";
import { receipt, GitHub } from "./github.mjs";
import { reviewWithClaude } from "./claude.mjs";
import { validateRepair, publishRepair } from "./repair.mjs";

const head = "a".repeat(40),
  base = "b".repeat(40),
  policyRevision = "c".repeat(40);
const options = {
  head,
  base,
  policyRevision,
  now: 1_800_000,
  createdAt: new Date(0).toISOString(),
  codex: { completed: false },
};
const bot = { login: CODEX_LOGIN, type: "Bot" };
const summary = (sha, state = {}) => ({
  user: bot,
  body: `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { commit_sha: sha, status: "completed", has_any_findings: false, has_unresolved_findings: false, ...state } })} -->`,
});

test("quota failure selects Claude immediately; an ordinary pending review waits", () => {
  assert.equal(routeReview({ ...options, now: 100, codex: { quota: true } }), "claude");
  assert.equal(routeReview({ ...options, now: 100 }), "wait");
  assert.equal(routeReview(options), "claude");
});
test("only authenticated, current connector completion certifies review", () => {
  assert.equal(codexObservation([summary(head)], [], head).completed, true);
  assert.equal(codexObservation([summary(base)], [], head).completed, false);
  assert.equal(
    codexObservation([{ ...summary(head), user: { login: "J3vb", type: "User" } }], [], head)
      .completed,
    false,
  );
  assert.equal(
    codexObservation([summary(head, { has_any_findings: null })], [], head).completed,
    false,
  );
  assert.equal(
    codexObservation([summary(head)], [{ user: bot, commit_id: head, state: "COMMENTED" }], head)
      .findings,
    true,
  );
});
test("new head, base or policy cannot reuse a clean receipt", () => {
  const previous = { head, base, policyRevision, verdict: "pass" };
  assert.equal(routeReview({ ...options, previous }), "reuse");
  for (const changed of [{ head: base }, { base: head }, { policyRevision: head }])
    assert.equal(routeReview({ ...options, previous, ...changed }), "claude");
});
test("unavailable provider gets a bounded retry and then holds", () => {
  const previous = {
    head,
    base,
    policyRevision,
    verdict: "unavailable",
    attempts: 1,
    attemptedAt: new Date(options.now).toISOString(),
  };
  assert.equal(routeReview({ ...options, previous }), "wait");
  assert.equal(routeReview({ ...options, previous, now: options.now + 300_001 }), "claude");
  assert.equal(
    routeReview({ ...options, previous: { ...previous, attempts: 2 }, now: options.now + 300_001 }),
    "held",
  );
});
test("coverage reductions cannot be approved by model output", () => {
  const filename = "Server/coverage-floor.json",
    before = JSON.stringify({ aggregate: 81.3, packages: { permissions: 100 }, exclude: ["cmd"] });
  assert.equal(
    reductions([
      {
        filename,
        before,
        after: JSON.stringify({
          aggregate: 81.4,
          packages: { permissions: 100 },
          exclude: ["cmd"],
        }),
      },
    ]).length,
    0,
  );
  for (const after of [
    { aggregate: 80, packages: { permissions: 100 } },
    { aggregate: 81.3, packages: {} },
    { aggregate: 81.3, packages: { permissions: 100 }, exclude: ["cmd", "auth"] },
  ])
    assert.ok(reductions([{ filename, before, after: JSON.stringify(after) }]).length);
});
test("expired quarantine renewal and scanner policy edits require a decision", () => {
  assert.ok(
    reductions([
      {
        filename: "Client/tests/e2e/quarantine.json",
        before: JSON.stringify({ quarantine: [] }),
        after: JSON.stringify({ quarantine: [{ file: "a", title: "b", expires: "2030-01-01" }] }),
      },
    ]).length,
  );
  assert.ok(reductions([{ filename: "osv-scanner.toml", before: "a", after: "b" }]).length);
});
test("incomplete or contradictory model output never passes", () => {
  const v = {
    verdict: "pass",
    integrity: "preserved",
    reviewed_paths: ["a"],
    findings: [],
    rationale: "Reviewed behavior",
  };
  assert.ok(acceptable(validateReview(v, [{ filename: "a" }])));
  assert.throws(() => validateReview(v, [{ filename: "b" }]));
  assert.throws(() =>
    validateReview(
      { ...v, findings: [{ path: "a", severity: "blocking", description: "Failure" }] },
      [{ filename: "a" }],
    ),
  );
  assert.equal(acceptable({ ...v, integrity: "reduced" }), false);
});
test("sensitive routing follows paths rather than the PR author's labels", () => {
  assert.equal(classify([{ filename: "Server/auth/session.go" }]).sensitive, true);
  assert.equal(classify([{ filename: ".github/workflows/ci.yml" }]).policy, true);
  assert.equal(classify([{ filename: "Client/tests/unit/a.test.ts" }]).testsChanged, true);
});
test("required check needs success; skipped, missing and foreign producer fail", () => {
  const c = {
    name: "A",
    id: 1,
    app: { id: 15368 },
    workflow_id: 10,
    status: "completed",
    conclusion: "success",
  };
  assert.ok(checksPassed([c], [], ["A"]));
  for (const patch of [{ conclusion: "skipped" }, { status: "in_progress" }, { app: { id: 1 } }])
    assert.equal(checksPassed([{ ...c, ...patch }], [], ["A"]), false);
  assert.equal(checksPassed([], [], ["A"]), false);
  assert.equal(
    checksPassed([c, { ...c, id: 2, status: "queued", conclusion: null }], [], ["A"]),
    false,
  );
  assert.ok(
    checksPassed(
      [
        { ...c, conclusion: "failure" },
        { ...c, id: 2 },
      ],
      [],
      ["A"],
    ),
  );
  assert.equal(
    checksPassed([c, { ...c, id: 2, workflow_id: 20, conclusion: "failure" }], [], ["A"]),
    false,
  );
});
test("activation requires strict branch protection and dedicated App source", () => {
  const checks = [
    ...CI_CHECKS.map((context) => ({ context, app_id: 15368 })),
    ...CHECKS.map((context) => ({ context, app_id: 42 })),
  ];
  const p = { required_status_checks: { strict: true, checks }, enforce_admins: { enabled: true } };
  assert.ok(enforcedProtection(p, 42));
  assert.equal(enforcedProtection(p, 43), false);
  assert.equal(
    enforcedProtection(
      { ...p, required_status_checks: { ...p.required_status_checks, strict: false } },
      42,
    ),
    false,
  );
});
test("receipt cannot be minted by an author-controlled Actions check", () => {
  const check = {
    id: 1,
    name: CHECKS[0],
    app: { id: 15368 },
    output: { summary: '```json\n{"verdict":"pass"}\n```' },
  };
  assert.equal(receipt([check], CHECKS[0], 42), null);
  assert.equal(receipt([{ ...check, app: { id: 42 } }], CHECKS[0], 42).verdict, "pass");
});
test("GitHub pagination and unavailable API fail closed", async () => {
  const api = new GitHub("test", "owner/repo", async () => ({ ok: false, status: 403 }));
  await assert.rejects(api.list("pulls"), /403/);
});
test("Claude receives data without tools, project discovery or GitHub credentials", async () => {
  const context = { files: [{ filename: "a" }], intent: "untrusted" };
  const prior = process.env.REVIEW_GITHUB_TOKEN;
  process.env.REVIEW_GITHUB_TOKEN = "must-not-enter-worker";
  try {
    const value = await reviewWithClaude(context, "correctness", async (args, opts) => {
      assert.ok(args.includes("--bare"));
      assert.equal(args[args.indexOf("--tools") + 1], "");
      assert.equal(opts.env.REVIEW_GITHUB_TOKEN, undefined);
      assert.ok(opts.input.includes('"intent":"untrusted"'));
      return {
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          session_id: "session",
          structured_output: {
            verdict: "pass",
            integrity: "preserved",
            reviewed_paths: ["a"],
            findings: [],
            rationale: "Reviewed",
          },
        }),
      };
    });
    assert.equal(value.provider, "claude");
  } finally {
    if (prior === undefined) delete process.env.REVIEW_GITHUB_TOKEN;
    else process.env.REVIEW_GITHUB_TOKEN = prior;
  }
});
test("fixer cannot change policy, generated files, unrelated code or path traversal", () => {
  const context = { files: [{ filename: "Client/src/a.ts", status: "modified" }] };
  assert.equal(
    validateRepair({ files: [{ path: "Client/src/a.ts", content: "fixed" }] }, context).length,
    1,
  );
  for (const path of [
    ".github/workflows/ci.yml",
    "scripts/pr-automation/main.mjs",
    "Client/src/other.ts",
    "../escape",
    "Client/src/lib/protocolTypes.ts",
  ]) {
    assert.throws(() => validateRepair({ files: [{ path, content: "bad" }] }, context));
  }
  assert.ok(
    validateRepair(
      { files: [{ path: "Client/tests/unit/regression.test.ts", content: "test" }] },
      context,
    ),
  );
});
test("fixer publication preserves ancestry and never force-pushes over a sibling", async () => {
  const writes = [];
  const api = {
    request: async (path, method, body) => {
      if (!method) {
        if (path === "pulls/1") return { state: "open", head: { sha: head }, base: { sha: base } };
        if (path.startsWith("git/commits/")) return { tree: { sha: "tree" } };
        if (path.startsWith("git/trees/"))
          return { tree: [{ path: "Client/src/a.ts", mode: "100644" }] };
      }
      writes.push({ path, body });
      if (path === "git/blobs") return { sha: "blob" };
      if (path === "git/trees") return { sha: "new-tree" };
      if (path === "git/commits") return { sha: "new-commit" };
      if (path.startsWith("git/refs/")) throw new Error("non-fast-forward");
    },
  };
  await assert.rejects(
    publishRepair(api, { number: 1, head: { sha: head, ref: "feature/a" }, base: { sha: base } }, [
      { path: "Client/src/a.ts", content: "fixed" },
    ]),
    /non-fast-forward/,
  );
  assert.deepEqual(writes.find((w) => w.path === "git/commits").body.parents, [head]);
  assert.deepEqual(writes.at(-1).body, { sha: "new-commit", force: false });
});
