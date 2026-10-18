import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { GitHub, receipt } from "./github.mjs";
import { reviewWithClaude } from "./claude.mjs";
import { reductions } from "./integrity.mjs";
import { proposeRepair, publishRepair } from "./repair.mjs";
import {
  CHECKS,
  POLICY_VERSION,
  classify,
  codexObservation,
  routeReview,
  acceptable,
  checksPassed,
  enforcedProtection,
} from "./policy.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");

export async function snapshot(api, pr, base) {
  const files = await api.list(`pulls/${pr.number}/files`);
  if (files.length !== pr.changed_files || files.length > 100)
    throw new Error("Review scope exceeds supported complete snapshot");
  let bytes = 0;
  const source = [];
  for (const f of files) {
    if (f.status !== "removed" && typeof f.patch !== "string")
      throw new Error("Binary or truncated diff needs independent review");
    const before =
      f.status === "added"
        ? null
        : await api.content(f.previous_filename ?? f.filename, pr.base.sha);
    const after = f.status === "removed" ? null : await api.content(f.filename, pr.head.sha);
    bytes += Buffer.byteLength((before ?? "") + (after ?? "") + (f.patch ?? ""));
    if (bytes > 350_000) throw new Error("Review context exceeds supported limit");
    source.push({ filename: f.filename, status: f.status, patch: f.patch ?? "", before, after });
  }
  const context = {
    number: pr.number,
    head: pr.head.sha,
    base,
    intent: (pr.body ?? "").slice(0, 30_000),
    files: source,
  };
  return { context, diffDigest: hash(JSON.stringify(source)) };
}

export async function reviewPR(api, pr, options, reviewer = reviewWithClaude) {
  const { appID, policyRevision, now = Date.now() } = options;
  const base = pr.base.sha;
  const head = pr.head.sha;
  const comments = await api.list(`issues/${pr.number}/comments`);
  const ledgerComment = comments
    .filter(
      (c) =>
        c.performed_via_github_app?.id === appID &&
        c.body?.startsWith("<!-- owncord-controller-ledger:v1 -->"),
    )
    .sort((a, b) => b.id - a.id)[0];
  let ledger = {};
  if (ledgerComment) {
    // Corrupted durable state cannot silently reset the repair budget.
    try {
      ledger = JSON.parse(ledgerComment.body.split("\n")[1]);
      if (
        !Number.isInteger(ledger.rounds) ||
        ledger.rounds < 0 ||
        ledger.rounds > 3 ||
        !/^[a-f0-9]{40}$/.test(ledger.head ?? "") ||
        !/^[a-f0-9]{40}$/.test(ledger.base ?? "")
      )
        throw new Error("Invalid ledger binding");
    } catch {
      throw new Error("Unreadable controller ledger");
    }
  }
  const previous = receipt(await api.checks(head), CHECKS[0], appID);
  const sameScope =
    previous?.head === head &&
    previous?.base === base &&
    previous?.policyRevision === policyRevision;
  const reviews = await api.list(`pulls/${pr.number}/reviews`);
  const codex = codexObservation(comments, reviews, head);
  const firstSeenAt = sameScope
    ? (previous.firstSeenAt ?? new Date(now).toISOString())
    : new Date(now).toISOString();
  const route = routeReview({
    codex,
    previous,
    now,
    createdAt: firstSeenAt,
    head,
    base,
    policyRevision,
  });
  // A late finding invalidates an otherwise reusable pass.
  if (route === "reuse" && previous.codexFingerprint === codex.fingerprint) return previous;
  const rounds = ledger.rounds ?? 0;
  const binding = {
    head,
    base,
    policyRevision,
    firstSeenAt,
    policyVersion: POLICY_VERSION,
    verdict: "pending",
    rounds,
    attempts: sameScope ? (previous.attempts ?? 0) : 0,
  };
  let reservedRounds = rounds;
  let ledgerID = ledgerComment?.id;
  const save = async (state) => {
    const body = `<!-- owncord-controller-ledger:v1 -->\n${JSON.stringify({ head, base, rounds: state.rounds, verdict: state.verdict })}\n\nAutomated review: ${state.verdict}. See the required checks for the current commit. No author reply is treated as approval.`;
    const saved = await api.request(
      ledgerID ? `issues/comments/${ledgerID}` : `issues/${pr.number}/comments`,
      ledgerID ? "PATCH" : "POST",
      { body },
    );
    ledgerID = saved?.id ?? ledgerID;
  };
  if (rounds >= 3 && ledger.head === head && ledger.verdict === "held") {
    const state = { ...binding, verdict: "held" };
    await api.check(CHECKS[0], head, appID, "failure", "Automated repair budget exhausted", state);
    await api.check(CHECKS[1], head, appID, "failure", "Independent diagnosis required", state);
    await save(state);
    return state;
  }
  if (route === "held" || route === "wait") {
    await api.check(
      CHECKS[0],
      head,
      appID,
      route === "held" ? "failure" : "pending",
      route === "held" ? "Review attempts exhausted; follow-up required" : "Waiting for review",
      { ...binding, ...(sameScope ? { attemptedAt: previous.attemptedAt } : {}) },
    );
    await api.check(CHECKS[1], head, appID, "pending", "Waiting for integrity evidence", binding);
    return binding;
  }
  await api.check(CHECKS[0], head, appID, "pending", "Independent review in progress", binding);
  await api.check(CHECKS[1], head, appID, "pending", "Integrity assessment in progress", binding);
  try {
    const { context, diffDigest } = await snapshot(api, pr, base);
    const risk = classify(context.files);
    const results = [];
    // Codex supplies the ordinary correctness pass. Test/policy edits still
    // need an independent integrity pass; sensitive work always gets one.
    if (
      route === "claude" ||
      codex.findings ||
      risk.sensitive ||
      risk.policy ||
      risk.testsChanged
    ) {
      results.push(
        await reviewer(
          context,
          route === "codex"
            ? "test integrity and security invariants"
            : "correctness and behavioral regressions",
        ),
      );
    }
    if ((route === "claude" || codex.findings) && (risk.sensitive || risk.policy)) {
      results.push(
        await reviewer(context, "independent security, concurrency and test-integrity assessment"),
      );
    }
    const current = await api.request(`pulls/${pr.number}`);
    if (current.head.sha !== head || current.base.sha !== base || current.state !== "open")
      throw new Error("PR moved while being reviewed");
    const integrityReductions = reductions(context.files);
    const passed = results.every(acceptable) && integrityReductions.length === 0;
    // Public receipts carry counts/digests only; repository policy prohibits
    // publishing unfixed security details in comments or check output.
    const publicReviews = results.map((r) => ({
      provider: r.provider,
      session: r.session,
      models: r.models,
      verdict: r.verdict,
      integrity: r.integrity,
      reviewed_paths: r.reviewed_paths,
      blocking: r.findings.filter((f) => f.severity === "blocking").length,
      evidenceDigest: hash(JSON.stringify(r)),
    }));
    const state = {
      ...binding,
      diffDigest,
      codexFingerprint: codex.fingerprint,
      risk,
      provider: results.length ? (route === "codex" ? "codex+claude" : "claude") : "codex",
      verdict: passed ? "pass" : rounds >= 3 ? "held" : "changes_required",
      attempts: binding.attempts + 1,
      attemptedAt: new Date(now).toISOString(),
      integrityReductions,
      reviews: publicReviews,
    };
    await api.check(
      CHECKS[0],
      head,
      appID,
      passed ? "success" : "failure",
      passed ? "Final change reviewed" : "Independent review needs changes",
      state,
    );
    await api.check(
      CHECKS[1],
      head,
      appID,
      passed ? "success" : "failure",
      passed ? "Acceptance criteria preserved" : "Integrity or review findings need changes",
      state,
    );
    await save(state);
    // Shadow mode is observational. The fixer is a separate tool-free session;
    // its proposal cannot touch policy and never receives the App credential.
    if (
      !passed &&
      options.enforce &&
      rounds < 3 &&
      integrityReductions.length === 0 &&
      !risk.policy &&
      options.repair !== false
    ) {
      const changes = await (options.proposer ?? proposeRepair)(context, results);
      // Reserve the attempt BEFORE publication so a crash cannot reset it.
      state.rounds = rounds + 1;
      reservedRounds = state.rounds;
      await save(state);
      state.repairHead = await publishRepair(api, pr, changes);
      await save(state);
    }
    return state;
  } catch {
    const state = {
      ...binding,
      rounds: reservedRounds,
      attempts: binding.attempts + 1,
      attemptedAt: new Date(now).toISOString(),
      verdict: "unavailable",
    };
    await api.check(
      CHECKS[0],
      head,
      appID,
      "failure",
      "Review unavailable; bounded retry pending",
      state,
    );
    await api.check(CHECKS[1], head, appID, "failure", "No complete integrity evidence", state);
    await save(state);
    return state;
  }
}

export async function annotatedChecks(api, sha) {
  const [checks, runs] = await Promise.all([
    api.checks(sha),
    api.list(`actions/runs?head_sha=${sha}`, "workflow_runs"),
  ]);
  return checks.map((c) => {
    const id = Number(c.details_url?.match(/\/actions\/runs\/(\d+)/)?.[1]);
    return { ...c, workflow_id: runs.find((r) => r.id === id)?.workflow_id };
  });
}

export async function integrate(api, prs, options) {
  const { appID, policyRevision, enforce } = options;
  for (const pr of prs)
    await api.check(
      CHECKS[2],
      pr.head.sha,
      appID,
      "pending",
      enforce ? "Waiting for integration slot" : "Shadow mode; activation required",
      { head: pr.head.sha, base: pr.base.sha, policyRevision },
    );
  if (!enforce) return { action: "shadow" };
  const protection = await api.request("branches/dev/protection");
  if (!enforcedProtection(protection, appID))
    throw new Error("Required App-bound protection is not active");
  const dev = (await api.request("git/ref/heads/dev")).object.sha;
  const devRuns = await api.list(
    `actions/workflows/ci.yml/runs?event=push&head_sha=${dev}`,
    "workflow_runs",
  );
  if (
    !devRuns.some(
      (r) => r.head_sha === dev && r.status === "completed" && r.conclusion === "success",
    )
  )
    return { action: "dev_not_green" };
  for (const pr of prs) {
    const checks = await annotatedChecks(api, pr.head.sha);
    const approval = receipt(checks, CHECKS[0], appID);
    const integrity = receipt(checks, CHECKS[1], appID);
    if (
      approval?.verdict !== "pass" ||
      approval.head !== pr.head.sha ||
      approval.base !== pr.base.sha ||
      approval.policyRevision !== policyRevision ||
      integrity?.verdict !== "pass"
    )
      continue;
    const live = await api.request(`pulls/${pr.number}`);
    if (live.head.sha !== pr.head.sha || live.draft || live.state !== "open") continue;
    if (live.base.sha !== dev) continue;
    const compare = await api.request(`compare/${dev}...${live.head.sha}`);
    if (compare.merge_base_commit?.sha !== dev) {
      await api.request(`pulls/${pr.number}/update-branch`, "PUT", {
        expected_head_sha: live.head.sha,
      });
      return { action: "updated", number: pr.number };
    }
    const runs = await api.list(
      `actions/workflows/ci.yml/runs?head_sha=${live.head.sha}`,
      "workflow_runs",
    );
    const full = runs
      .filter((r) => r.event === "workflow_dispatch" && r.head_sha === live.head.sha)
      .sort((a, b) => b.id - a.id)[0];
    if (!full) {
      await api.request("actions/workflows/ci.yml/dispatches", "POST", { ref: live.head.ref });
      return { action: "validation_started", number: pr.number };
    }
    if (full.status !== "completed" || full.conclusion !== "success") continue;
    const rawStatuses = await api.list(`commits/${live.head.sha}/statuses`);
    const statuses = rawStatuses.filter(
      (s, i) => rawStatuses.findIndex((r) => r.context === s.context) === i,
    );
    if (!checksPassed(checks, statuses)) continue;
    const before = await api.request(`pulls/${pr.number}`);
    const tip = (await api.request("git/ref/heads/dev")).object.sha;
    if (before.head.sha !== live.head.sha || tip !== dev || before.base.sha !== dev)
      return { action: "moved" };
    await api.check(
      CHECKS[2],
      live.head.sha,
      appID,
      "success",
      "Current dev and final head validated",
      { head: live.head.sha, base: dev, policyRevision, run: full.id },
    );
    try {
      await api.request(`pulls/${pr.number}/merge`, "PUT", {
        sha: live.head.sha,
        merge_method: "squash",
      });
    } finally {
      // A failed merge must not leave an unlocked candidate behind. GitHub
      // auto-merge may already have merged it after readiness became green.
      const after = await api.request(`pulls/${pr.number}`);
      if (!after.merged)
        await api.check(
          CHECKS[2],
          live.head.sha,
          appID,
          "pending",
          "Merge requires fresh integration validation",
          { head: live.head.sha, base: dev, policyRevision },
        );
    }
    return { action: "merge_attempted", number: pr.number };
  }
  return { action: "waiting" };
}

export async function reconcile(api, options, reviewer = reviewWithClaude) {
  const open = await api.list("pulls?state=open&base=dev&sort=created&direction=asc");
  const prs = [];
  for (const item of open) {
    if (item.draft || item.head.repo?.full_name !== api.repository) continue;
    prs.push(await api.request(`pulls/${item.number}`));
  }
  // Revoke readiness for every current head before doing metered work.
  for (const pr of prs)
    await api.check(
      CHECKS[2],
      pr.head.sha,
      options.appID,
      "pending",
      "Awaiting controller validation",
      { head: pr.head.sha, base: pr.base.sha, policyRevision: options.policyRevision },
    );
  // One metered PR per tick. Others can still be considered for integration.
  for (const pr of prs) {
    const prior = receipt(await api.checks(pr.head.sha), CHECKS[0], options.appID);
    if (
      prior?.verdict === "pass" &&
      prior.head === pr.head.sha &&
      prior.base === pr.base.sha &&
      prior.policyRevision === options.policyRevision
    ) {
      // Read current provider findings, including late results, on every tick.
      const codex = codexObservation(
        await api.list(`issues/${pr.number}/comments`),
        await api.list(`pulls/${pr.number}/reviews`),
        pr.head.sha,
      );
      if (prior.codexFingerprint === codex.fingerprint) continue;
    }
    const result = await reviewPR(api, pr, options, reviewer);
    if (result.attemptedAt) break;
  }
  return integrate(api, prs, options);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const appID = Number(process.env.REVIEW_APP_ID);
  const policyRevision = process.env.REVIEW_POLICY_REVISION;
  if (!Number.isSafeInteger(appID) || appID <= 0 || !/^[a-f0-9]{40}$/.test(policyRevision ?? ""))
    throw new Error("Invalid trusted deployment identity");
  const api = new GitHub(process.env.REVIEW_GITHUB_TOKEN, process.env.GITHUB_REPOSITORY);
  const result = await reconcile(api, {
    appID,
    policyRevision,
    enforce: process.env.REVIEW_MODE === "enforce",
  });
  console.log(JSON.stringify(result));
}
