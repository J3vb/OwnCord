import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewPR, integrate } from "./main.mjs";
import { CHECKS, CI_CHECKS } from "./policy.mjs";

const head = "a".repeat(40),
  base = "b".repeat(40),
  policyRevision = "c".repeat(40);
const options = {
  appID: 42,
  policyRevision,
  now: Date.parse("2026-10-18T10:00:00Z"),
  enforce: true,
  repair: false,
};
const pr = {
  number: 1,
  changed_files: 1,
  created_at: "2026-10-18T09:00:00Z",
  head: { sha: head, ref: "feature/a" },
  base: { sha: base },
  state: "open",
  draft: false,
};
const clean = {
  provider: "claude",
  session: "s",
  models: ["served-model"],
  verdict: "pass",
  integrity: "preserved",
  reviewed_paths: ["Server/auth/a.go"],
  findings: [],
  rationale: "Checked",
};
const checkReceipt = (name, state) => ({
  id: 1,
  name,
  app: { id: 42 },
  output: { summary: `\`\`\`json\n${JSON.stringify(state)}\n\`\`\`` },
});

function reviewAPI({
  live = pr,
  files = [{ filename: "Server/auth/a.go", status: "modified", patch: "@@ example" }],
  comments = [],
} = {}) {
  const written = [];
  return {
    written,
    checks: async () => [],
    list: async (path) =>
      path.endsWith("/files")
        ? files
        : path.includes("comments")
          ? [
              ...comments,
              {
                user: { login: "chatgpt-codex-connector[bot]", type: "Bot" },
                body: "You have reached your Codex usage limits for code reviews.",
              },
            ]
          : [],
    content: async () => "source",
    request: async (path, method) => (method ? {} : live),
    check: async (name, sha, app, status, title, state) => {
      written.push({ name, sha, status, state, title });
    },
  };
}
test("quota/unavailable Codex routes sensitive PR through two independent passes", async () => {
  const api = reviewAPI();
  let calls = 0;
  const state = await reviewPR(api, pr, options, async () => {
    calls++;
    return clean;
  });
  assert.equal(calls, 2);
  assert.equal(state.verdict, "pass");
  assert.equal(api.written.filter((c) => c.status === "success").length, 2);
});
test("a head moving during review cannot acquire success", async () => {
  const api = reviewAPI({ live: { ...pr, head: { ...pr.head, sha: base } } });
  const result = await reviewPR(api, pr, options, async () => clean);
  assert.equal(result.verdict, "unavailable");
  assert.equal(
    api.written.some((c) => c.status === "success"),
    false,
  );
});
test("unreadable or truncated scope and crashed reviewer fail closed", async () => {
  for (const api of [
    reviewAPI({ files: [] }),
    reviewAPI({ files: [{ filename: "a", status: "modified" }] }),
  ]) {
    const state = await reviewPR(api, pr, options, async () => {
      throw new Error("must not pass");
    });
    assert.equal(state.verdict, "unavailable");
    assert.equal(
      api.written.some((c) => c.status === "success"),
      false,
    );
  }
});
test("model approval cannot lower a deterministic coverage floor", async () => {
  const api = reviewAPI({
    files: [{ filename: "Client/coverage-floor.json", status: "modified", patch: "floor" }],
  });
  api.content = async (path, sha) => JSON.stringify({ aggregate: sha === head ? 80 : 93 });
  const result = await reviewPR(api, pr, options, async () => ({
    ...clean,
    reviewed_paths: ["Client/coverage-floor.json"],
  }));
  assert.equal(result.verdict, "changes_required");
  assert.ok(result.integrityReductions.length);
});
test("unfixed security descriptions never enter public receipts", async () => {
  const api = reviewAPI();
  await reviewPR(api, pr, options, async () => ({
    ...clean,
    verdict: "changes_required",
    findings: [{ path: "a", severity: "blocking", description: "PRIVATE-DETAIL" }],
    rationale: "PRIVATE-DETAIL",
  }));
  assert.equal(JSON.stringify(api.written).includes("PRIVATE-DETAIL"), false);
});
test("repair budget survives new heads and cannot be reset by author comments", async () => {
  const ledger = { head, base, verdict: "held", rounds: 3 };
  for (const app of [42, 99]) {
    const api = reviewAPI({
      comments: [
        {
          id: 1,
          performed_via_github_app: { id: app },
          body: `<!-- owncord-controller-ledger:v1 -->\n${JSON.stringify(ledger)}`,
        },
      ],
    });
    let calls = 0;
    const result = await reviewPR(api, pr, options, async () => {
      calls++;
      return clean;
    });
    assert.equal(result.verdict, app === 42 ? "held" : "pass");
    assert.equal(calls, app === 42 ? 0 : 2);
  }
});
test("failed repair publication retains its reserved budget", async () => {
  const api = reviewAPI();
  const written = [];
  const request = api.request;
  api.request = async (path, method, body) => {
    if (method && body?.body) written.push(body.body);
    if (path.startsWith("git/")) throw new Error("publish failed");
    return request(path, method, body);
  };
  const result = await reviewPR(
    api,
    pr,
    {
      ...options,
      repair: true,
      proposer: async () => [{ path: "Server/auth/a.go", content: "fixed" }],
    },
    async () => ({
      ...clean,
      verdict: "changes_required",
      findings: [{ path: "Server/auth/a.go", severity: "blocking", description: "private" }],
    }),
  );
  assert.equal(result.rounds, 1);
  assert.equal(JSON.parse(written.at(-1).split("\n")[1]).rounds, 1);
});

function integrationAPI({ strict = true, tip = base, full = true, devGreen = true } = {}) {
  const writes = [];
  const pass = { head, base, policyRevision, verdict: "pass" };
  const checks = [
    ...CHECKS.slice(0, 2).map((name) => checkReceipt(name, pass)),
    ...CI_CHECKS.map((name, i) => ({
      id: 100 + i,
      name,
      status: "completed",
      conclusion: "success",
      app: { id: 15368 },
      details_url: "https://github.com/owner/repo/actions/runs/10/job/100",
      check_suite: { id: 7 },
    })),
  ];
  return {
    writes,
    check: async (name, sha, app, status) => writes.push({ name, status }),
    checks: async () => checks,
    list: async (path) => {
      if (path.includes("event=push"))
        return devGreen ? [{ head_sha: base, status: "completed", conclusion: "success" }] : [];
      if (path.includes("actions/runs?")) return [{ id: 10, workflow_id: 3 }];
      if (path.includes("actions/workflows/ci.yml/runs"))
        return full
          ? [
              {
                id: 10,
                event: "workflow_dispatch",
                head_sha: head,
                status: "completed",
                conclusion: "success",
              },
            ]
          : [];
      return [];
    },
    request: async (path, method, body) => {
      if (method) {
        writes.push({ path, method, body });
        return {};
      }
      if (path === "branches/dev/protection")
        return {
          required_status_checks: {
            strict,
            checks: [
              ...CI_CHECKS.map((context) => ({ context, app_id: 15368 })),
              ...CHECKS.map((context) => ({ context, app_id: 42 })),
            ],
          },
          enforce_admins: { enabled: true },
        };
      if (path === "git/ref/heads/dev") return { object: { sha: tip } };
      if (path.startsWith("compare/")) return { merge_base_commit: { sha: base } };
      if (path === "pulls/1") return pr;
      throw new Error(`Unexpected ${path}`);
    },
  };
}
test("shadow mode makes no merge or branch update even with passing evidence", async () => {
  const api = integrationAPI();
  assert.equal((await integrate(api, [pr], { ...options, enforce: false })).action, "shadow");
  assert.equal(
    api.writes.some((w) => w.method),
    false,
  );
});
test("non-strict protection or red dev prevents integration", async () => {
  await assert.rejects(integrate(integrationAPI({ strict: false }), [pr], options), /protection/);
  const api = integrationAPI({ devGreen: false });
  assert.equal((await integrate(api, [pr], options)).action, "dev_not_green");
  assert.equal(
    api.writes.some((w) => w.method),
    false,
  );
});
test("integration dispatches full CI before permitting merge", async () => {
  const api = integrationAPI({ full: false });
  assert.equal((await integrate(api, [pr], options)).action, "validation_started");
  assert.equal(
    api.writes.some((w) => w.path?.endsWith("/merge")),
    false,
  );
  assert.equal(api.writes.find((w) => w.method)?.body.ref, "feature/a");
});
test("only selected final head is merged with expected-head protection", async () => {
  const api = integrationAPI();
  assert.equal((await integrate(api, [pr], options)).action, "merge_attempted");
  assert.deepEqual(api.writes.find((w) => w.path?.endsWith("/merge")).body, {
    sha: head,
    merge_method: "squash",
  });
});
test("base moving during final recheck never unlocks a candidate", async () => {
  const api = integrationAPI();
  const request = api.request;
  let reads = 0;
  api.request = async (path, ...rest) =>
    path === "git/ref/heads/dev"
      ? { object: { sha: ++reads === 1 ? base : head } }
      : request(path, ...rest);
  assert.equal((await integrate(api, [pr], options)).action, "moved");
  assert.equal(
    api.writes.some((w) => w.status === "success"),
    false,
  );
});
