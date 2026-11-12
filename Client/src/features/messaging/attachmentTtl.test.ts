import { afterEach, describe, expect, it } from "vitest";
import { authStore } from "@stores/auth.store";
import { ATTACHMENT_TTL_MS, attachmentTtlMs } from "./attachmentTtl";

function advertise(staged_lifetime_seconds: number | undefined): void {
  authStore.setState((prev) => ({
    ...prev,
    uploadPolicy: staged_lifetime_seconds === undefined ? {} : { staged_lifetime_seconds },
  }));
}

describe("attachmentTtlMs", () => {
  afterEach(() => {
    authStore.setState((prev) => ({ ...prev, uploadPolicy: null }));
  });

  it("keeps the older-server limit when no policy has arrived", () => {
    authStore.setState((prev) => ({ ...prev, uploadPolicy: null }));
    expect(attachmentTtlMs()).toBe(ATTACHMENT_TTL_MS);
  });

  it("keeps the older-server limit when the policy does not name a lifetime", () => {
    advertise(undefined);
    expect(attachmentTtlMs()).toBe(ATTACHMENT_TTL_MS);
  });

  it("trusts a staged upload for a sixth under the advertised lifetime", () => {
    advertise(24 * 60 * 60);
    expect(attachmentTtlMs()).toBe(20 * 60 * 60 * 1000);
    advertise(60 * 60);
    expect(attachmentTtlMs()).toBe(ATTACHMENT_TTL_MS);
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])("ignores a lifetime of %s", (seconds) => {
    advertise(seconds);
    expect(attachmentTtlMs()).toBe(ATTACHMENT_TTL_MS);
  });
});
