import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "@lib/api";
import { Permission } from "@lib/types";
import { setRunningScreenLayout } from "@lib/prefs/screenLayout";
import { authStore } from "@stores/auth.store";
import { channelsStore, setRoles } from "@stores/channels.store";
import { membersStore } from "@stores/members.store";
import { setConnectionStatus, uiStore } from "@stores/ui.store";
import { attachServerMenu } from "../../../src/pages/main-page/ServerMenu";
import {
  createServerHeader,
  type ServerHeader,
} from "../../../src/features/server-header/serverHeader";
import { resetChannelsState, signInAs } from "../../helpers/storeSeeds";
import { resetMembersState } from "../../helpers/storeResets";
import { resetUiState } from "../../helpers/dmHarness";

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

describe("createServerHeader under Command Deck", () => {
  const MODERATOR = Permission.VIEW_AUDIT_LOG | Permission.MODERATE_MEMBERS;
  const led = (header: ServerHeader): HTMLElement =>
    header.element.querySelector<HTMLElement>(".server-root .deck-led")!;
  const connect = (status: Parameters<typeof setConnectionStatus>[0]): void => {
    setConnectionStatus(status);
    uiStore.flush();
  };
  const openMenus = (): number => document.querySelectorAll("[role='menu']").length;

  beforeEach(() => {
    resetChannelsState();
    resetMembersState();
    resetUiState();
    signInAs({ id: 9, username: "U", avatar: null, role: "Member" });
    setRunningScreenLayout("deck");
  });
  afterEach(() => {
    setRunningScreenLayout("classic");
    document.body.replaceChildren();
  });

  it("draws the strip over the root row, with the menu button as the anchor", () => {
    signInWithRole("Owner", Permission.ADMINISTRATOR);
    const header = create();
    expect(header.element.className).toBe("unified-sidebar-header deck-server-header");
    expect([...header.element.children].map((c) => c.className)).toEqual([
      "server-tree-strip",
      "server-root",
    ]);
    expect(header.element.querySelector(".server-tree-strip-label")?.textContent).toBe(
      "Server tree",
    );

    const anchor = header.menuAnchor;
    expect(anchor.dataset["testid"]).toBe("server-menu-btn");
    expect(anchor.getAttribute("aria-haspopup")).toBe("menu");
    expect(anchor.getAttribute("aria-expanded")).toBe("false");
    expect(anchor.getAttribute("aria-label")).toBe("Server menu");
    expect(anchor.classList.contains("server-name")).toBe(false);
    const strip = [...header.element.querySelectorAll(".server-tree-strip button")].map(
      (b) => (b as HTMLElement).dataset["testid"],
    );
    expect(strip).toEqual(["server-menu-btn", "invite-btn", "audit-log-btn", "moderation-btn"]);
    for (const b of header.element.querySelectorAll(".server-tree-strip button")) {
      expect(b.querySelector("svg")?.getAttribute("width")).toBe("14");
    }

    const name = header.element.querySelector(".server-root h2")!;
    expect(name.id).toBe("server-tree-name");
    expect((name as HTMLElement).dataset["testid"]).toBe("server-name");
    expect(name.textContent).toBe("Test Server");
    expect(header.element.querySelector(".server-root .server-online")?.textContent).toBe(
      "0 online",
    );
    expect(led(header).getAttribute("aria-hidden")).toBe("true");
    expect(header.element.querySelector(".deck-connection-text")).toBeNull();
    header.destroy();
  });

  it("shows the menu button to everyone and the other three by permission", () => {
    signInWithRole("Member", Permission.SEND_MESSAGES);
    const header = create();
    expect(shown(q(header, "server-menu-btn"))).toBe(true);
    expect(shown(q(header, "invite-btn"))).toBe(false);
    expect(shown(q(header, "audit-log-btn"))).toBe(false);
    expect(shown(q(header, "moderation-btn"))).toBe(false);
    header.destroy();
  });

  // Edge case 1: the permission goes while the button holds focus.
  it("moves focus to the menu button when the focused Moderation button hides", () => {
    signInWithRole("Moderator", MODERATOR);
    const header = create();
    document.body.appendChild(header.element);
    const moderation = q(header, "moderation-btn")!;
    moderation.focus();
    expect(document.activeElement).toBe(moderation);

    signInWithRole("Member", Permission.SEND_MESSAGES);
    authStore.flush();
    expect(shown(moderation)).toBe(false);
    expect(document.activeElement).toBe(header.menuAnchor);
    header.destroy();
  });

  it("leaves focus alone when a button that does not hold it hides", () => {
    signInWithRole("Moderator", MODERATOR);
    const header = create();
    document.body.appendChild(header.element);
    const invite = q(header, "invite-btn")!;
    invite.focus();
    signInWithRole("Member", Permission.SEND_MESSAGES);
    authStore.flush();
    expect(document.activeElement).not.toBe(header.menuAnchor);
    header.destroy();
  });

  // Edge case 2: a reconnect or a rename while the menu is attached.
  it("follows a reconnect and a rename in place, and the menu stays on the same button", () => {
    const header = create();
    document.body.appendChild(header.element);
    const owner = new AbortController();
    const onInvite = vi.fn();
    attachServerMenu(
      header.menuAnchor,
      {
        onInvite,
        onMarkRead: vi.fn(),
        onNotificationSettings: vi.fn(),
        onCreateChannel: vi.fn(),
        onCreateCategory: vi.fn(),
        onServerSettings: vi.fn(),
      },
      owner.signal,
    );
    const anchor = header.menuAnchor;
    const dot = led(header);
    const name = header.element.querySelector(".server-root h2")!;

    connect("connected");
    authStore.setState((p) => ({ ...p, serverName: "Renamed" }));
    authStore.flush();
    seedOnline([1, 2]);
    expect(dot.dataset["state"]).toBe("connected");
    connect("reconnecting");
    expect(dot.dataset["state"]).toBe("reconnecting");
    expect(name.textContent).toBe("Renamed");
    expect(header.element.querySelector(".server-online")?.textContent).toBe("2 online");
    expect(header.menuAnchor).toBe(anchor);
    expect(led(header)).toBe(dot);
    // The element on the page is still the one the menu was attached to.
    const onPage = q(header, "server-menu-btn")!;
    expect(onPage).toBe(anchor);

    onPage.click();
    expect(openMenus()).toBe(1);
    expect(anchor.getAttribute("aria-expanded")).toBe("true");
    owner.abort();
    header.destroy();
  });

  it("releases the status dot on destroy", () => {
    const header = create();
    connect("connected");
    expect(led(header).dataset["state"]).toBe("connected");
    header.destroy();
    connect("reconnecting");
    expect(led(header).dataset["state"]).toBe("connected");
    expect(() => header.destroy()).not.toThrow();
  });
});
