import type { Page } from "@playwright/test";
import { seededTest as test, expect, signInAsOwner } from "./fixtures";
import { TEST_PASSWORD } from "../support/server";
import { Q1, findUnnamedControls, textContrast } from "../support/b9-accessibility";

// ARCH-10 stage 2: one real-server journey per regrouped admin page. The lone
// journey in admin-panel.spec.ts covers setup, the dashboard, channel CRUD,
// the audit log, support bundles and login. These fill the remaining
// destinations — Members, Roles, Emoji, Settings, Retention, Backups, Updates,
// Logs, Tokens, Plugins — each against a fresh real server and database, so a
// page that silently loses its data path fails here rather than in the field.

// A valid 1×1 PNG: the emoji route sniffs the type from the bytes, so a
// fabricated extension would be refused for the wrong reason.
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  "base64",
);

async function navigate(page: Page, label: string): Promise<void> {
  await page.locator(".nav-item", { hasText: label }).click();
}

test("Members: a pending applicant is approved through the Pending tab", async ({
  page,
  seededAdminServer,
}) => {
  const owner = seededAdminServer.owner;
  if (!owner) throw new Error("seeded server has no owner");
  // Approval mode makes the applicant wait for a decision, which is the path
  // this journey exercises.
  await seededAdminServer.api(
    "/admin/api/settings",
    { registration_mode: "approval" },
    owner.token,
    "PATCH",
  );
  await seededAdminServer.api("/api/v1/auth/register", {
    username: "applicant",
    password: TEST_PASSWORD,
  });

  await signInAsOwner(page, seededAdminServer);
  await navigate(page, "Members");
  await page.getByRole("tab", { name: "Pending" }).click();

  const applicantRow = page.locator(".tbl tbody tr", { hasText: "applicant" }).first();
  await expect(applicantRow).toBeVisible();
  await applicantRow.getByRole("button", { name: /Approve/ }).click();

  // A decision removes the application from the queue; the page re-renders on
  // the tab it was left on.
  await expect(page.locator(".members-empty")).toContainText("No registrations are waiting");

  // The member list holds active accounts only, so the applicant appearing
  // there proves the decision admitted them rather than denying them.
  await page.getByRole("tab", { name: "All" }).click();
  await expect(page.locator(".members-tbl tbody tr", { hasText: "applicant" })).toBeVisible();
});

test("Roles: a created role appears on the rank ladder", async ({ page, seededAdminServer }) => {
  await signInAsOwner(page, seededAdminServer);
  await navigate(page, "Roles & permissions");

  await page.getByRole("button", { name: "Create Role" }).click();
  await page.locator("#roleName").fill("e2e-custom-role");
  await page.locator(".modal-footer .btn-accent", { hasText: "Create" }).click();

  const rung = page.locator(".rank-rung", { hasText: "e2e-custom-role" });
  await expect(rung).toBeVisible();
});

test("Emoji: an uploaded emoji appears in the installed list", async ({
  page,
  seededAdminServer,
}) => {
  await signInAsOwner(page, seededAdminServer);
  await navigate(page, "Emoji");

  // Nothing installed yet: one line, not an empty table.
  await expect(page.locator(".empty-line")).toContainText("No custom emoji yet");
  await expect(page.locator(".tbl")).toHaveCount(0);

  await page.locator("#emojiShortcode").fill("e2etest");
  await page.locator("#emojiFile").setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: PIXEL_PNG,
  });
  await page.getByRole("button", { name: "Upload" }).click();

  await expect(page.locator(".tbl tbody tr", { hasText: ":e2etest:" })).toBeVisible();
});

test("Settings: a saved server name persists across a reload", async ({
  page,
  seededAdminServer,
}) => {
  await signInAsOwner(page, seededAdminServer);
  await navigate(page, "Settings");

  await page.locator("#s-server_name").fill("E2E Server");
  await page.locator("#saveSettingsBtn").click();
  await expect(page.locator("#topbarServer")).toHaveText("E2E Server");

  await page.reload();
  await expect(page.locator("#adminShell")).toBeVisible({ timeout: 10_000 });
  await navigate(page, "Settings");
  await expect(page.locator("#s-server_name")).toHaveValue("E2E Server");
});

test("Settings: registration is chosen from radio cards and persists", async ({
  page,
  seededAdminServer,
}) => {
  await signInAsOwner(page, seededAdminServer);
  await navigate(page, "Settings");

  const group = page.getByRole("group", { name: "Who can join" });
  await group.getByRole("radio", { name: /Approval/ }).check();
  await expect(page.locator("#settingsSaveState")).toHaveText("Unsaved changes");
  await page.locator("#saveSettingsBtn").click();
  await expect(page.locator("#settingsSaveState")).toHaveText("All changes saved");

  await page.reload();
  await expect(page.locator("#adminShell")).toBeVisible({ timeout: 10_000 });
  await navigate(page, "Settings");
  await expect(group.getByRole("radio", { name: /Approval/ })).toBeChecked();
  // Approval points at where waiting accounts are decided.
  await page.getByRole("button", { name: "Members › Pending" }).click();
  await expect(page.getByRole("tab", { name: /Pending/ })).toHaveAttribute("aria-selected", "true");
});

test("Retention: a server-wide window is previewed and applied", async ({
  page,
  seededAdminServer,
}) => {
  await signInAsOwner(page, seededAdminServer);
  await navigate(page, "Message retention");

  // The policy reads as a sentence; the number waits behind Change….
  await expect(page.locator(".ret-policy-big")).toHaveText("Messages are kept forever");
  await expect(page.locator("#retentionDays")).toBeHidden();
  const change = page.getByRole("button", { name: "Change…" });
  await change.click();
  await expect(change).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#retentionDays")).toBeFocused();
  await expect(page.locator(".ret-sweep")).toContainText(
    "Nothing will be deleted on the next sweep",
  );

  await page.locator("#retentionDays").fill("30");
  await page.getByRole("button", { name: "Preview change" }).click();
  await expect(
    page.locator("#modalInner h3", { hasText: "Confirm retention change" }),
  ).toBeVisible();
  await page.locator(".modal-footer .btn-danger", { hasText: "Apply window" }).click();

  await expect(page.locator(".ret-policy-big")).toHaveText("Messages are deleted after 30 days");
  await expect(page.locator("#retentionDays")).toHaveValue("30");

  // Only channels with their own rule are listed; none yet. The next-sweep
  // count lives with the field behind Change….
  await expect(page.locator(".empty-line")).toContainText("No channel has its own rule");
  await expect(page.locator(".empty-line")).toContainText("open Show all");
  await expect(page.locator(".ret-sweep")).toBeHidden();
  expect(await findUnnamedControls(page.locator("#content"))).toEqual([]);
  const { ratio } = await textContrast(page.locator(".ret-policy-sub"));
  expect(ratio).toBeGreaterThanOrEqual(Q1.text);
});

test("Retention: a channel exception is added and listed on its own", async ({
  page,
  seededAdminServer,
}) => {
  await signInAsOwner(page, seededAdminServer);
  await navigate(page, "Message retention");

  await page.locator(".ret-all > summary").click();
  const first = page.locator(".ret-all .ret-row").first();
  const channel = await first.locator("strong").textContent();
  await first.getByRole("button", { name: "Set exception" }).click();
  await page.locator("#chRetDays").fill("7");
  await page.getByRole("button", { name: "Preview override" }).click();
  await expect(
    page.locator("#modalInner h3", { hasText: "Confirm retention change" }),
  ).toBeVisible();
  await page.locator(".modal-footer .btn-danger", { hasText: "Apply window" }).click();

  const row = page.locator("section[aria-labelledby='ret-exc-h'] > .ret-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(channel ?? "");
  await expect(row).toContainText("7 days");
  await expect(page.locator(".ret-policy-sub")).toContainText("has its own rule");
});

test("Backups: a manual backup appears in the history", async ({ page, seededAdminServer }) => {
  await signInAsOwner(page, seededAdminServer);
  await navigate(page, "Backups & restore");

  // The page answers first: when the last backup was taken.
  await expect(page.locator("#backupStatus .status-line-title")).toBeVisible();

  await page.getByRole("button", { name: /Create backup now/ }).click();

  await expect(page.locator(".tbl tbody tr", { hasText: /\.db/ })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#backupStatus .status-line-title")).toContainText("Last backup");
  const { ratio } = await textContrast(page.locator("#backupStatus .status-line-sub"));
  expect(ratio).toBeGreaterThanOrEqual(Q1.text);
});

test("Updates: the page reports the current version and rechecks", async ({
  page,
  seededAdminServer,
}) => {
  // Release discovery is external to the panel and otherwise waits on GitHub;
  // the packaged-updater tests own that boundary. Every other route is real.
  await page.route("**/admin/api/updates", (route) =>
    route.fulfill({ json: { current: "dev", latest: "dev", update_available: false } }),
  );
  await signInAsOwner(page, seededAdminServer);
  await navigate(page, "Updates");

  // One line says whether this is current, with the version as the top bar
  // writes it.
  await expect(page.locator("#updateStatus .status-line-title")).toHaveText(
    "You are on the latest version",
  );
  await expect(page.locator("#updateStatus .status-line-sub")).toHaveText("Running dev.");

  const recheck = page.waitForResponse(
    (res) => res.url().endsWith("/admin/api/updates") && res.request().method() === "GET",
  );
  await page.getByRole("button", { name: /Check for updates/ }).click();
  await recheck;
});

test("Server logs: the live stream connects", async ({ page, seededAdminServer }) => {
  await signInAsOwner(page, seededAdminServer);
  await navigate(page, "Server logs");

  // A real SSE connection: the panel first mints a single-use ticket, then
  // opens the stream. "Connected" means the ticket route and stream both work.
  await expect(page.locator("#logStatusText")).toHaveText("Connected", { timeout: 15_000 });
  await expect(page.locator("#logDot")).toHaveClass(/dot-live/);
  // The connection state leads the toolbar, not the foot of the page.
  await expect(page.locator(".log-toolbar #logStatusText")).toBeVisible();

  // The backfill carries this session's own requests, as chips with the
  // full attrs behind a details toggle rather than inline JSON.
  const request = page.locator("#logOutput .log-line", { has: page.locator(".log-req") }).first();
  await expect(request).toBeVisible({ timeout: 15_000 });
  await expect(request.locator(".log-req")).toContainText("/admin/api/");
  await request.locator(".log-more > summary").click();
  await expect(request.locator(".log-more pre")).toContainText('"status"');
  const { ratio } = await textContrast(request.locator(".log-req"));
  expect(ratio).toBeGreaterThanOrEqual(Q1.text);

  // A level switched off is struck through, not only paler.
  const debug = page.locator('.level-toggle[data-level="DEBUG"]');
  await debug.click();
  await expect(debug).toHaveAttribute("aria-pressed", "false");
  await expect(debug).toHaveCSS("text-decoration-line", "line-through");
});

test("API tokens: a created token is shown once and listed", async ({
  page,
  seededAdminServer,
}) => {
  await signInAsOwner(page, seededAdminServer);
  await navigate(page, "API tokens");

  // No tokens yet: what one is for and the one action, not an empty table.
  await expect(page.locator(".empty-state h3")).toHaveText("No API tokens yet");
  await expect(page.locator(".tbl")).toHaveCount(0);

  await page.getByRole("button", { name: /Create Token/ }).click();
  await page.locator("#tokLabel").fill("e2e-token");
  await page.locator(".modal-footer .btn-accent", { hasText: "Create" }).click();

  await expect(page.locator("#modalInner h3", { hasText: "Token Created" })).toBeVisible();
  await expect(page.locator(".modal-body .code-copy code")).not.toHaveText("");
  await page.getByRole("button", { name: "Done" }).click();

  await expect(page.locator(".tbl tbody tr", { hasText: "e2e-token" })).toBeVisible();
});

test("Plugins: the page lists against the real plugin API", async ({ page, seededAdminServer }) => {
  await signInAsOwner(page, seededAdminServer);
  await navigate(page, "Plugins");

  await expect(page.locator(".page-title", { hasText: "Plugins" })).toBeVisible();
  // The e2e binary is built without the wazero tag, so the runtime is off and
  // the page must say so rather than offer an install that can only fail.
  await expect(
    page.locator(".section-card", { hasText: "Plugin runtime is disabled" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Installed" })).toBeVisible();
  // Nothing installed: one line, with no Refresh and no empty table.
  await expect(page.locator(".empty-line")).toContainText("No plugins installed");
  await expect(page.getByRole("button", { name: /Refresh/ })).toHaveCount(0);
});
