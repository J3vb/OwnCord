/**
 * Small steps the Command Deck specs share: the saved text size before boot,
 * a screenshot attached for the hand check, and a reflow audit held to a
 * baseline measured on dev.
 */
import type { Page, TestInfo } from "@playwright/test";
import { expect } from "../fixtures";
import type { ReflowAudit } from "./zoom-reflow";

/** Saves the Appearance text size before the app boots. */
export async function seedFontSize(page: Page, size: number): Promise<void> {
  await page.addInitScript((px) => {
    localStorage.setItem("owncord:settings:fontSize", JSON.stringify(px));
  }, size);
}

/** Takes a screenshot of the page and attaches it to the report as `name`. */
export async function attachShot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(name);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

/** Records the audit, then holds each count to the dev baseline's. Entries are
 *  compared by count, since the audit labels them by class and text. */
export function expectReflowNoWorse(
  testInfo: TestInfo,
  audit: ReflowAudit,
  baseline: ReflowAudit,
): void {
  testInfo.annotations.push({ type: "reflow", description: JSON.stringify(audit) });
  expect(audit.pageOverflow).toBeLessThanOrEqual(baseline.pageOverflow);
  expect(audit.clipped.length).toBeLessThanOrEqual(baseline.clipped.length);
  expect(audit.covered.length).toBeLessThanOrEqual(baseline.covered.length);
  expect(audit.twoDimensional.length).toBeLessThanOrEqual(baseline.twoDimensional.length);
}
