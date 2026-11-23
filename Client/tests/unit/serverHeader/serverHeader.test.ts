import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "@lib/api";
import { Permission } from "@lib/types";
import { authStore } from "@stores/auth.store";
import { channelsStore, setRoles } from "@stores/channels.store";
import { membersStore } from "@stores/members.store";
import {
  createServerHeader,
  type ServerHeader,
} from "../../../src/features/server-header/serverHeader";
import { resetChannelsState, signInAs } from "../../helpers/storeSeeds";
import { resetMembersState } from "../../helpers/storeResets";

const q = (header: ServerHeader, testId: string): HTMLElement | null =>
  header.element.querySelector(`[data-testid='${testId}']`);

const shown = (el: HTMLElement | null): boolean => el !== null && el.style.display !== "none";

function create(
  overrides: { host?: string; toast?: { show: () => void }; openInvite?: () => void } = {},
): ServerHeader {
  const api = { getConfig: () => ({ host: overrides.host ?? "localhost:8443" }) } as ApiClient;
  return createServerHeader({
    api,
    getToast: () => (overrides.toast === undefined ? null : (overrides.toast as never)),
    destinations: { moderation: { build: () => document.createElement("div") } },
    onOpenView: vi.fn(),
    openInvite: overrides.openInvite ?? vi.fn(),
  });
}

function signInWithRole(role: string, permissions: number): void {
  setRoles([{ id: 9, name: role, color: null, permissions }]);
  signInAs({ id: 9, username: "U", avatar: null, role });
}

function seedOnline(ids: readonly number[]): void {
  membersStore.setState((p) => ({
    ...p,
    members: new Map(ids.map((id) => [id, { id, username: `u${id}`, status: "online" } as never])),
  }));
  membersStore.flush();
}

describe("createServerHeader", () => {
  beforeEach(() => {
    resetChannelsState();
    resetMembersState();
    signInAs({ id: 9, username: "U", avatar: null, role: "Member" });
  });
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("draws the icon, the menu anchor with the server name, the count and the three buttons", () => {
    signInWithRole("Owner", Permission.ADMINISTRATOR);
    const header = create();
    expect(header.element.className).toBe("unified-sidebar-header");
    expect(header.menuAnchor.dataset["testid"]).toBe("server-name");
    expect(header.menuAnchor.getAttribute("aria-haspopup")).toBe("menu");
    expect(header.menuAnchor.getAttribute("aria-expanded")).toBe("false");
    expect(header.menuAnchor.querySelector(".server-name-text")?.textContent).toBe("Test Server");
    expect(header.element.querySelector(".server-online")?.textContent).toBe("0 online");
    const actions = [...header.element.querySelectorAll(".sidebar-header-action")].map(
      (b) => (b as HTMLElement).dataset["testid"],
    );
    expect(actions).toEqual(["invite-btn", "audit-log-btn", "moderation-btn"]);
    header.destroy();
  });

  // Edge case 1: `ready` lands, or a role changes, after the header is built.
  it("shows and hides the three buttons when permissions arrive after creation", () => {
    signInWithRole("Moderator", Permission.SEND_MESSAGES);
    setRoles([]);
    const header = create();
    expect(shown(q(header, "audit-log-btn"))).toBe(false);
    expect(shown(q(header, "invite-btn"))).toBe(false);
    expect(shown(q(header, "moderation-btn"))).toBe(false);

    setRoles([
      {
        id: 9,
        name: "Moderator",
        color: null,
        permissions: Permission.VIEW_AUDIT_LOG | Permission.MODERATE_MEMBERS,
      },
    ]);
    channelsStore.flush();
    expect(shown(q(header, "audit-log-btn"))).toBe(true);
    expect(shown(q(header, "moderation-btn"))).toBe(true);
    expect(shown(q(header, "invite-btn"))).toBe(false);

    // A role change on the signed-in user is the other subscription.
    signInWithRole("Member", Permission.MANAGE_INVITES);
    authStore.flush();
    expect(shown(q(header, "audit-log-btn"))).toBe(false);
    expect(shown(q(header, "invite-btn"))).toBe(true);
    header.destroy();
  });

  it("the invite button opens the invite flow", () => {
    const openInvite = vi.fn();
    const header = create({ openInvite });
    q(header, "invite-btn")?.click();
    expect(openInvite).toHaveBeenCalledTimes(1);
    header.destroy();
  });

  it("follows a rename and the online count while it lives", () => {
    const header = create();
    authStore.setState((p) => ({ ...p, serverName: "Renamed" }));
    authStore.flush();
    seedOnline([1, 2]);
    expect(header.menuAnchor.querySelector(".server-name-text")?.textContent).toBe("Renamed");
    expect(header.element.querySelector(".server-online")?.textContent).toBe("2 online");
    header.destroy();
  });

  // Edge case 2: a remount on server switch destroys the old header while the
  // stores it watched keep changing.
  it("writes nothing and throws nothing after destroy, whichever store changes", () => {
    signInWithRole("Moderator", Permission.SEND_MESSAGES);
    setRoles([]);
    const header = create();
    const before = header.element.outerHTML;
    header.destroy();

    expect(() => {
      setRoles([
        {
          id: 9,
          name: "Moderator",
          color: null,
          permissions: Permission.VIEW_AUDIT_LOG | Permission.MODERATE_MEMBERS,
        },
      ]);
      channelsStore.flush();
      signInWithRole("Admin", Permission.ADMINISTRATOR);
      authStore.setState((p) => ({ ...p, serverName: "Elsewhere" }));
      authStore.flush();
      seedOnline([1, 2, 3]);
    }).not.toThrow();

    expect(header.element.outerHTML).toBe(before);
    // A second destroy is harmless.
    expect(() => header.destroy()).not.toThrow();
  });

  it("toasts instead of opening a bogus URL with no host", () => {
    const show = vi.fn();
    const header = create({ host: "", toast: { show } });
    header.openAdmin("audit");
    expect(show).toHaveBeenCalledWith("Not connected to a server", "error");
    header.destroy();
  });
});
