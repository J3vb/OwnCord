/**
 * The Change Nickname item of the member context menu (WP 6.4c): it needs the
 * server capability, the MANAGE_NICKNAMES bit (Administrator bypasses it), a
 * strictly higher top role than the target, and a target other than yourself.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMountContainer } from "../helpers/mountContainer";
import { createMemberList } from "@components/MemberList";
import type { MemberListOptions } from "@components/MemberList";
import { membersStore } from "@stores/members.store";
import type { Member } from "@stores/members.store";
import { authStore } from "@stores/auth.store";
import { setRoles } from "@stores/channels.store";
import { Permission, type UserStatus } from "../../src/lib/types";
import {
  applyReadyCapabilities,
  resetServerCapabilities,
} from "../../src/lib/net/serverCapabilities";
import "@components/UserProfilePopup";
import "@components/AdminActions";
import { resetAuthState } from "../helpers/storeSeeds";

globalThis.ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;

const NICK = Permission.MANAGE_NICKNAMES;

function member(id: number, username: string, role: string, displayName: string | null): Member {
  return { id, username, role, displayName, avatar: null, status: "online" as UserStatus };
}

function seedRoles(modPerms: number): void {
  setRoles([
    { id: 1, name: "Owner", color: null, permissions: Permission.ADMINISTRATOR, position: 100 },
    { id: 2, name: "Admin", color: null, permissions: Permission.ADMINISTRATOR, position: 80 },
    { id: 3, name: "Moderator", color: null, permissions: modPerms, position: 60 },
    { id: 4, name: "Moderator2", color: null, permissions: modPerms, position: 60 },
    { id: 5, name: "Member", color: null, permissions: 0, position: 40 },
  ]);
}

function signInAs(id: number, role: string): void {
  authStore.setState(() => ({
    token: "tok",
    user: { id, username: `u${id}`, avatar: null, role },
    serverName: "Test",
    motd: null,
    isAuthenticated: true,
  }));
}

describe("member context menu: Change Nickname", () => {
  let container: HTMLDivElement;
  let list: ReturnType<typeof createMemberList> | null = null;
  const onChangeNickname = vi.fn();

  useMountContainer(
    (c) => {
      container = c;
    },
    () => {
      list?.destroy?.();
      list = null;
      document.body.querySelectorAll(".context-menu").forEach((el) => el.remove());
      resetServerCapabilities();
      setRoles([]);
      resetAuthState();
    },
  );

  beforeEach(() => {
    onChangeNickname.mockReset();
    resetServerCapabilities();
    membersStore.setState((prev) => ({
      ...prev,
      members: new Map(
        [
          member(10, "mod", "Moderator", null),
          member(11, "mod_two", "Moderator2", null),
          member(12, "dave", "Member", "Davey"),
        ].map((m) => [m.id, m]),
      ),
    }));
  });

  async function openMenu(targetId: number): Promise<HTMLElement | null> {
    const opts: MemberListOptions = {
      currentUserRole: "Moderator",
      onKick: vi.fn().mockResolvedValue(undefined),
      onBan: vi.fn(),
      onChangeRole: vi.fn().mockResolvedValue(undefined),
      onToggleBlock: vi.fn().mockResolvedValue(undefined),
      onChangeNickname,
    };
    list = createMemberList(opts);
    list.mount(container);
    const row = container.querySelector(`[data-testid="member-${targetId}"]`) as HTMLElement;
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await vi.dynamicImportSettled();
    return document.body.querySelector<HTMLElement>(".context-menu");
  }

  const item = (): HTMLElement | null =>
    document.body.querySelector<HTMLElement>('[data-testid="member-menu-change-nickname"]');

  it("Change Nickname with bit, rank and capability", async () => {
    seedRoles(NICK);
    signInAs(10, "Moderator");
    applyReadyCapabilities({ manage_nicknames: true });
    await openMenu(12);
    expect(item()?.firstChild?.textContent).toBe("Change Nickname");
    item()!.click();
    // The current nickname is handed to the dialog; the menu closes first.
    expect(onChangeNickname).toHaveBeenCalledWith(12, "dave", "Davey");
    expect(document.body.querySelector(".context-menu")).toBeNull();
  });

  it("Administrator needs no explicit bit", async () => {
    seedRoles(0);
    signInAs(1, "Admin");
    applyReadyCapabilities({ manage_nicknames: true });
    await openMenu(12);
    expect(item()).not.toBeNull();
  });

  it("hidden without capability (old server with the bit)", async () => {
    seedRoles(NICK);
    signInAs(10, "Moderator");
    applyReadyCapabilities({});
    await openMenu(12);
    expect(item()).toBeNull();
  });

  it("hidden without the bit", async () => {
    seedRoles(Permission.MODERATE_MEMBERS);
    signInAs(10, "Moderator");
    applyReadyCapabilities({ manage_nicknames: true });
    await openMenu(12);
    expect(item()).toBeNull();
  });

  it("hidden at equal rank", async () => {
    seedRoles(NICK);
    signInAs(10, "Moderator");
    applyReadyCapabilities({ manage_nicknames: true });
    await openMenu(11);
    expect(item()).toBeNull();
  });

  it("never for self", async () => {
    seedRoles(NICK);
    signInAs(12, "Admin");
    applyReadyCapabilities({ manage_nicknames: true });
    await openMenu(12);
    expect(item()).toBeNull();
  });
});
