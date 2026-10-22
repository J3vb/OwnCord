import { test, expect } from "./fixtures";
import { installRealTransport } from "../support/real-transport";
import { TEST_PASSWORD } from "../support/server";

test("a login with the default boxes stays signed in across a restart", async ({
  page,
  server,
}) => {
  const transport = await installRealTransport(page, server);
  try {
    await page.goto("/");
    await page.locator("#host").fill(`127.0.0.1:${server.port}`);
    await page.locator("#username").fill("alice");
    await page.locator("#password").fill(TEST_PASSWORD);
    // The defaults: Auto connect ticked, Remember password unticked.
    await expect(page.locator("#auto-connect")).toBeChecked();
    await expect(page.locator("#remember-password")).not.toBeChecked();
    await page.locator("button[type='submit']").click();
    await expect(page.getByTestId("app-layout")).toBeVisible();

    // A relaunch resumes the stored token: the main page, never the form.
    await page.goto("/");
    await expect(page.getByTestId("app-layout")).toBeVisible();
    await expect(page.locator("#password")).toHaveCount(0);
  } finally {
    await transport.close();
    expect(transport.errors).toEqual([]);
  }
});
