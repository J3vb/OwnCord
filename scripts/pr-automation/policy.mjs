// Trusted controller policy. Deploy from a reviewed, immutable revision.
export const CHECKS = ["AI Review Gate", "Test Integrity Gate", "Merge Readiness Gate"];
export const CI_CHECKS = [
  "Server Build & Test (ubuntu-latest)",
  "Server Build & Test (windows-latest)",
  "Client Static Checks",
  "Client Unit Tests",
  "Rust Unit Tests",
  "Client E2E (Playwright)",
  "Client E2E (parity subset, blocking)",
  "Analyze (go)",
  "Analyze (javascript-typescript)",
  "Analyze (actions)",
  "Repository Hygiene",
  "Docs & Ledger Consistency",
  "Admin Panel E2E (real server)",
  "Client E2E (real server and media)",
  "Client E2E (Windows native)",
  "Workflow Security Lint",
  "Supply-chain Scan",
];
export const POLICY_VERSION = 1;
export const CODEX_LOGIN = "chatgpt-codex-connector[bot]";
export const REVIEW_TIMEOUT_MS = 20 * 60_000;
export const RETRY_MS = 5 * 60_000;
export const MAX_ATTEMPTS = 2;
export const SENSITIVE =
  /^(?:Server\/(?:api|admin|auth|permissions|safefetch|updater|migrations|ws|service|db|config|plugin)\/|Server\/[^/]+\.go$|protocol\/|Client\/src\/(?:lib\/|stores\/(?:auth|voice)\.|features\/voice\/e2ee|platform\/)|Client\/src-tauri\/|\.github\/|scripts\/pr-automation\/)/;
export const POLICY_PATH =
  /^(?:\.github\/|\.githooks\/|\.claude\/|\.codex\/|\.agents\/|scripts\/|(?:AGENTS|CLAUDE|SECURITY)\.md|(?:Client|Server)\/(?:coverage-floor\.json|scripts\/coverage-floor\.sh)|Client\/(?:vitest\.config|stryker.*config|tests\/e2e\/quarantine\.json)|osv-scanner\.toml|Client\/src-tauri\/(?:deny\.toml|\.cargo\/audit\.toml))/;

export function classify(files) {
  return {
    sensitive: files.some((f) => SENSITIVE.test(f.filename)),
    policy: files.some((f) => POLICY_PATH.test(f.filename)),
    testsChanged: files.some((f) => /(?:test|spec|baseline|allowlist)/i.test(f.filename)),
  };
}

export function codexObservation(comments, reviews, head) {
  // Completion comes only from the connector's machine receipt. Text/reactions
  // from an author, old-head receipts and unknown shapes never certify a head.
  let quota = false;
  const observations = [];
  let completed = false;
  let findings = false;
  for (const c of comments) {
    if (c.user?.login !== CODEX_LOGIN || c.user?.type !== "Bot") continue;
    if (/reached your Codex usage limits for code reviews/i.test(c.body ?? "")) quota = true;
    const match = (c.body ?? "").match(/<!-- codex-review-state:v1 (.+?) -->/);
    if (!match) continue;
    try {
      const state = JSON.parse(match[1]).code_review;
      if (state?.commit_sha !== head || state.status !== "completed") continue;
      if (
        typeof state.has_any_findings !== "boolean" ||
        typeof state.has_unresolved_findings !== "boolean"
      )
        continue;
      completed = true;
      findings ||= state.has_any_findings || state.has_unresolved_findings;
      observations.push([c.id, c.updated_at, state]);
    } catch {
      /* Unknown provider output selects the fallback. */
    }
  }
  // A review with findings must be independently reconciled even if a summary
  // was edited or a discussion thread was resolved by the author.
  findings ||= reviews.some(
    (r) =>
      r.user?.login === CODEX_LOGIN &&
      r.user?.type === "Bot" &&
      r.commit_id === head &&
      ["COMMENTED", "CHANGES_REQUESTED"].includes(r.state),
  );
  for (const r of reviews)
    if (r.user?.login === CODEX_LOGIN && r.user?.type === "Bot" && r.commit_id === head)
      observations.push([r.id, r.submitted_at, r.state]);
  return { quota, completed, findings, fingerprint: JSON.stringify(observations) };
}

export function routeReview({ codex, previous, now, createdAt, head, base, policyRevision }) {
  const bound =
    previous?.head === head &&
    previous?.base === base &&
    previous?.policyRevision === policyRevision;
  if (bound && previous.verdict === "pass") return "reuse";
  if (bound && previous.attempts >= MAX_ATTEMPTS) return "held";
  if (bound && previous.attemptedAt && now - Date.parse(previous.attemptedAt) < RETRY_MS)
    return "wait";
  if (codex.completed && !codex.findings) return "codex";
  if (codex.quota || codex.findings || now - Date.parse(createdAt) >= REVIEW_TIMEOUT_MS)
    return "claude";
  return "wait";
}

export const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "integrity", "reviewed_paths", "findings", "rationale"],
  properties: {
    verdict: { type: "string", enum: ["pass", "changes_required"] },
    integrity: {
      type: "string",
      enum: ["preserved", "equivalent_replacement", "reduced", "uncertain"],
    },
    reviewed_paths: { type: "array", items: { type: "string" } },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "severity", "description"],
        properties: {
          path: { type: "string" },
          severity: { type: "string", enum: ["blocking", "non_blocking"] },
          description: { type: "string" },
        },
      },
    },
    rationale: { type: "string" },
  },
};

export function validateReview(value, files) {
  if (
    !value ||
    !["pass", "changes_required"].includes(value.verdict) ||
    !["preserved", "equivalent_replacement", "reduced", "uncertain"].includes(value.integrity)
  )
    throw new Error("Invalid review verdict");
  if (
    !Array.isArray(value.reviewed_paths) ||
    !files.every((f) => value.reviewed_paths.includes(f.filename))
  )
    throw new Error("Incomplete review coverage");
  if (
    !Array.isArray(value.findings) ||
    typeof value.rationale !== "string" ||
    !value.rationale.trim()
  )
    throw new Error("Missing review evidence");
  for (const f of value.findings)
    if (
      !f ||
      typeof f.path !== "string" ||
      typeof f.description !== "string" ||
      !f.description.trim() ||
      !["blocking", "non_blocking"].includes(f.severity)
    )
      throw new Error("Invalid finding");
  if (value.verdict === "pass" && value.findings.some((f) => f.severity === "blocking"))
    throw new Error("Contradictory review verdict");
  return value;
}

export function acceptable(value) {
  return (
    value.verdict === "pass" &&
    ["preserved", "equivalent_replacement"].includes(value.integrity) &&
    !value.findings.some((f) => f.severity === "blocking")
  );
}

export function checksPassed(checks, statuses, names = CI_CHECKS) {
  // A pending replacement defeats an old success. Independent same-name
  // workflows do not collapse into an accidental success.
  return names.every((name) => {
    const matching = checks.filter((c) => c.name === name);
    const groups = new Map();
    for (const c of matching) {
      const key = `${c.app?.id}:${c.workflow_id ?? c.check_suite?.id ?? c.id}`;
      const prior = groups.get(key);
      if (!prior || c.id > prior.id) groups.set(key, c);
    }
    return (
      groups.size > 0 &&
      [...groups.values()].every(
        (c) => c.app?.id === 15368 && c.status === "completed" && c.conclusion === "success",
      ) &&
      !statuses.some((s) => s.context === name && s.state !== "success")
    );
  });
}

export function enforcedProtection(protection, appID) {
  const r = protection.required_status_checks;
  return (
    r?.strict === true &&
    protection.enforce_admins?.enabled === true &&
    CI_CHECKS.every((name) => r.checks?.some((c) => c.context === name && c.app_id === 15368)) &&
    CHECKS.every((name) => r.checks?.some((c) => c.context === name && c.app_id === appID))
  );
}
