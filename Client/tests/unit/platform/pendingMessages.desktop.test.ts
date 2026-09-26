// Desktop binding for the PendingMessageStore suite: `platform/desktop`'s
// pending-message store. B7-4 ran the same suite file against the in-place
// seam in `lib/pendingMessages.ts` first (proving it could fail and pinning
// today's behaviour), then re-bound it here. The legacy binding is deleted
// with this commit: its export is now internal, so it would assert nothing
// the desktop binding does not.
//
// The store reads `isTauri`/`invoke` per call, so toggling the live values
// below moves it between "succeeds" / "fails" / "not a native host" with no
// module reset — the getter trick this file has used since it was the legacy
// binding.
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
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const mod = await import("../../../src/platform/desktop/pendingMessages");
const desktopBinding: PendingMessageStore = mod.pendingMessages;

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
    subject: desktopBinding,
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
