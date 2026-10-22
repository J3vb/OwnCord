// Browser binding for the PendingMessageStore suite (6.13c): the browser keeps
// drafts in the page's memory only, so the suite runs with `memoryOnly: true`
// against a fresh store per test. The full suite runs against the desktop
// store in `pendingMessages.desktop.test.ts`.
import { describe, expect, it } from "vitest";
import type { PendingMessageStore } from "../../../src/platform/contracts/pendingMessages";
import {
  createMemoryPendingMessages,
  pendingMessages,
} from "../../../src/platform/browser/pendingMessages";
import { describePendingMessagesSuite } from "./pendingMessages.suite";

function notApplicable(): never {
  // i18n-exempt: test diagnostic
  throw new Error("a memory-only store has no native store to control");
}

describePendingMessagesSuite(
  async () => {
    const browserBinding: PendingMessageStore = createMemoryPendingMessages();
    return {
      subject: browserBinding,
      native: {
        loadReturns: notApplicable,
        failWith: notApplicable,
        unavailable: notApplicable,
        saved: notApplicable,
        deleted: notApplicable,
      },
    };
  },
  { memoryOnly: true },
);

describe("browser pending messages", () => {
  it("writes nothing to Web Storage", async () => {
    localStorage.clear();
    sessionStorage.clear();
    const store = createMemoryPendingMessages();
    await store.save({ host: "chat.example", userId: 7 }, '[{"content":"draft text"}]');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("gives each store its own memory", async () => {
    const first = createMemoryPendingMessages();
    const second = createMemoryPendingMessages();
    await first.save({ host: "chat.example", userId: 7 }, "drafts");
    await expect(second.load({ host: "chat.example", userId: 7 })).resolves.toBeNull();
  });

  it("registers one shared store for the app", () => {
    expect(pendingMessages).toBeDefined();
    expect(pendingMessages).not.toBe(createMemoryPendingMessages());
  });
});
