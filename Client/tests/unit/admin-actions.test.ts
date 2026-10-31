import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMemberContextMenu } from "@components/AdminActions";
import { setDeveloperMode } from "../helpers/message-actions-fixtures";
import type { MemberContextMenuOptions } from "@components/AdminActions";
import type { VoiceModMenuOptions } from "@components/channel-sidebar/volumeMenu";
import { useMountContainer } from "../helpers/mountContainer";

describe("AdminActions", () => {
  let container: HTMLDivElement;
  useMountContainer((mounted) => {
    container = mounted;
  });

  describe("MemberContextMenu", () => {
    function makeMenu(overrides?: Partial<MemberContextMenuOptions>) {
      const options: MemberContextMenuOptions = {
        x: 0,
        y: 0,
        userId: 1,
        username: "TestUser",
        currentRole: "member",
        availableRoles: ["admin", "moderator", "member"],
        showAdminActions: overrides?.showAdminActions ?? true,
        isBlocked: overrides?.isBlocked ?? false,
        onToggleBlock: overrides?.onToggleBlock ?? vi.fn(async () => {}),
        onKick: overrides?.onKick ?? vi.fn(async () => {}),
        onBan: overrides?.onBan ?? vi.fn(async () => {}),
        onChangeRole: overrides?.onChangeRole ?? vi.fn(async () => {}),
        // Per-action gates (canKick/canBan/canManageRoles) come through as-is.
        ...overrides,
      };
      const result = createMemberContextMenu(options);
      container.appendChild(result.element);
      return { result, options };
    }

    it("creates element with context-menu class", () => {
      const { result } = makeMenu();
      expect(result.element.classList.contains("context-menu")).toBe(true);
      result.destroy();
    });

    it("renders Change Role item", () => {
      const { result } = makeMenu();
      const items = result.element.querySelectorAll(".context-menu__item");
      const texts = Array.from(items).map((i) => i.textContent);
      expect(texts.some((t) => t?.includes("Change Role"))).toBe(true);
      result.destroy();
    });

    it("renders role submenu with available roles", () => {
      const { result } = makeMenu();
      const submenu = result.element.querySelector(".context-menu__submenu");
      expect(submenu).not.toBeNull();

      const roleItems = submenu!.querySelectorAll(".context-menu__item");
      const roleTexts = Array.from(roleItems).map((r) => r.textContent);
      expect(roleTexts).toContain("admin");
      expect(roleTexts).toContain("moderator");
      expect(roleTexts).toContain("member");
      result.destroy();
    });

    it("a role change in flight ignores further clicks (double-fire guard)", async () => {
      let resolveChange: (() => void) | null = null;
      const onChangeRole = vi.fn(
        () =>
          new Promise<void>((res) => {
            resolveChange = res;
          }),
      );
      const { result } = makeMenu({ onChangeRole });
      const submenu = result.element.querySelector(".context-menu__submenu")!;
      const adminOption = Array.from(submenu.querySelectorAll(".context-menu__item")).find(
        (i) => i.textContent === "admin",
      ) as HTMLElement;
      const modOption = Array.from(submenu.querySelectorAll(".context-menu__item")).find(
        (i) => i.textContent === "moderator",
      ) as HTMLElement;

      adminOption.click();
      // `currentRole` only updates when member_update echoes, so both a
      // double-click and a different option must be inert while in flight.
      adminOption.click();
      modOption.click();

      expect(onChangeRole).toHaveBeenCalledTimes(1);
      expect(adminOption.classList.contains("context-menu__item--pending")).toBe(true);

      resolveChange!();
      await vi.waitFor(() => {
        expect(adminOption.classList.contains("context-menu__item--pending")).toBe(false);
      });

      // Settled: a new change may fire again.
      modOption.click();
      expect(onChangeRole).toHaveBeenCalledTimes(2);
      result.destroy();
    });

    it("clicking the current role is a no-op", () => {
      const onChangeRole = vi.fn(async () => {});
      const { result } = makeMenu({ onChangeRole });
      const submenu = result.element.querySelector(".context-menu__submenu")!;
      const memberOption = Array.from(submenu.querySelectorAll(".context-menu__item")).find(
        (i) => i.textContent === "member",
      ) as HTMLElement;

      memberOption.click();

      expect(onChangeRole).not.toHaveBeenCalled();
      result.destroy();
    });

    it("marks current role as active in submenu", () => {
      const { result } = makeMenu();
      const submenu = result.element.querySelector(".context-menu__submenu");
      const activeRole = submenu!.querySelector(".context-menu__item--active");
      expect(activeRole).not.toBeNull();
      expect(activeRole!.textContent).toBe("member");
      result.destroy();
    });

    it("renders Force Logout and Ban items with danger class", () => {
      const { result } = makeMenu();
      const dangerItems = result.element.querySelectorAll(".context-menu__item--danger");
      const texts = Array.from(dangerItems).map((i) => i.textContent);
      expect(texts).toContain("Force Logout");
      expect(texts).toContain("Ban");
      result.destroy();
    });

    it("Force Logout requires double-click confirmation", () => {
      const onKick = vi.fn(async () => {});
      const { result } = makeMenu({ onKick });

      const dangerItems = result.element.querySelectorAll(".context-menu__item--danger");
      const kickItem = Array.from(dangerItems).find(
        (i) => i.textContent === "Force Logout",
      ) as HTMLDivElement;

      // First click changes text to confirmation
      kickItem.click();
      expect(kickItem.textContent).toBe("Log them out?");
      expect(onKick).not.toHaveBeenCalled();

      // Second click confirms
      kickItem.click();
      expect(onKick).toHaveBeenCalledOnce();
      result.destroy();
    });

    it("Ban hands off to the dialog on one click, without an inline form", () => {
      const onBan = vi.fn();
      const { result } = makeMenu({ onBan });

      const banItem = Array.from(
        result.element.querySelectorAll(".context-menu__item--danger"),
      ).find((i) => i.textContent === "Ban") as HTMLDivElement;
      expect(result.element.querySelector("[data-testid='ban-reason-input']")).toBeNull();
      expect(result.element.querySelector("[data-testid='ban-confirm']")).toBeNull();

      banItem.click();

      // The dialog (not this menu) collects the reason, so the menu is gone.
      expect(onBan).toHaveBeenCalledTimes(1);
      expect(result.element.isConnected).toBe(false);
    });

    it("Force Logout shows an in-flight state and disarms after a pause", async () => {
      vi.useFakeTimers();
      try {
        let release: (() => void) | null = null;
        const onKick = vi.fn(
          () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        );
        const { result } = makeMenu({ onKick });
        const kickItem = Array.from(
          result.element.querySelectorAll(".context-menu__item--danger"),
        ).find((i) => i.textContent === "Force Logout") as HTMLDivElement;

        // Armed, then left alone — a stray later click must not log anyone out.
        kickItem.click();
        expect(kickItem.textContent).toBe("Log them out?");
        vi.advanceTimersByTime(5000);
        expect(kickItem.textContent).toBe("Force Logout");
        kickItem.click();
        expect(onKick).not.toHaveBeenCalled();

        kickItem.click();
        expect(onKick).toHaveBeenCalledOnce();
        expect(kickItem.textContent).toBe("Logging out...");

        release!();
        await vi.waitFor(() => {
          expect(kickItem.textContent).toBe("Force Logout");
        });
        result.destroy();
      } finally {
        vi.useRealTimers();
      }
    });

    it("renders separator between role and danger items", () => {
      const { result } = makeMenu();
      const separator = result.element.querySelector(".context-menu__separator");
      expect(separator).not.toBeNull();
      result.destroy();
    });

    it("destroy removes element from DOM", () => {
      const { result } = makeMenu();
      expect(container.querySelector(".context-menu")).not.toBeNull();
      result.destroy();
      expect(container.querySelector(".context-menu")).toBeNull();
    });

    it("renders only the Block item when showAdminActions is false", () => {
      const { result } = makeMenu({ showAdminActions: false });
      const items = result.element.querySelectorAll(".context-menu__item");
      const texts = Array.from(items).map((i) => i.textContent);
      expect(texts).toEqual(["Block"]);
      result.destroy();
    });

    it("Block requires double-click confirmation", () => {
      const onToggleBlock = vi.fn(async () => {});
      const { result } = makeMenu({ showAdminActions: false, onToggleBlock });
      const blockItem = result.element.querySelector<HTMLElement>('[data-testid="block-toggle"]');
      expect(blockItem).not.toBeNull();
      blockItem?.click();
      expect(blockItem?.textContent).toBe("Are you sure?");
      expect(onToggleBlock).not.toHaveBeenCalled();
      blockItem?.click();
      expect(onToggleBlock).toHaveBeenCalledOnce();
      result.destroy();
    });

    it("Unblock fires on a single click when already blocked", () => {
      const onToggleBlock = vi.fn(async () => {});
      const { result } = makeMenu({ showAdminActions: false, isBlocked: true, onToggleBlock });
      const blockItem = result.element.querySelector<HTMLElement>('[data-testid="block-toggle"]');
      expect(blockItem?.textContent).toBe("Unblock");
      blockItem?.click();
      expect(onToggleBlock).toHaveBeenCalledOnce();
      result.destroy();
    });

    it("admin menu also includes the Block item", () => {
      const { result } = makeMenu();
      const blockItem = result.element.querySelector('[data-testid="block-toggle"]');
      expect(blockItem).not.toBeNull();
      result.destroy();
    });

    // Per-action gates: the caller maps the server's KICK_MEMBERS /
    // BAN_MEMBERS / MANAGE_ROLES bits onto these, so a moderator holding only
    // some of them must not see the rest.
    describe("per-action permission gates", () => {
      /** Top-level item labels (role submenu entries share the item class). */
      function topLevelLabels(el: HTMLElement): string[] {
        return Array.from(el.children)
          .filter((c) => c.classList.contains("context-menu__item"))
          .map((c) => c.firstChild?.textContent ?? "");
      }

      it("omits Change Role when canManageRoles is false", () => {
        const { result } = makeMenu({ canManageRoles: false });
        const labels = topLevelLabels(result.element);
        expect(labels).not.toContain("Change Role");
        expect(result.element.querySelector(".context-menu__submenu")).toBeNull();
        expect(labels).toContain("Force Logout");
        expect(labels).toContain("Ban");
        result.destroy();
      });

      it("omits Force Logout when canKick is false", () => {
        const { result } = makeMenu({ canKick: false });
        const labels = topLevelLabels(result.element);
        expect(labels).not.toContain("Force Logout");
        expect(labels).toContain("Ban");
        result.destroy();
      });

      it("omits the whole ban flow when canBan is false", () => {
        const { result } = makeMenu({ canBan: false });
        const labels = topLevelLabels(result.element);
        expect(labels).not.toContain("Ban");
        expect(result.element.querySelector('[data-testid="ban-confirm"]')).toBeNull();
        expect(labels).toContain("Force Logout");
        expect(labels).toContain("Block");
        result.destroy();
      });

      it("falls back to Block-only when no action bit is held", () => {
        const { result } = makeMenu({ canKick: false, canBan: false, canManageRoles: false });
        expect(topLevelLabels(result.element)).toEqual(["Block"]);
        result.destroy();
      });
    });
  });

  describe("MemberContextMenu - Developer Mode Copy User ID", () => {
    let writeText: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    });
    afterEach(() => setDeveloperMode(false));

    function open(showAdminActions: boolean) {
      const result = createMemberContextMenu({
        x: 0,
        y: 0,
        userId: 77,
        username: "u",
        currentRole: "member",
        availableRoles: ["member"],
        showAdminActions,
        isBlocked: false,
        onToggleBlock: vi.fn(async () => {}),
        onKick: vi.fn(async () => {}),
        onBan: vi.fn(async () => {}),
        onChangeRole: vi.fn(async () => {}),
      });
      container.appendChild(result.element);
      return result;
    }
    const labels = (el: HTMLElement): (string | null)[] =>
      Array.from(el.querySelectorAll(".context-menu__item")).map((i) => i.textContent);

    it.each([true, false])("copies the user id when on (admin=%s)", (admin) => {
      setDeveloperMode(true);
      const { element, destroy } = open(admin);
      const item = Array.from(element.querySelectorAll<HTMLElement>(".context-menu__item")).find(
        (i) => i.textContent === "Copy User ID",
      );
      expect(item).toBeDefined();
      item!.click();
      expect(writeText).toHaveBeenCalledWith("77");
      destroy();
    });

    it("leaves it out when off", () => {
      setDeveloperMode(false);
      const { element, destroy } = open(true);
      expect(labels(element)).not.toContain("Copy User ID");
      destroy();
    });
  });
});

describe("MemberContextMenu - full menu (3C-3)", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    setDeveloperMode(false);
    container.remove();
  });

  function open(overrides: Partial<MemberContextMenuOptions> = {}) {
    const options: MemberContextMenuOptions = {
      x: 0,
      y: 0,
      userId: 5,
      username: "Dave",
      currentRole: "member",
      availableRoles: ["admin", "member"],
      showAdminActions: false,
      isBlocked: false,
      onToggleBlock: vi.fn(async () => {}),
      onKick: vi.fn(async () => {}),
      onBan: vi.fn(async () => {}),
      onChangeRole: vi.fn(async () => {}),
      ...overrides,
    };
    const result = createMemberContextMenu(options);
    container.appendChild(result.element);
    return result;
  }

  /** Top-level rows in order; a submenu trigger reports its own label only. */
  function labels(el: HTMLElement): string[] {
    return Array.from(el.children)
      .filter((c) => c.classList.contains("context-menu__item"))
      .map((c) => c.firstChild?.textContent ?? "");
  }

  function row(el: HTMLElement, label: string): HTMLElement {
    const found = Array.from(el.querySelectorAll<HTMLElement>(".context-menu__item")).find(
      (i) => i.firstChild?.textContent === label,
    );
    if (found === undefined) throw new Error(`no menu row "${label}"`);
    return found;
  }

  function voiceMod(over: Partial<VoiceModMenuOptions> = {}): VoiceModMenuOptions {
    return {
      serverMuted: false,
      serverDeafened: false,
      moveTargets: [],
      onServerMute: vi.fn(),
      onServerDeafen: vi.fn(),
      onMove: vi.fn(),
      onDisconnect: vi.fn(),
      ...over,
    };
  }

  // (1)
  it("puts Profile first and calls onProfile", () => {
    const onProfile = vi.fn();
    const { element, destroy } = open({ onProfile, onMention: vi.fn() });
    expect(labels(element)[0]).toBe("Profile");
    row(element, "Profile").click();
    expect(onProfile).toHaveBeenCalledTimes(1);
    destroy();
  });

  // (2)
  it("Mention calls onMention and closes the menu", () => {
    const onMention = vi.fn();
    const { element } = open({ onMention });
    row(element, "Mention").click();
    expect(onMention).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".context-menu")).toBeNull();
  });

  it("greys Mention with its reason as the title when it is unavailable", () => {
    const onMention = vi.fn();
    const { element, destroy } = open({ onMention, mentionDisabledReason: "No composer" });
    const mention = row(element, "Mention");
    expect(mention.getAttribute("aria-disabled")).toBe("true");
    expect(mention.title).toBe("No composer");
    mention.click();
    expect(onMention).not.toHaveBeenCalled();
    expect(container.querySelector(".context-menu")).not.toBeNull();
    destroy();
  });

  // (3)
  it("shows Message and Call only when their callbacks are given", () => {
    const none = open({ onProfile: vi.fn() });
    expect(labels(none.element)).toEqual(["Profile", "Block"]);
    none.destroy();

    const onMessage = vi.fn();
    const onCall = vi.fn();
    const both = open({ onProfile: vi.fn(), onMessage, onCall });
    expect(labels(both.element)).toEqual(["Profile", "Message", "Call", "Block"]);
    row(both.element, "Message").click();
    expect(onMessage).toHaveBeenCalledWith();
    expect(container.querySelector(".context-menu")).toBeNull();
  });

  // (4)
  it("renders the voice trio from the options, flips the labels and fires Disconnect", () => {
    const mod = voiceMod({ serverMuted: true, serverDeafened: false });
    const { element } = open({ voiceMod: mod });
    expect(labels(element)).toEqual(["Server Unmute", "Server Deafen", "Disconnect", "Block"]);
    row(element, "Server Deafen").click();
    expect(mod.onServerDeafen).toHaveBeenCalledWith(true);

    const again = open({ voiceMod: mod });
    row(again.element, "Server Unmute").click();
    expect(mod.onServerMute).toHaveBeenCalledWith(false);

    const third = open({ voiceMod: mod });
    row(third.element, "Disconnect").click();
    expect(mod.onDisconnect).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".context-menu")).toBeNull();
  });

  // (5)
  it.each([
    ["a string verdict", "Voice moderation is unavailable", "Voice moderation is unavailable"],
    [
      "a disabledReason while offline",
      voiceMod({ disabledReason: "Not connected" }),
      "Not connected",
    ],
  ] as const)("greys all three voice rows for %s", (_name, mod, reason) => {
    const { element, destroy } = open({ voiceMod: mod });
    const rows = ["Server Mute", "Server Deafen", "Disconnect"].map((l) => row(element, l));
    for (const r of rows) {
      expect(r.getAttribute("aria-disabled")).toBe("true");
      expect(r.title).toBe(reason);
      r.click();
    }
    if (typeof mod !== "string") {
      expect(mod.onServerMute).not.toHaveBeenCalled();
      expect(mod.onServerDeafen).not.toHaveBeenCalled();
      expect(mod.onDisconnect).not.toHaveBeenCalled();
    }
    expect(container.querySelector(".context-menu")).not.toBeNull();
    destroy();
  });

  describe("Timeout", () => {
    const moderating = (over: Partial<MemberContextMenuOptions> = {}) => ({
      showAdminActions: true,
      canKick: false,
      canBan: false,
      canManageRoles: false,
      canTimeout: true,
      ...over,
    });

    // (6)
    it("lists the six presets in order and sends their seconds", async () => {
      const onTimeout = vi.fn(async (_seconds: number) => {});
      const { element, destroy } = open(
        moderating({ onTimeout, onRemoveTimeout: vi.fn(async () => {}), timeoutState: "none" }),
      );
      const sub = row(element, "Timeout").querySelector<HTMLElement>(".context-menu__submenu")!;
      const presets = Array.from(sub.querySelectorAll<HTMLElement>(".context-menu__item"));
      expect(presets.map((p) => p.textContent)).toEqual([
        "60 Seconds",
        "5 Minutes",
        "10 Minutes",
        "1 Hour",
        "1 Day",
        "1 Week",
      ]);
      for (const preset of presets) {
        preset.click();
        // oxlint-disable-next-line no-await-in-loop -- each click must settle before the next
        await Promise.resolve();
        // oxlint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
      expect(onTimeout.mock.calls.map((c) => c[0])).toEqual([60, 300, 600, 3600, 86400, 604800]);
      destroy();
    });

    // (7)
    it("keeps one in-flight guard across all presets", async () => {
      let finish: () => void = () => {};
      const onTimeout = vi.fn(
        () =>
          new Promise<void>((res) => {
            finish = res;
          }),
      );
      const { element, destroy } = open(moderating({ onTimeout, timeoutState: "none" }));
      const presets = Array.from(
        row(element, "Timeout").querySelectorAll<HTMLElement>(
          ".context-menu__submenu .context-menu__item",
        ),
      );
      presets[0]!.click();
      presets[3]!.click();
      presets[0]!.click();
      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(onTimeout).toHaveBeenCalledWith(60);

      finish();
      await Promise.resolve();
      await Promise.resolve();
      presets[3]!.click();
      expect(onTimeout).toHaveBeenCalledTimes(2);
      expect(onTimeout).toHaveBeenLastCalledWith(3600);
      destroy();
    });

    // (8)
    it("offers only Remove Timeout when a timeout is active, and one click lifts it", () => {
      const onRemoveTimeout = vi.fn(async () => {});
      const { element, destroy } = open(
        moderating({ onTimeout: vi.fn(async () => {}), onRemoveTimeout, timeoutState: "active" }),
      );
      expect(labels(element)).toEqual(["Remove Timeout", "Block"]);
      const remove = row(element, "Remove Timeout");
      remove.click();
      remove.click();
      expect(onRemoveTimeout).toHaveBeenCalledTimes(1);
      destroy();
    });

    // (9)
    it("offers both when the state is unknown (an older server)", () => {
      const { element, destroy } = open(
        moderating({
          onTimeout: vi.fn(async () => {}),
          onRemoveTimeout: vi.fn(async () => {}),
          timeoutState: "unknown",
        }),
      );
      expect(labels(element)).toEqual(["Timeout", "Remove Timeout", "Block"]);
      destroy();
    });

    // (10)
    it("offers neither without the timeout callbacks", () => {
      const { element, destroy } = open(moderating());
      expect(labels(element)).toEqual(["Block"]);
      destroy();
    });

    it("offers neither when canTimeout is false", () => {
      const { element, destroy } = open(
        moderating({
          canTimeout: false,
          onTimeout: vi.fn(async () => {}),
          onRemoveTimeout: vi.fn(async () => {}),
        }),
      );
      expect(labels(element)).toEqual(["Block"]);
      destroy();
    });
  });

  // (11)
  it("on yourself shows Profile and Mention only, never Message, Call, moderation or Block", () => {
    const { element, destroy } = open({
      isSelf: true,
      showAdminActions: true,
      onProfile: vi.fn(),
      onMention: vi.fn(),
      onMessage: vi.fn(),
      onCall: vi.fn(),
      voiceMod: voiceMod(),
      onTimeout: vi.fn(async () => {}),
      onRemoveTimeout: vi.fn(async () => {}),
    });
    expect(labels(element)).toEqual(["Profile", "Mention"]);
    destroy();
  });

  it("on yourself adds Copy User ID in Developer Mode", () => {
    setDeveloperMode(true);
    const { element, destroy } = open({
      isSelf: true,
      onProfile: vi.fn(),
      onMention: vi.fn(),
    });
    expect(labels(element)).toEqual(["Profile", "Mention", "Copy User ID"]);
    destroy();
  });

  // (12)
  it("orders a full admin menu for a member in voice, Copy User ID directly above Block", () => {
    setDeveloperMode(true);
    const { element, destroy } = open({
      showAdminActions: true,
      canKick: true,
      canBan: true,
      canManageRoles: true,
      canTimeout: true,
      timeoutState: "none",
      onProfile: vi.fn(),
      onMention: vi.fn(),
      onMessage: vi.fn(),
      onCall: vi.fn(),
      voiceMod: voiceMod(),
      onTimeout: vi.fn(async () => {}),
      onRemoveTimeout: vi.fn(async () => {}),
    });
    expect(labels(element)).toEqual([
      "Profile",
      "Mention",
      "Message",
      "Call",
      "Server Mute",
      "Server Deafen",
      "Disconnect",
      "Change Role",
      "Timeout",
      "Force Logout",
      "Ban",
      "Copy User ID",
      "Block",
    ]);
    destroy();
  });

  it("tells its owner once when the menu closes, by any path", () => {
    const onClosed = vi.fn();
    const { destroy } = open({ onClosed });
    destroy();
    destroy();
    expect(onClosed).toHaveBeenCalledTimes(1);
  });
});
