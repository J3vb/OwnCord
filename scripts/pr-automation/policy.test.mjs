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
  trustedEnvironment,
} from "./policy.mjs";
import { reductions } from "./integrity.mjs";
import { receipt, GitHub, installationCredentials } from "./github.mjs";
import { reviewWithClaude } from "./claude.mjs";
import { validateRepair, publishRepair } from "./repair.mjs";
import { sealEvidence, openEvidence, carriedFindings } from "./evidence.mjs";
import { generateKeyPairSync } from "node:crypto";

test("long-running review renews only the installation token and fails closed on renewal error", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let now = Date.parse("2026-10-18T10:00:00Z"),
    calls = 0;
  const credentials = installationCredentials(
    { token: "initial", appID: 42, installationID: 7, privateKey },
    async (url, init) => {
      calls++;
      assert.equal(url, "https://api.github.com/app/installations/7/access_tokens");
      const jwt = init.headers.Authorization.split(" ")[1];
      const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url"));
      assert.equal(claims.iss, 42);
      assert.ok(claims.exp * 1000 > now);
      assert.equal(JSON.parse(init.body).permissions.administration, "read");
      return {
        ok: true,
        json: async () => ({
          token: "renewed",
          expires_at: new Date(now + 3600_000).toISOString(),
        }),
      };
    },
    () => now,
  );
  assert.equal(await credentials(), "initial");
  assert.equal(calls, 0);
  now += 46 * 60_000;
  assert.equal(await credentials(), "renewed");
  assert.equal(calls, 1);
  assert.equal(await credentials(), "renewed");
  const unavailable = installationCredentials(
    { appID: 42, installationID: 7, privateKey },
    async () => ({ ok: false }),
    () => now,
  );
  await assert.rejects(unavailable(), /Cannot renew/);
});

test("a late clean provider result cannot erase a bound fallback finding", () => {
  const h = "a".repeat(40),
    b = "b".repeat(40),
    p = "c".repeat(40);
  const previous = {
    head: h,
    base: b,
    policyRevision: p,
    verdict: "changes_required",
    attempts: 1,
    attemptedAt: new Date(0).toISOString(),
  };
  assert.equal(
    routeReview({
      head: h,
      base: b,
      policyRevision: p,
      now: 1_800_000,
      createdAt: new Date(0).toISOString(),
      previous,
      codex: { completed: true, findings: false },
    }),
    "held",
  );
});
test("encrypted findings survive recovery without exposing their descriptions", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const finding = { path: "a", severity: "blocking", description: "private finding" };
  const evidence = { reviews: [{ findings: [finding] }] };
  const sealed = sealEvidence(evidence, privateKey);
  assert.equal(JSON.stringify(sealed).includes(finding.description), false);
  assert.deepEqual(openEvidence(sealed, privateKey), evidence);
  assert.equal(
    carriedFindings(openEvidence(sealed, privateKey))[0].description,
    finding.description,
  );
  assert.throws(() =>
    openEvidence({ ...sealed, tag: Buffer.alloc(16).toString("base64") }, privateKey),
  );
  const prior = { ...finding, id: "codex:1" };
  assert.equal(carriedFindings({ findings: [prior], reviews: [] }).length, 1);
  assert.equal(
    carriedFindings({
      findings: [prior],
      reviews: [
        {
          findings: [],
          finding_dispositions: [
            { id: prior.id, status: "resolved", evidence: "verified correction" },
          ],
        },
      ],
    }).length,
    0,
  );
});
test("a carried finding requires an explicit evidence-bearing disposition", () => {
  const finding = { id: "prior-1", path: "a", description: "old failure" };
  const value = {
    verdict: "pass",
    integrity: "preserved",
    reviewed_paths: ["a"],
    findings: [],
    rationale: "reviewed",
  };
  assert.throws(() => validateReview(value, [{ filename: "a" }], [finding]), /disposition/);
  const complete = {
    ...value,
    finding_dispositions: [
      {
        id: finding.id,
        status: "resolved",
        evidence: "negative control now covers the repaired path",
      },
    ],
  };
  assert.ok(acceptable(validateReview(complete, [{ filename: "a" }], [finding])));
});

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
  editor_verified: true,
  body: `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { commit_sha: sha, status: "completed", has_any_findings: false, has_unresolved_findings: false, ...state } })} -->`,
});

test("quota failure selects Claude immediately; an ordinary pending review waits", () => {
  assert.equal(routeReview({ ...options, now: 100, codex: { quota: true } }), "claude");
  assert.equal(routeReview({ ...options, now: 100 }), "wait");
  assert.equal(routeReview(options), "claude");
});
test("only authenticated, current connector completion certifies review", () => {
  assert.equal(
    codexObservation([{ ...summary(head), editor_verified: false }], [], head).completed,
    false,
  );
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
  for (const filename of [
    "Server/api/login.go",
    "Server/admin/handlers.go",
    "Server/config/config.go",
    "Server/plugin/http.go",
    "Server/main.go",
    "Client/src/lib/ws.ts",
    "Client/src/stores/auth.store.ts",
    "protocol/schema.json",
  ])
    assert.equal(classify([{ filename }]).sensitive, true, filename);
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
test("controller credentials belong to a main-only environment without routine approvals", () => {
  const env = {
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  };
  const policies = { branch_policies: [{ name: "main", type: "branch" }] };
  assert.ok(trustedEnvironment(env, policies));
  assert.equal(
    trustedEnvironment(env, {
      branch_policies: [...policies.branch_policies, { name: "*", type: "branch" }],
    }),
    false,
  );
  assert.equal(trustedEnvironment({ deployment_branch_policy: null }, policies), false);
  assert.equal(
    trustedEnvironment({ ...env, protection_rules: [{ type: "required_reviewers" }] }, policies),
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
test("provider comment edits are verified independently of the original author", async () => {
  for (const editor of [
    { __typename: "Bot", login: "chatgpt-codex-connector" },
    { __typename: "User", login: "J3vb" },
  ]) {
    const c = { id: 1, user: { login: CODEX_LOGIN, type: "Bot" }, body: "receipt" };
    const api = new GitHub("test", "owner/repo", async (url) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.endsWith("/graphql")
          ? {
              data: {
                repository: {
                  pullRequest: {
                    comments: {
                      nodes: [
                        {
                          databaseId: 1,
                          body: "receipt",
                          author: { __typename: "Bot", login: "chatgpt-codex-connector" },
                          editor,
                          lastEditedAt: "2026-10-18T00:00:00Z",
                        },
                      ],
                      pageInfo: { hasNextPage: false },
                    },
                  },
                },
              },
            }
          : [c],
    }));
    assert.equal((await api.comments(1))[0].editor_verified, editor.__typename === "Bot");
  }
});
test("missing provider edit provenance cannot certify a receipt", async () => {
  const api = new GitHub("test", "owner/repo", async (url) => ({
    ok: true,
    status: 200,
    json: async () => (url.endsWith("/graphql") ? { errors: [{ message: "unavailable" }] } : []),
  }));
  await assert.rejects(api.comments(1), /provenance/);
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
