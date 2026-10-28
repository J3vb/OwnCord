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

    const overlay = container.querySelector(".modal-overlay");
    expect(overlay).not.toBeNull();
    const modal = container.querySelector(".modal");
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

  it("shows the whole code rather than a masked one", () => {
    const opts = makeOptions({ invites: [makeInvite({ code: "abcdefghi" })] });
    const mgr = createInviteManager(opts);
    mgr.mount(container);

    const codeEl = container.querySelector(".invite-item__code");
    expect(codeEl?.textContent).toBe("abcdefghi");

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

  it("only mints one invite per click, even on a double-click", async () => {
    let release: ((v: InviteItem) => void) | null = null;
    const onCreateInvite = vi.fn(
      () =>
        new Promise<InviteItem>((resolve) => {
          release = resolve;
        }),
    );
    const opts = makeOptions({ invites: [], onCreateInvite });
    const mgr = createInviteManager(opts);
    mgr.mount(container);

    const createBtn = container.querySelector(".invite-manager__create") as HTMLButtonElement;
    createBtn.click();
    expect(createBtn.disabled).toBe(true);
    createBtn.click();
    expect(onCreateInvite).toHaveBeenCalledTimes(1);

    release!(makeInvite({ code: "newcode123" }));
    await vi.waitFor(() => {
      expect(createBtn.disabled).toBe(false);
    });

    mgr.destroy?.();
  });

  it("disarms the revoke confirm if it is left alone", () => {
    vi.useFakeTimers();
    try {
      const opts = makeOptions({ invites: [makeInvite({ code: "abc123xyz" })] });
      const mgr = createInviteManager(opts);
      mgr.mount(container);

      const revokeBtn = container.querySelector(".invite-item__revoke") as HTMLButtonElement;
      revokeBtn.click();
      vi.advanceTimersByTime(5000);
      revokeBtn.click();

      // The second click re-arms rather than revoking a link the user forgot about.
      expect(opts.onRevokeInvite).not.toHaveBeenCalled();
      mgr.destroy?.();
    } finally {
      vi.useRealTimers();
    }
  });

  it("click revoke calls onRevokeInvite and removes from list on resolve", async () => {
    const opts = makeOptions({ invites: [makeInvite({ code: "abc123xyz" })] });
    const mgr = createInviteManager(opts);
    mgr.mount(container);

    expect(container.querySelectorAll(".invite-item").length).toBe(1);

    const revokeBtn = container.querySelector(".invite-item__revoke") as HTMLButtonElement;
    // Revoking kills a live link — first click only arms the confirm.
    revokeBtn.click();
    expect(opts.onRevokeInvite).not.toHaveBeenCalled();
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

    const closeBtn = container.querySelector(".modal-close") as HTMLButtonElement;
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

    const overlay = container.querySelector(".modal-overlay") as HTMLDivElement;
    // Clicking the overlay itself (not the modal)
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(opts.onClose).toHaveBeenCalledOnce();

    mgr.destroy?.();
  });

  it("stays open when a drag-select ends on the backdrop", () => {
    const opts = makeOptions();
    const mgr = createInviteManager(opts);
    mgr.mount(container);
    const overlayEl = container.querySelector(".modal-overlay") as HTMLElement;
    overlayEl.firstElementChild!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    overlayEl.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(opts.onClose).not.toHaveBeenCalled();
    mgr.destroy?.();
  });

  it("create failure calls onError", async () => {
    const opts = makeOptions({
      onCreateInvite: vi.fn(
        () => Promise.reject("fail") /* non-Error: falls back to the generic text */,
      ),
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

  // ── dialog accessibility contract (DC-13) ──────────────────────────────────

  it("stamps dialog semantics named by the header title", () => {
    const opts = makeOptions();
    const mgr = createInviteManager(opts);
    mgr.mount(container);

    const dialog = container.querySelector(".modal") as HTMLElement;
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("invite-manager-title");
    expect(container.querySelector("#invite-manager-title")?.textContent).toBe("Server Invites");

    mgr.destroy?.();
  });

  it("labels the icon-only close button", () => {
    const opts = makeOptions();
    const mgr = createInviteManager(opts);
    mgr.mount(container);

    const closeBtn = container.querySelector(".modal-close") as HTMLButtonElement;
    expect(closeBtn.getAttribute("aria-label")).toBe("Close");

    mgr.destroy?.();
  });

  it("moves focus into the modal on mount and restores it on destroy", () => {
    const trigger = document.createElement("button");
    container.appendChild(trigger);
    trigger.focus();

    const opts = makeOptions();
    const mgr = createInviteManager(opts);
    mgr.mount(container);

    // First focusable in DOM order is the header close button.
    const closeBtn = container.querySelector(".modal-close") as HTMLButtonElement;
    expect(document.activeElement).toBe(closeBtn);

    mgr.destroy?.();
    expect(document.activeElement).toBe(trigger);
  });

  it("revoke failure calls onError", async () => {
    const opts = makeOptions({
      onRevokeInvite: vi.fn(
        () => Promise.reject("fail") /* non-Error: falls back to the generic text */,
      ),
    });
    const mgr = createInviteManager(opts);
    mgr.mount(container);

    const revokeBtn = container.querySelector(".invite-item__revoke") as HTMLButtonElement;
    revokeBtn.click();
    revokeBtn.click();

    await vi.waitFor(() => {
      expect(opts.onError).toHaveBeenCalledWith("Failed to revoke invite");
    });

    mgr.destroy?.();
  });

  describe("create options, link and expiry", () => {
    const mounted: Array<{ destroy?: () => void }> = [];
    afterEach(() => {
      for (const m of mounted.splice(0)) m.destroy?.();
    });
    const mountMgr = (o: Partial<InviteManagerOptions>) => {
      const mgr = createInviteManager(makeOptions(o));
      mgr.mount(container);
      mounted.push(mgr);
      return mgr;
    };
    const clickCreate = async () => {
      container.querySelector<HTMLButtonElement>(".invite-manager__create")!.click();
      await Promise.resolve();
    };

    it("create sends 168 h / unlimited by default", async () => {
      const onCreateInvite = vi.fn(() => Promise.resolve(makeInvite({ code: "n" })));
      mountMgr({ onCreateInvite });
      await clickCreate();
      expect(onCreateInvite).toHaveBeenCalledWith({ expiresInHours: 168, maxUses: 0 });
    });

    it("create sends the chosen expiry and max uses", async () => {
      const onCreateInvite = vi.fn(() => Promise.resolve(makeInvite({ code: "n" })));
      mountMgr({ onCreateInvite });
      const set = (id: string, v: string) => {
        container.querySelector<HTMLSelectElement>(`#${id}`)!.value = v;
      };
      set("invite-expiry", "0");
      set("invite-max-uses", "10");
      await clickCreate();
      expect(onCreateInvite).toHaveBeenCalledWith({ expiresInHours: 0, maxUses: 10 });
    });

    it("row shows the full link and expiry", () => {
      mountMgr({
        invites: [
          makeInvite({
            code: "abcdefghijklmnop",
            expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          }),
        ],
        formatLink: (c) => `owncord://invite/${c}`,
      });
      const row = container.querySelector(".invite-item")!;
      expect(row.querySelector(".invite-item__code")!.textContent).toBe(
        "owncord://invite/abcdefghijklmnop",
      );
      expect(row.querySelector(".invite-item__meta")!.textContent).toContain("Expires in 7 days");
      expect(row.querySelector(".invite-item__meta")!.textContent).toContain("3 / 10 uses");
    });

    it("shows Never expires and plain uses when unlimited", () => {
      mountMgr({ invites: [makeInvite({ expiresAt: null, maxUses: null })] });
      const meta = container.querySelector(".invite-item__meta")!.textContent;
      expect(meta).toContain("Never expires");
      expect(meta).toContain("3 uses");
    });

    it("features the chosen invite with a Copy button", () => {
      const onCopyLink = vi.fn();
      mountMgr({ featuredCode: "abc123xyz", onCopyLink });
      container.querySelector<HTMLButtonElement>(".invite-manager__featured-copy")!.click();
      expect(onCopyLink).toHaveBeenCalledWith("abc123xyz");
    });

    it("shows the server error text when create fails", async () => {
      const onError = vi.fn();
      mountMgr({
        onCreateInvite: vi.fn(() => Promise.reject(new Error("Invite limit reached"))),
        onError,
      });
      await clickCreate();
      await Promise.resolve();
      expect(onError).toHaveBeenCalledWith("Invite limit reached");
    });

    it("shows the server error text when revoke fails", async () => {
      vi.useFakeTimers();
      try {
        const onError = vi.fn();
        mountMgr({
          onRevokeInvite: vi.fn(() => Promise.reject(new Error("Not allowed"))),
          onError,
        });
        const btn = container.querySelector<HTMLButtonElement>(".invite-item__revoke")!;
        btn.click();
        btn.click();
        await vi.advanceTimersByTimeAsync(0);
        expect(onError).toHaveBeenCalledWith("Not allowed");
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
