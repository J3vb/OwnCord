import { test, expect } from "@playwright/test";
import {
  mockTauriConnect,
  mockTauriFullSessionWithMessages,
  navigateToMainPageReady,
  openSettings,
} from "./helpers";

// ---------------------------------------------------------------------------
// Tests: accessibility smoke over the modal/overlay stack (DC-13)
//
// Axe-style structural checks in the real app — dialog roles, focus
// containment and restore, live regions — asserting the contract the DC-13
// pass established (lib/a11y.ts + modalFactory + the hand-rolled overlays).
// Unit tests cover each component's semantics exhaustively; this smoke proves
// the wiring holds end-to-end in the running app.
// ---------------------------------------------------------------------------

test.describe("A11y smoke — dialogs, focus, live regions", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSessionWithMessages(page);
    await page.goto("/");
    await navigateToMainPageReady(page);
  });

  test("settings overlay is a labelled dialog with a tablist, and Escape restores focus to the opener", async ({
    page,
  }) => {
    await openSettings(page);

    const panel = page.locator(".settings-panel");
    await expect(panel).toHaveAttribute("role", "dialog");
    await expect(panel).toHaveAttribute("aria-modal", "true");
    await expect(page.locator(".settings-sidebar")).toHaveAttribute("role", "tablist");
    // Roving tabindex: exactly one tab is tabbable.
    await expect(page.locator('.settings-nav-item[tabindex="0"]')).toHaveCount(1);
    // The content pane is the labelled tabpanel of the active tab.
    const activeTabId = await page
      .locator('.settings-nav-item[aria-selected="true"]')
      .getAttribute("id");
    await expect(page.locator(".settings-content")).toHaveAttribute(
      "aria-labelledby",
      activeTabId ?? "",
    );

    await page.keyboard.press("Escape");
    await expect(panel).not.toBeVisible();
    // Focus returned to the gear button that opened the overlay.
    const active = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    expect(active).toBe("Settings");
  });

  test("quick switcher is a dialog wired as a combobox over a listbox", async ({ page }) => {
    await page.keyboard.press("Control+k");

    const switcher = page.locator(".quick-switcher");
    await expect(switcher).toHaveAttribute("role", "dialog");
    await expect(switcher).toHaveAttribute("aria-modal", "true");

    const input = page.locator(".quick-switcher__input");
    await expect(input).toHaveAttribute("role", "combobox");
    await expect(input).toHaveAttribute("aria-controls", "quick-switcher-results");
    await expect(page.locator("#quick-switcher-results")).toHaveAttribute("role", "listbox");

    // The active option is exposed to the input via aria-activedescendant.
    await input.fill("gen");
    const activeOption = page.locator('.quick-switcher__item[aria-selected="true"]').first();
    await expect(activeOption).toBeVisible();
    const optionId = await activeOption.getAttribute("id");
    await expect(input).toHaveAttribute("aria-activedescendant", optionId ?? "");

    await page.keyboard.press("Escape");
    await expect(page.locator(".quick-switcher-overlay")).toHaveCount(0);
  });

  test("a factory modal (member picker) traps Tab inside the dialog", async ({ page }) => {
    // Open the DM member picker via the "+" on the embedded DM section.
    const newDmBtn = page.locator(".sidebar-dm-section .category-add-btn");
    await expect(newDmBtn).toBeVisible({ timeout: 5_000 });
    await newDmBtn.click();

    const modal = page.locator(".dm-member-picker-modal");
    await expect(modal).toBeVisible({ timeout: 5_000 });
    await expect(modal).toHaveAttribute("role", "dialog");
    await expect(modal).toHaveAttribute("aria-modal", "true");

    // Focus stays inside the dialog across many Tab presses.
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
    }
    const focusInside = await page.evaluate(() => {
      const modalEl = document.querySelector(".dm-member-picker-modal");
      return modalEl !== null && modalEl.contains(document.activeElement);
    });
    expect(focusInside).toBe(true);

    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
  });

  test("toast and typing surfaces are polite live regions", async ({ page }) => {
    await expect(page.locator(".toast-container")).toHaveAttribute("aria-live", "polite");
    await expect(page.locator(".toast-container")).toHaveAttribute("role", "status");
    await expect(page.locator(".typing-bar")).toHaveAttribute("aria-live", "polite");
  });
});

test.describe("A11y smoke — cert trust ceremony", () => {
  test("the first-use trust modal is a labelled dialog and takes focus", async ({ page }) => {
    await mockTauriConnect(page);
    await page.goto("/");
    await expect(page.locator(".connect-page")).toBeVisible();

    await page.waitForFunction(
      () =>
        ((window as unknown as { __tauriEventListeners: Record<string, unknown[]> })
          .__tauriEventListeners["cert-tofu"]?.length ?? 0) > 0,
    );
    await page.evaluate(() => {
      (window as unknown as { __tauriEmitEvent: (e: string, d: unknown) => void }).__tauriEmitEvent(
        "cert-tofu",
        { host: "myserver.example:8443", fingerprint: "AA:BB:CC:DD", status: "first_use" },
      );
    });

    const modal = page.locator(".modal");
    await expect(modal).toBeVisible();
    await expect(modal).toHaveAttribute("role", "dialog");
    await expect(modal).toHaveAttribute("aria-modal", "true");
    await expect(modal).toHaveAttribute("aria-labelledby", "cert-first-use-title");
    await expect(page.locator("#cert-first-use-title")).toHaveText("New Server Certificate");

    // The dialog took focus on open (its first focusable control).
    const focusInside = await page.evaluate(() => {
      const modalEl = document.querySelector(".modal");
      return modalEl !== null && modalEl.contains(document.activeElement);
    });
    expect(focusInside).toBe(true);

    // Escape is the safe reject: the modal closes, nothing is trusted.
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    const accepted = await page.evaluate(() =>
      (window as unknown as { __invokeLog: Array<{ cmd: string }> }).__invokeLog.some(
        (e) => e.cmd === "accept_cert_fingerprint",
      ),
    );
    expect(accepted).toBe(false);
  });
});
