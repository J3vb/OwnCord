import { test, expect } from "./fixtures";
import { mockTauriFullSession, submitLogin, emitWsMessage, MOCK_READY_PAYLOAD } from "./helpers";

test("connection overlay shows authenticated state until server data is ready", async ({
  page,
}) => {
  // Hold READY at the transport boundary so a busy runner cannot miss the
  // short-lived overlay while checking several independent fields.
  await mockTauriFullSession(page, { deferReady: true });
  await page.goto("/");
  await submitLogin(page);
  const overlay = page.getByTestId("connected-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay.locator(".connected-text")).toHaveText("Connected!");
  await expect(overlay.locator(".connected-user")).toContainText("testuser");
  await expect(overlay.locator(".connected-srv-icon")).toBeVisible();
  await expect(overlay.locator(".connected-loader .spinner")).toBeVisible();
  await expect(page.getByTestId("app-layout")).not.toBeVisible();
  await emitWsMessage(page, MOCK_READY_PAYLOAD);
  await expect(overlay.locator(".connected-loader")).toContainText("Ready!");
  await expect(page.getByTestId("app-layout")).toBeVisible();
  await expect(overlay).toHaveCount(0);
});
