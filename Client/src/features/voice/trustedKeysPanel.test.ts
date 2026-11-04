import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";

vi.mock("@lib/ui/toast", () => ({ showToast: vi.fn() }));

import { showToast } from "@lib/ui/toast";
import { exportPublicKey, generateIdentityKeyPair } from "@lib/net/e2eeCrypto";
import type { ForgetIdentityPinResult } from "@lib/net/identity";
import { createTrustedKeysPanel, type TrustedKeysPanelOptions } from "./trustedKeysPanel";

let oldKey = "";
let newKey = "";

beforeAll(async () => {
  oldKey = await exportPublicKey((await generateIdentityKeyPair()).publicKey);
  newKey = await exportPublicKey((await generateIdentityKeyPair()).publicKey);
});

let destroy: (() => void) | null = null;

afterEach(() => {
  destroy?.();
  destroy = null;
  document.body.replaceChildren();
  vi.mocked(showToast).mockClear();
});

function open(over: Partial<TrustedKeysPanelOptions> = {}) {
  const keys = { current: [oldKey, newKey] as string[] | null };
  const forget = vi.fn(async (key: string): Promise<ForgetIdentityPinResult> => {
    keys.current = keys.current?.filter((k) => k !== key) ?? null;
    return "forgotten";
  });
  const onClose = vi.fn();
  const panel = createTrustedKeysPanel({
    userId: 7,
    username: "alice",
    changed: false,
    loadKeys: async () => keys.current,
    keyInCall: () => newKey,
    forget,
    onClose,
    ...over,
  });
  panel.mount(document.body);
  destroy = () => panel.destroy?.();
  return { forget, onClose };
}

const rows = () => [...document.querySelectorAll<HTMLElement>(".tk-row")];

async function settle(): Promise<void> {
  await vi.waitFor(() => {
    expect(document.querySelector(".tk-row, .tk-empty")).not.toBeNull();
  });
}

describe("trusted keys panel", () => {
  it("lists keys newest first, marks the one in the call, and offers forget on the others", async () => {
    open();
    await settle();
    const [first, second] = rows();
    expect(rows()).toHaveLength(2);
    expect(first!.querySelector(".tk-tag.current")).not.toBeNull();
    expect(first!.querySelector(".tk-forget")).toBeNull();
    expect(second!.querySelector(".tk-tag.current")).toBeNull();
    expect(second!.querySelector(".tk-fingerprint")!.textContent).toMatch(/\d/);
    expect(second!.querySelector(".tk-forget")).not.toBeNull();
  });

  it("marks the key in the call as changed when it is not yet confirmed", async () => {
    open({ changed: true });
    await settle();
    expect(rows()[0]!.querySelector(".tk-tag.changed")).not.toBeNull();
  });

  it("forgets an older key and redraws without it", async () => {
    const { forget } = open();
    await settle();
    rows()[1]!.querySelector<HTMLButtonElement>(".tk-forget")!.click();
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(forget).toHaveBeenCalledExactlyOnceWith(oldKey);
    expect(document.querySelector(".tk-forget")).toBeNull();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("says so when forgetting fails", async () => {
    open({ forget: async () => "failed" });
    await settle();
    rows()[1]!.querySelector<HTMLButtonElement>(".tk-forget")!.click();
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.any(String), "error"));
    expect(rows()).toHaveLength(2);
  });

  it("offers no forget when only one key is trusted", async () => {
    open({ loadKeys: async () => [oldKey], keyInCall: () => null });
    await settle();
    expect(rows()).toHaveLength(1);
    expect(document.querySelector(".tk-forget")).toBeNull();
  });

  it("shows a notice instead of a list when the keys cannot be read", async () => {
    open({ loadKeys: async () => null });
    await settle();
    expect(rows()).toHaveLength(0);
    expect(document.querySelector(".tk-empty")).not.toBeNull();
  });

  it("closes on Done and on Escape", async () => {
    const { onClose } = open();
    await settle();
    document.querySelector<HTMLButtonElement>(".modal-footer .btn-primary")!.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("never draws into a panel that was closed while it loaded", async () => {
    const pending: { resolve?: (keys: string[]) => void } = {};
    open({ loadKeys: () => new Promise((resolve) => (pending.resolve = resolve)) });
    destroy?.();
    destroy = null;
    pending.resolve?.([oldKey, newKey]);
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector(".tk-modal")).toBeNull();
    expect(rows()).toHaveLength(0);
  });
});
