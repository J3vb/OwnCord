import { test, expect, type Page } from "@playwright/test";
import { mockTauriConnect, mockTauriFullSession, navigateToMainPage } from "./helpers";

// ---------------------------------------------------------------------------
// Tests: TOFU certificate ceremony (first-use confirmation + mismatch warning)
//
// The Rust proxies emit a `cert-tofu` Tauri event when a server presents an
// unpinned or changed TLS certificate; main.ts turns that into the blocking
// first-use / mismatch modals. This is the client's core security ceremony,
// previously covered only at unit level (DC-04).
// ---------------------------------------------------------------------------

interface CertTofuPayload {
  host: string;
  fingerprint: string;
  status: "first_use" | "trusted" | "mismatch";
  storedFingerprint?: string;
}

// The real Tauri event system delivers a deserialized object payload, so this
// bypasses emitWsEvent (which stringifies) and emits the object directly.
// startCertListener registers via an async invoke roundtrip at bootstrap, so
// wait for the listener before emitting instead of racing it.
async function emitCertTofu(page: Page, payload: CertTofuPayload): Promise<void> {
  await page.waitForFunction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => ((window as any).__tauriEventListeners?.["cert-tofu"]?.length ?? 0) > 0,
  );
  await page.evaluate((data) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__tauriEmitEvent("cert-tofu", data);
  }, payload);
}

const FIRST_USE: CertTofuPayload = {
  host: "myserver.example:8443",
  fingerprint: "AA:BB:CC:DD:EE:FF:00:11",
  status: "first_use",
};

const MISMATCH: CertTofuPayload = {
  host: "myserver.example:8443",
  fingerprint: "99:88:77:66:55:44:33:22",
  storedFingerprint: "AA:BB:CC:DD:EE:FF:00:11",
  status: "mismatch",
};

test.describe("Cert TOFU — first use", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriConnect(page);
    await page.goto("/");
    await expect(page.locator(".connect-page")).toBeVisible();
  });

  test("first-use event shows the confirmation modal with host and fingerprint", async ({
    page,
  }) => {
    await emitCertTofu(page, FIRST_USE);

    await expect(page.locator("h3", { hasText: "New Server Certificate" })).toBeVisible();
    await expect(
      page.locator(".cert-fingerprint", { hasText: FIRST_USE.fingerprint }),
    ).toBeVisible();
    await expect(page.locator(".cert-details")).toContainText(FIRST_USE.host);
  });

  test("trusting the certificate dismisses the modal", async ({ page }) => {
    await emitCertTofu(page, FIRST_USE);
    await expect(page.locator("h3", { hasText: "New Server Certificate" })).toBeVisible();

    await page.locator("button", { hasText: "Trust This Certificate" }).click();

    await expect(page.locator("h3", { hasText: "New Server Certificate" })).toBeHidden();
    // The ceremony never leaves the connect page — trusting only pins the cert.
    await expect(page.locator(".connect-page")).toBeVisible();
  });

  test("cancelling leaves the host untrusted and closes the modal", async ({ page }) => {
    await emitCertTofu(page, FIRST_USE);
    await expect(page.locator("h3", { hasText: "New Server Certificate" })).toBeVisible();

    await page.locator(".modal-footer button", { hasText: "Cancel" }).click();

    await expect(page.locator("h3", { hasText: "New Server Certificate" })).toBeHidden();
    await expect(page.locator(".connect-page")).toBeVisible();
  });

  test("a second cert event cannot stack a second modal", async ({ page }) => {
    await emitCertTofu(page, FIRST_USE);
    await emitCertTofu(page, FIRST_USE);

    await expect(page.locator(".modal-overlay")).toHaveCount(1);
  });
});

test.describe("Cert TOFU — mismatch", () => {
  test.beforeEach(async ({ page }) => {
    await mockTauriFullSession(page);
    await page.goto("/");
    await navigateToMainPage(page);
  });

  test("mismatch event shows the warning with previous and current fingerprints", async ({
    page,
  }) => {
    await emitCertTofu(page, MISMATCH);

    await expect(page.locator("h3", { hasText: "Certificate Warning" })).toBeVisible();
    const details = page.locator(".cert-details");
    await expect(details).toContainText("Previous");
    await expect(details).toContainText(MISMATCH.storedFingerprint ?? "");
    await expect(details).toContainText("Current");
    await expect(details).toContainText(MISMATCH.fingerprint);
  });

  test("disconnect on mismatch returns to the connect page", async ({ page }) => {
    await emitCertTofu(page, MISMATCH);
    await expect(page.locator("h3", { hasText: "Certificate Warning" })).toBeVisible();

    await page.locator(".modal-footer button", { hasText: "Disconnect" }).click();

    await expect(page.locator("h3", { hasText: "Certificate Warning" })).toBeHidden();
    await expect(page.locator(".connect-page")).toBeVisible();
  });
});
