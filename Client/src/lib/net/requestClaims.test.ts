import { afterEach, describe, expect, it } from "vitest";
import { claimRequest, isClaimedRequest, releaseRequest } from "./requestClaims";
import { runSessionResets } from "./sessionRegistry";

const flush = () => Promise.resolve();

afterEach(() => {
  runSessionResets("user");
});

describe("request claims", () => {
  it("knows a claimed id and nothing else", () => {
    claimRequest("req-1");
    expect(isClaimedRequest("req-1")).toBe(true);
    expect(isClaimedRequest("req-2")).toBe(false);
    expect(isClaimedRequest(undefined)).toBe(false);
  });

  it("keeps the claim until a microtask after release, so a second listener of the frame still sees it", async () => {
    claimRequest("req-1");
    releaseRequest("req-1");
    expect(isClaimedRequest("req-1")).toBe(true);
    await flush();
    expect(isClaimedRequest("req-1")).toBe(false);
  });

  it("clears every claim on a session reset, so a late reply is not swallowed", () => {
    claimRequest("req-1");
    claimRequest("req-2");
    runSessionResets("server_switch");
    expect(isClaimedRequest("req-1")).toBe(false);
    expect(isClaimedRequest("req-2")).toBe(false);
  });

  it("a release from a closed dialog does not drop a newer claim of another id", async () => {
    claimRequest("old");
    claimRequest("new");
    releaseRequest("old");
    await flush();
    expect(isClaimedRequest("old")).toBe(false);
    expect(isClaimedRequest("new")).toBe(true);
  });
});
