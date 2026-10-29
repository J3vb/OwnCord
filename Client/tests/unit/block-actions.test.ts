import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { confirmAndToggleBlock, toggleBlock } from "../../src/features/blocks/blockActions";
import { blocksStore, resetBlocksStore, setUserBlockedByMe } from "../../src/stores/blocks.store";

function deps() {
  return {
    api: {
      blockUser: vi.fn().mockResolvedValue(undefined),
      unblockUser: vi.fn().mockResolvedValue(undefined),
    },
    notify: vi.fn(),
  };
}

const click = (testId: string): void =>
  document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.click();

describe("block actions", () => {
  beforeEach(() => resetBlocksStore());
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("toggleBlock blocks, updates the store and toasts", async () => {
    const d = deps();
    await toggleBlock(d, 7, "Bob", true);
    expect(d.api.blockUser).toHaveBeenCalledExactlyOnceWith(7);
    expect(blocksStore.getState().blockedByMe.has(7)).toBe(true);
    expect(d.notify).toHaveBeenCalledWith("Blocked Bob", "success");
  });

  it("toggleBlock unblocks", async () => {
    setUserBlockedByMe(7, true);
    const d = deps();
    await toggleBlock(d, 7, "Bob", false);
    expect(d.api.unblockUser).toHaveBeenCalledExactlyOnceWith(7);
    expect(blocksStore.getState().blockedByMe.has(7)).toBe(false);
  });

  it("a failed request leaves the store unchanged and toasts the error", async () => {
    const d = deps();
    d.api.blockUser.mockRejectedValue(new Error("boom"));
    await toggleBlock(d, 7, "Bob", true);
    expect(blocksStore.getState().blockedByMe.has(7)).toBe(false);
    expect(d.notify).toHaveBeenCalledWith(expect.any(String), "error");
  });

  it("drops a second request for the same user while one is in flight", async () => {
    const d = deps();
    let release: () => void = () => {};
    d.api.blockUser.mockReturnValue(new Promise<void>((r) => (release = r)));
    const first = toggleBlock(d, 7, "Bob", true);
    await toggleBlock(d, 7, "Bob", true);
    release();
    await first;
    expect(d.api.blockUser).toHaveBeenCalledTimes(1);
  });

  it("Block asks first: cancel does nothing", () => {
    const d = deps();
    confirmAndToggleBlock(d, 7, "Bob", true);
    expect(document.querySelector('[data-testid="block-confirm-dialog"]')).not.toBeNull();
    click("block-confirm-cancel");
    expect(d.api.blockUser).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="block-confirm-dialog"]')).toBeNull();
  });

  it("confirming sends one request even when the button is double-clicked", async () => {
    const d = deps();
    confirmAndToggleBlock(d, 7, "Bob", true);
    const confirm = document.querySelector<HTMLElement>('[data-testid="block-confirm"]');
    confirm?.click();
    confirm?.click();
    await vi.waitFor(() => expect(blocksStore.getState().blockedByMe.has(7)).toBe(true));
    expect(d.api.blockUser).toHaveBeenCalledTimes(1);
  });

  it("Unblock needs no confirm", async () => {
    const d = deps();
    confirmAndToggleBlock(d, 7, "Bob", false);
    expect(document.querySelector('[data-testid="block-confirm-dialog"]')).toBeNull();
    await vi.waitFor(() => expect(d.api.unblockUser).toHaveBeenCalledTimes(1));
  });

  it("labels the block confirmation by its heading", () => {
    confirmAndToggleBlock(deps(), 7, "Bob", true);
    const modal = document.querySelector('[data-testid="block-confirm-dialog"] .modal')!;
    const heading = document.getElementById(modal.getAttribute("aria-labelledby") ?? "");
    expect(heading?.id).toBe("block-confirm-title");
    expect(heading?.textContent).toContain("Bob");
    click("block-confirm-cancel");
  });
});
