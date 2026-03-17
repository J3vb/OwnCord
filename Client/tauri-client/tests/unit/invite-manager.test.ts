import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createInviteManager,
  type InviteItem,
  type InviteManagerOptions,
} from "@components/InviteManager";

function makeInvite(overrides: Partial<InviteItem> = {}): InviteItem {
  return {
    code: "abc123xyz",
    createdBy: "admin",
    createdAt: "2025-01-01T00:00:00Z",
    uses: 3,
    maxUses: 10,
    expiresAt: null,
    ...overrides,
  };
}

function makeOptions(overrides: Partial<InviteManagerOptions> = {}): InviteManagerOptions {
  return {
    invites: [makeInvite()],
    onCreateInvite: vi.fn(() => Promise.resolve(makeInvite({ code: "newcode123" }))),
    onRevokeInvite: vi.fn(() => Promise.resolve()),
    onCopyLink: vi.fn(),
    onClose: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

describe("InviteManager", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("mounts with overlay class and modal", () => {
    const opts = makeOptions();
    const mgr = createInviteManager(opts);
    mgr.mount(container);

    const overlay = container.querySelector(".invite-manager-overlay");
    expect(overlay).not.toBeNull();
    const modal = container.querySelector(".invite-manager");
    expect(modal).not.toBeNull();

    mgr.destroy?.();
  });

  it("renders invite items from options.invites", () => {
    const opts = makeOptions({
      invites: [makeInvite({ code: "aaa111bbb" }), makeInvite({ code: "ccc222ddd" })],
    });
    const mgr = createInviteManager(opts);
    mgr.mount(container);

    const items = container.querySelectorAll(".invite-item");
    expect(items.length).toBe(2);

    mgr.destroy?.();
  });

  it("masks codes (first 3 + ... + last 3)", () => {
    const opts = makeOptions({ invites: [makeInvite({ code: "abcdefghi" })] });
    const mgr = createInviteManager(opts);
    mgr.mount(container);

    const codeEl = container.querySelector(".invite-item__code");
    expect(codeEl?.textContent).toBe("abc...ghi");

    mgr.destroy?.();
  });

  it("click copy calls onCopyLink with code", () => {
    const opts = makeOptions({ invites: [makeInvite({ code: "abc123xyz" })] });
    const mgr = createInviteManager(opts);
    mgr.mount(container);

    const copyBtn = container.querySelector(".invite-item__copy") as HTMLButtonElement;
    copyBtn.click();
    expect(opts.onCopyLink).toHaveBeenCalledWith("abc123xyz");

    mgr.destroy?.();
  });

  it("click create calls onCreateInvite and adds to list on resolve", async () => {
    const newInvite = makeInvite({ code: "newcode123" });
    const opts = makeOptions({
      invites: [],
      onCreateInvite: vi.fn(() => Promise.resolve(newInvite)),
    });
    const mgr = createInviteManager(opts);
    mgr.mount(container);

    expect(container.querySelectorAll(".invite-item").length).toBe(0);

    const createBtn = container.querySelector(".invite-manager__create") as HTMLButtonElement;
    createBtn.click();

    // Wait for the promise to resolve
    await vi.waitFor(() => {
      expect(container.querySelectorAll(".invite-item").length).toBe(1);
    });

    mgr.destroy?.();
  });

  it("click revoke calls onRevokeInvite and removes from list on resolve", async () => {
    const opts = makeOptions({ invites: [makeInvite({ code: "abc123xyz" })] });
    const mgr = createInviteManager(opts);
    mgr.mount(container);

    expect(container.querySelectorAll(".invite-item").length).toBe(1);

    const revokeBtn = container.querySelector(".invite-item__revoke") as HTMLButtonElement;
    revokeBtn.click();
    expect(opts.onRevokeInvite).toHaveBeenCalledWith("abc123xyz");

    await vi.waitFor(() => {
      expect(container.querySelectorAll(".invite-item").length).toBe(0);
    });

    mgr.destroy?.();
  });

  it("close button calls onClose", () => {
    const opts = makeOptions();
    const mgr = createInviteManager(opts);
    mgr.mount(container);

    const closeBtn = container.querySelector(".invite-manager__close") as HTMLButtonElement;
    closeBtn.click();
    expect(opts.onClose).toHaveBeenCalledOnce();

    mgr.destroy?.();
  });

  it("escape key calls onClose", () => {
    const opts = makeOptions();
    const mgr = createInviteManager(opts);
    mgr.mount(container);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(opts.onClose).toHaveBeenCalledOnce();

    mgr.destroy?.();
  });

  it("clicking overlay backdrop calls onClose", () => {
    const opts = makeOptions();
    const mgr = createInviteManager(opts);
    mgr.mount(container);

    const overlay = container.querySelector(".invite-manager-overlay") as HTMLDivElement;
    // Clicking the overlay itself (not the modal)
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(opts.onClose).toHaveBeenCalledOnce();

    mgr.destroy?.();
  });

  it("create failure calls onError", async () => {
    const opts = makeOptions({
      onCreateInvite: vi.fn(() => Promise.reject(new Error("fail"))),
    });
    const mgr = createInviteManager(opts);
    mgr.mount(container);

    const createBtn = container.querySelector(".invite-manager__create") as HTMLButtonElement;
    createBtn.click();

    await vi.waitFor(() => {
      expect(opts.onError).toHaveBeenCalledWith("Failed to create invite");
    });

    mgr.destroy?.();
  });

  it("revoke failure calls onError", async () => {
    const opts = makeOptions({
      onRevokeInvite: vi.fn(() => Promise.reject(new Error("fail"))),
    });
    const mgr = createInviteManager(opts);
    mgr.mount(container);

    const revokeBtn = container.querySelector(".invite-item__revoke") as HTMLButtonElement;
    revokeBtn.click();

    await vi.waitFor(() => {
      expect(opts.onError).toHaveBeenCalledWith("Failed to revoke invite");
    });

    mgr.destroy?.();
  });
});
