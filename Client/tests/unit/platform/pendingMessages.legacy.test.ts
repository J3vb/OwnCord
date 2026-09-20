// Legacy binding for the PendingMessageStore suite: today's
// `lib/pendingMessages.ts` native store, wrapped with no cast against the
// contract. B7-4 re-runs `pendingMessages.suite.ts` against
// `platform/desktop` instead of this file.
//
// The store reads `isTauri`/`invoke` per call, so toggling the live values
// below moves it between "succeeds" / "fails" / "not a native host" with no
// module reset — the same getter trick `credentials.legacy.test.ts` uses.
import { vi } from "vitest";
import type { PendingMessageOwner } from "../../../src/platform/contracts/pendingMessages";
import type { PendingMessageStore } from "../../../src/platform/contracts/pendingMessages";
import { describePendingMessagesSuite } from "./pendingMessages.suite";

const core: {
  isTauri: () => boolean;
  invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | undefined;
} = { isTauri: () => false, invoke: undefined };

vi.mock("@tauri-apps/api/core", () => ({
  get isTauri() {
    return core.isTauri;
  },
  get invoke() {
    return core.invoke;
  },
}));
vi.mock("@stores/messages.store", () => ({
  addOptimisticMessage: vi.fn(),
  markSendFailed: vi.fn(),
}));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const mod = await import("../../../src/lib/pendingMessages");
const legacy: PendingMessageStore = mod.nativePersistence;

let isNative = true;
let loadResult: string | null = null;
let failure: unknown = null;
const saved: { owner: PendingMessageOwner; value: string }[] = [];
const deleted: PendingMessageOwner[] = [];

/** The owner, as the native side receives it. */
function ownerOf(args: Record<string, unknown> | undefined): PendingMessageOwner {
  return { host: String(args?.host), userId: Number(args?.userId) };
}

/** A native host that is present and healthy. Each control method narrows
 *  only that — a suite test that sets up nothing gets the working store, and
 *  a test that narrows mid-flight keeps what the store already did. */
function reset(): void {
  isNative = true;
  loadResult = null;
  failure = null;
  saved.length = 0;
  deleted.length = 0;
}

const invoke = vi.fn((cmd: string, args?: Record<string, unknown>) => {
  if (cmd === "save_pending_messages") {
    saved.push({ owner: ownerOf(args), value: String(args?.value) });
  } else if (cmd === "delete_pending_messages") {
    deleted.push(ownerOf(args));
  }
  if (failure !== null) return Promise.reject(failure);
  if (cmd === "load_pending_messages") return Promise.resolve(loadResult);
  return Promise.resolve(undefined);
});

describePendingMessagesSuite(async () => {
  reset();
  core.isTauri = () => isNative;
  core.invoke = invoke;
  return {
    subject: legacy,
    native: {
      loadReturns(value: string | null) {
        loadResult = value;
        failure = null;
      },
      failWith(error: unknown) {
        failure = error;
      },
      unavailable() {
        isNative = false;
      },
      saved: () => saved.map((entry) => ({ ...entry })),
      deleted: () => deleted.map((entry) => ({ ...entry })),
    },
  };
});
