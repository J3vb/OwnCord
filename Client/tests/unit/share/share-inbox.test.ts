import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SHARE_WAIT_MS,
  acceptSharesFor,
  sendShareTo,
} from "../../../src/features/share/shareInbox";
import { runSessionResets } from "../../../src/lib/net/sessionRegistry";
import type { ReceivedShare } from "../../../src/platform/contracts/shareSheet";

const share = (text: string): ReceivedShare => ({ files: [], text });
const releases: (() => void)[] = [];
const accept = (channelId: number, fn: (s: ReceivedShare) => void, now?: number): void => {
  releases.push(acceptSharesFor(channelId, fn, now));
};

afterEach(() => {
  for (const release of releases.splice(0)) release();
  // Nothing waits into the next test.
  runSessionResets("server_switch");
});

describe("shareInbox", () => {
  it("hands a share to the open composer of its channel at once", () => {
    const got = vi.fn();
    const other = vi.fn();
    accept(2, other);
    accept(5, got);
    sendShareTo(5, share("hello"));
    expect(got).toHaveBeenCalledWith(share("hello"));
    expect(other).not.toHaveBeenCalled();
  });

  it("keeps a share until its channel's composer mounts, then gives it once", () => {
    sendShareTo(7, share("later"), 1_000);
    const elsewhere = vi.fn();
    accept(3, elsewhere, 1_500);
    expect(elsewhere).not.toHaveBeenCalled();
    const got = vi.fn();
    accept(7, got, 2_000);
    expect(got).toHaveBeenCalledWith(share("later"));
    const again = vi.fn();
    accept(7, again, 2_500);
    expect(again).not.toHaveBeenCalled();
  });

  it("lets the second of two shares in a row win", () => {
    sendShareTo(7, share("first"), 1_000);
    sendShareTo(8, share("second"), 1_100);
    const seven = vi.fn();
    const eight = vi.fn();
    accept(7, seven, 1_200);
    accept(8, eight, 1_200);
    expect(seven).not.toHaveBeenCalled();
    expect(eight).toHaveBeenCalledWith(share("second"));
  });

  it("drops a share whose channel never opened within the wait", () => {
    sendShareTo(7, share("stale"), 1_000);
    const late = vi.fn();
    accept(7, late, 1_000 + SHARE_WAIT_MS + 1);
    expect(late).not.toHaveBeenCalled();
  });

  it("goes to the latest composer of the channel, and a released one gets nothing", () => {
    const old = vi.fn();
    const newer = vi.fn();
    const releaseOld = acceptSharesFor(4, old);
    const releaseNewer = acceptSharesFor(4, newer);
    releaseNewer();
    sendShareTo(4, share("one"));
    expect(old).toHaveBeenCalledTimes(1);
    expect(newer).not.toHaveBeenCalled();
    releaseOld();
  });

  it("forgets a waiting share when the session resets (a server switch)", () => {
    sendShareTo(9, share("old server"));
    runSessionResets("server_switch");
    const got = vi.fn();
    accept(9, got);
    expect(got).not.toHaveBeenCalled();
  });
});
