import { describe, it, expect, vi } from "vitest";
import * as mocks from "../helpers/connectPageMocks";
import { mountTotpOverlay } from "../helpers/connectPageHarness";
import { useMountContainer } from "../helpers/mountContainer";
import {
  ApiClientError,
  appealLine,
  errorText,
  httpError,
  signInErrorText,
} from "../../src/lib/api";
import { parseRelayedLogin } from "../../src/features/connection/credentials";
import { connectText } from "../../src/i18n/connect";

vi.mock("../../src/features/connection/credentials", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/features/connection/credentials")>()),
  ...mocks.netCredentialsMock(),
}));
vi.mock("../../src/features/settings/SettingsOverlay", () => mocks.settingsOverlayMock());

const SUSPENDED = "your account has been suspended";

describe("appeal contact on the ban refusal", () => {
  it("adds the appeal line to a ban refusal that carried a contact", () => {
    const err = httpError(403, "FORBIDDEN", SUSPENDED, undefined, "owner@example.test");
    expect(appealLine(err)).toBe(
      connectText("error.bannedAppeal", { contact: "owner@example.test" }),
    );
    expect(signInErrorText(err, "fallback")).toBe(
      `${connectText("error.banned")}\n${connectText("error.bannedAppeal", { contact: "owner@example.test" })}`,
    );
  });

  it("adds nothing without a contact, or on any other refusal", () => {
    expect(appealLine(httpError(403, "FORBIDDEN", SUSPENDED))).toBeNull();
    expect(appealLine(httpError(403, "FORBIDDEN", SUSPENDED, undefined, "  "))).toBeNull();
    expect(
      appealLine(httpError(403, "FORBIDDEN", "account is awaiting approval", undefined, "x")),
    ).toBeNull();
    expect(
      appealLine(httpError(401, "UNAUTHORIZED", "invalid credentials", undefined, "x")),
    ).toBeNull();
    expect(appealLine(new Error("boom"))).toBeNull();
    expect(errorText(httpError(403, "FORBIDDEN", SUSPENDED, undefined, "x"), "f")).toBe(
      connectText("error.banned"),
    );
  });

  it("reads the contact off a relayed saved-password login refusal", () => {
    let caught: unknown;
    try {
      parseRelayedLogin({
        status: 403,
        body: JSON.stringify({
          error: "FORBIDDEN",
          message: SUSPENDED,
          appeal_contact: "me@x.test",
        }),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiClientError);
    expect((caught as ApiClientError).appealContact).toBe("me@x.test");
  });
});

describe("LoginForm ban refusal at the second factor", () => {
  let container: HTMLDivElement;
  useMountContainer((mounted) => {
    container = mounted;
  });

  it("shows the appeal contact as text, never as markup", async () => {
    const contact = '<img src=x onerror="alert(1)"> https://example.test';
    const onTotpSubmit = vi
      .fn()
      .mockRejectedValueOnce(httpError(403, "FORBIDDEN", SUSPENDED, undefined, contact));
    const { page, verifyBtn, totpInput } = mountTotpOverlay(container, { onTotpSubmit });

    totpInput.value = "111111";
    verifyBtn.click();
    await vi.waitFor(() => expect(onTotpSubmit).toHaveBeenCalledTimes(1));

    const shown = container.querySelector<HTMLElement>("#totp-error");
    await vi.waitFor(() => expect(shown?.textContent ?? "").toContain("To appeal"));
    expect(shown?.textContent).toBe(
      `${connectText("error.banned")}\n${connectText("error.bannedAppeal", { contact })}`,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).toBeNull();

    page.destroy?.();
  });
});
