import type { Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures";

// One atomic user journey with a fresh process/database on EVERY attempt.
// Retries must replay setup, not silently replace the wizard with login.

const OWNER = { username: "e2e-owner", password: "e2e-owner-pass-123" };

async function navigate(page: Page, label: string): Promise<void> {
  await page.locator(".nav-item", { hasText: label }).click();
}

test("admin setup, channel CRUD, audit and login journey", async ({ page }) => {
  // Release discovery is external to this CRUD journey and otherwise waits on GitHub.
  // Packaged updater tests own the update boundary. All setup/data routes stay real.
  await page.route("**/admin/api/updates", (route) =>
    route.fulfill({ json: { current: "dev", latest: "dev", update_available: false } }),
  );
  await test.step("first-run wizard creates the owner and lands on the dashboard", async () => {
    await page.goto("/admin/");

    await expect(page.locator("#setupOverlay.visible")).toBeVisible();
    await page.locator("#wizardBox .btn-accent", { hasText: "Get Started" }).click();

    // Account step.
    await page.locator("#wizUser").fill(OWNER.username);
    await page.locator("#wizPass").fill(OWNER.password);
    await page.locator("#wizConfirm").fill(OWNER.password);

    // Advance through server/uploads/registration/review without touching
    // the prefilled values — they mirror the running config, so nothing
    // changes and the server does not restart (restart_required false).
    // Steps: 1 account → 2 server → 3 uploads/voice → 4 registration → 5
    // review; the fifth click is Finish, which disables the button into a
    // spinner while POST /admin/api/setup runs.
    const next = page.locator("#wizNextBtn");
    for (let i = 0; i < 4; i++) {
      await next.click();
    }
    await next.click(); // Finish

    await expect(page.locator("#setupSuccessOverlay")).toBeVisible({ timeout: 15_000 });
    // The invite code is the server's proof the owner + seed data exist.
    await expect(page.locator("#inviteCode")).not.toHaveText("");
    await page.locator("#setupContinueBtn").click();

    await expect(page.locator("#adminShell")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".page-title", { hasText: "Dashboard" })).toBeVisible();
  });

  await test.step("dashboard renders live stats — exactly one registered user", async () => {
    await page.goto("/admin/");
    // Token persisted in localStorage by the wizard → straight into the app.
    await expect(page.locator("#adminShell")).toBeVisible({ timeout: 10_000 });

    const usersCard = page.locator(".stat-card", { hasText: "Total Users" });
    await expect(usersCard.locator(".stat-card-value")).toHaveText("1");
  });

  await test.step("channel create shows up in the channel table", async () => {
    await page.goto("/admin/");
    await expect(page.locator("#adminShell")).toBeVisible({ timeout: 10_000 });

    await navigate(page, "Channels");
    await page.locator("button", { hasText: "Create Channel" }).click();
    await page.locator("#chName").fill("e2e-lounge");
    await page.locator(".modal-footer .btn-accent", { hasText: "Create" }).click();

    await expect(page.locator(".tbl tbody tr", { hasText: "e2e-lounge" })).toBeVisible();
  });

  await test.step("channel edit renames it in place", async () => {
    await page.goto("/admin/");
    await expect(page.locator("#adminShell")).toBeVisible({ timeout: 10_000 });
    await navigate(page, "Channels");

    const row = page.locator(".tbl tbody tr", { hasText: "e2e-lounge" }).first();
    await row.locator(".act-btn[title='Edit']").click();
    await page.locator("#chEditName").fill("e2e-lounge-renamed");
    await page.locator(".modal-footer .btn-accent", { hasText: "Save" }).click();

    await expect(page.locator(".tbl tbody tr", { hasText: "e2e-lounge-renamed" })).toBeVisible();
  });

  await test.step("audit log records the channel mutations", async () => {
    await page.goto("/admin/");
    await expect(page.locator("#adminShell")).toBeVisible({ timeout: 10_000 });

    await navigate(page, "Audit Log");
    await expect(page.locator(".badge", { hasText: "channel_create" }).first()).toBeVisible();
    await expect(page.locator(".badge", { hasText: "channel_update" }).first()).toBeVisible();
  });

  await test.step("support preview requires confirmation and downloads the exact reviewed archive", async () => {
    await navigate(page, "Diagnostics");
    const downloads: string[] = [];
    const onDownload = (download: { suggestedFilename(): string }) =>
      downloads.push(download.suggestedFilename());
    page.on("download", onDownload);
    try {
      const response = page.waitForResponse(
        (res) =>
          res.url().endsWith("/support-bundles/preview") && res.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Create support bundle preview" }).click();
      const previewResponse = await response;
      expect(previewResponse.ok()).toBe(true);
      const preview = (await previewResponse.json()) as { byte_size: number; sha256: string };
      await expect(page.locator("#support-preview")).toBeVisible();
      await expect(page.locator("#support-preview")).toContainText(`${preview.byte_size} bytes`);
      await expect(page.locator("#support-preview")).toContainText(preview.sha256);
      await expect(page.locator("#support-preview")).toContainText("Redaction report");
      expect(downloads).toEqual([]);
      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: "Confirm download" }).click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe("owncord-support.zip");
      const file = await download.path();
      expect(file).not.toBeNull();
      const bytes = readFileSync(file!);
      expect(bytes.length).toBe(preview.byte_size);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(preview.sha256);
      await expect(page.locator("#support-preview")).toHaveCount(0);
      await navigate(page, "Audit Log");
      await expect(page.locator(".badge", { hasText: "support_bundle_create" })).toBeVisible();
    } finally {
      page.off("download", onDownload);
    }
  });

  await test.step("logout returns to the login overlay; owner can sign back in", async () => {
    await page.goto("/admin/");
    await expect(page.locator("#adminShell")).toBeVisible({ timeout: 10_000 });

    await page.locator(".nav-item", { hasText: "Sign Out" }).click();
    await expect(page.locator("#loginOverlay")).toBeVisible();

    await page.locator("#loginUser").fill(OWNER.username);
    await page.locator("#loginPass").fill(OWNER.password);
    await page.locator("#loginBtn").click();

    await expect(page.locator("#adminShell")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".page-title", { hasText: "Dashboard" })).toBeVisible();
  });
});
