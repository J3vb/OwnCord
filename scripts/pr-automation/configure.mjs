import { GitHub } from "./github.mjs";
import { CHECKS, enforcedProtection, trustedEnvironment } from "./policy.mjs";
import { execFileSync } from "node:child_process";

const appID = Number(process.env.REVIEW_APP_ID);
if (!Number.isSafeInteger(appID) || appID <= 0)
  throw new Error("Set REVIEW_APP_ID to the installed App ID");
if (!process.argv.includes("--check") && !process.argv.includes("--apply"))
  throw new Error("Use --check or --apply");
const api = new GitHub(
  process.env.GH_TOKEN ??
    execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim(),
  process.env.GITHUB_REPOSITORY ?? "J3vb/OwnCord",
);
if (
  !trustedEnvironment(
    await api.request("environments/pr-automation"),
    await api.request("environments/pr-automation/deployment-branch-policies"),
  )
)
  throw new Error("Set up the main-only controller environment first");
const p = await api.request("branches/dev/protection");
if (process.argv.includes("--apply")) {
  const checks = [
    ...p.required_status_checks.checks.filter((c) => !CHECKS.includes(c.context)),
    ...CHECKS.map((context) => ({ context, app_id: appID })),
  ];
  // PATCH the checks subresource: preserve every unrelated protection setting.
  await api.request("branches/dev/protection/required_status_checks", "PATCH", {
    strict: true,
    checks,
  });
}
const current = await api.request("branches/dev/protection");
if (!enforcedProtection(current, appID)) {
  console.error(
    "Not ready: verify all existing checks, App-bound automation checks, strict mode and administrator enforcement",
  );
  process.exitCode = 1;
} else console.log("Automation branch protection is ready");
