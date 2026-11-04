import { afterEach, beforeEach, expect, vi } from "vitest";
import type { MemberListOptions } from "@components/MemberList";
import { membersStore } from "@stores/members.store";
import type { Member } from "@stores/members.store";
import { setRoles } from "@stores/channels.store";
import { type UserStatus } from "../../src/lib/types";
import { applyThemeByName } from "@lib/prefs/themes";
import { resetMembersState } from "./storeResets";
import { resetAuthState } from "./storeSeeds";

/**
 * Give the role clamp (B9 Q13) the dark theme's surfaces to measure names
 * against; a theme switch is what empties its cache.
 */
export function useDarkSurfaces(): void {
  const html = document.documentElement.style;
  html.setProperty("--bg-primary", "#313338");
  html.setProperty("--bg-secondary", "#2b2d31");
  html.setProperty("--bg-tertiary", "#1e1f22");
  html.setProperty("--bg-input", "#383a40");
  applyThemeByName("dark");
}

export function resetStore(): void {
  resetMembersState();
  // Role list drives member-list grouping/colors — reset so tests that seed
  // roles don't leak into the ones asserting the fallback groups.
  setRoles([]);
  // The moderation-menu gate now reads the live authStore role (see "re-reads
  // the current user's role live..." below), so a user left behind by an
  // earlier test — the "admin"/"owner" role names in particular fall back to
  // isLegacyAdminRole's full-access grant when that name isn't in the
  // per-test role list — would otherwise leak into unrelated gate tests.
  resetAuthState();
}

export function makeMember(overrides: Partial<Member> & { id: number; username: string }): Member {
  return {
    avatar: null,
    role: "member",
    status: "online" as UserStatus,
    ...overrides,
  };
}

export function setTestMembers(members: Member[]): void {
  const map = new Map<number, Member>();
  for (const m of members) {
    map.set(m.id, m);
  }
  membersStore.setState((prev) => ({ ...prev, members: map }));
}

export const testMembers: Member[] = [
  makeMember({ id: 1, username: "Alice", role: "owner", status: "online" as UserStatus }),
  makeMember({ id: 2, username: "Bob", role: "admin", status: "idle" as UserStatus }),
  makeMember({ id: 3, username: "Charlie", role: "moderator", status: "online" as UserStatus }),
  makeMember({ id: 4, username: "Dave", role: "member", status: "offline" as UserStatus }),
  makeMember({ id: 5, username: "Eve", role: "member", status: "online" as UserStatus }),
  makeMember({ id: 6, username: "Frank", role: "admin", status: "online" as UserStatus }),
];

export function defaultOpts(currentUserRole = "admin"): MemberListOptions {
  return {
    currentUserRole,
    onKick: vi.fn().mockResolvedValue(undefined),
    onBan: vi.fn().mockResolvedValue(undefined),
    onChangeRole: vi.fn().mockResolvedValue(undefined),
    onToggleBlock: vi.fn().mockResolvedValue(undefined),
  };
}

/** Right-clicks a member row and lets the lazy menu chunk settle. */
export async function rightClickMember(container: HTMLElement, id: number): Promise<void> {
  const row = container.querySelector(`[data-testid="member-${id}"]`) as HTMLElement;
  row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  await vi.dynamicImportSettled();
}

/** Top-level item labels; submenu role options share the item class. */
export function topMenuLabels(menu: HTMLElement): string[] {
  return Array.from(menu.children)
    .filter((el) => el.classList.contains("context-menu__item"))
    .map((el) => el.firstChild?.textContent ?? "");
}

/**
 * Fresh store and a container on document.body per test; the list `current`
 * returns is destroyed and the container removed afterwards. `bind` gets each
 * new container.
 */
export function useMemberListSuite(
  bind: (container: HTMLDivElement) => void,
  current: () => { destroy?: () => void } | null | undefined,
): void {
  let container: HTMLDivElement;
  beforeEach(() => {
    resetStore();
    container = document.createElement("div");
    document.body.appendChild(container);
    bind(container);
  });
  afterEach(() => {
    current()?.destroy?.();
    container.remove();
  });
}

/** Clicks a member row and waits for its profile popup to open. */
export async function openProfileOf(container: HTMLElement, id: number): Promise<void> {
  const row = container.querySelector<HTMLElement>(`[data-testid="member-${id}"]`)!;
  row.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="user-profile-popup"]')).not.toBeNull(),
  );
}
