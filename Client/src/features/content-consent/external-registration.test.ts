// The admitted-items list is registered with the session reset in the cache
// phase, and what it registers forgets every item admitted one by one.
import { describe, expect, it, vi } from "vitest";

const { register } = vi.hoisted(() => ({ register: vi.fn() }));
vi.mock("@lib/net/sessionRegistry", () => ({ registerSessionReset: register }));

import { externalAllowed, requestExternalItem, setExternalConsentChoice } from "./external";

// The module registers when it loads, before the per-test mock clear.
const registrationsAtLoad = [...register.mock.calls];

describe("external-content consent and the session reset", () => {
  it("registers once, in the cache phase", () => {
    expect(registrationsAtLoad).toEqual([
      ["consent:admitted-items", expect.any(Function), { phase: "cache" }],
    ]);
  });

  it("forgets admitted items when the reset runs", async () => {
    setExternalConsentChoice("ask");
    await requestExternalItem("url:a");
    expect(externalAllowed("url:a")).toBe(true);
    const reset = registrationsAtLoad[0]![1] as () => void;
    reset();
    expect(externalAllowed("url:a")).toBe(false);
  });
});
