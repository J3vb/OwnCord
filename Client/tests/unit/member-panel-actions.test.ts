// The member panel's wiring: the banned section's markup and refresh walk,
// and what each action does when its dialog loads, fails to load, or the
// panel is gone.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A failed import is attempted again on the next one but a loaded module is
// cached, so the lazy chunks are driven through this switchboard: the
// failing run comes first, then the runs where the chunks load.
const chunks = vi.hoisted(() => ({
  fail: false,
  openUserReport: vi.fn(),
  openBanDialog: vi.fn(),
  openNicknameDialog: vi.fn(),
  toggleBlock: vi.fn(),
  confirmAndToggleBlock: vi.fn(),
}));

function arrive(): void {
  if (chunks.fail) throw new Error("chunk failed");
}

vi.mock("../../src/features/reports/openers", () => {
  arrive();
  return { openUserReport: chunks.openUserReport };
});
vi.mock("../../src/features/moderation/BanDialog", () => {
  arrive();
  return { openBanDialog: chunks.openBanDialog };
});
vi.mock("../../src/features/moderation/NicknameDialog", () => {
  arrive();
  return { openNicknameDialog: chunks.openNicknameDialog };
});
vi.mock("../../src/features/blocks/blockActions", () => {
  arrive();
  return {
    toggleBlock: chunks.toggleBlock,
    confirmAndToggleBlock: chunks.confirmAndToggleBlock,
  };
});

import {
  createMemberPanel,
  type MemberPanel,
  type MemberPanelOptions,
} from "../../src/features/members/memberPanel";
import { authStore } from "../../src/stores/auth.store";
import { membersStore } from "../../src/stores/members.store";
import { channelsStore } from "../../src/stores/channels.store";
import { Permission } from "../../src/lib/types";
import type { MemberListOptions } from "../../src/components/MemberList";

interface Harness {
  panel: MemberPanel;
  host: HTMLDivElement;
  list: MemberListOptions;
  focusMember: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  api: {
    adminListUsers: ReturnType<typeof vi.fn>;
    adminUnbanMember: ReturnType<typeof vi.fn>;
    setMemberNickname: ReturnType<typeof vi.fn>;
  };
  ui: {
    createMemberList: ReturnType<typeof vi.fn>;
    buildVoiceModOptions: ReturnType<typeof vi.fn>;
  };
}

const ROLES = [
  { id: 1, name: "owner", color: null, permissions: Permission.BAN_MEMBERS, position: 100 },
  { id: 2, name: "admin", color: null, permissions: Permission.BAN_MEMBERS, position: 50 },
  { id: 4, name: "member", color: null, permissions: 0, position: 1 },
];

function resetStores(): void {
  authStore.setState(() => ({
    token: null,
    user: { id: 1, username: "me", role: "admin", avatar: null, totp_enabled: false },
    serverName: "Test Server",
    motd: null,
    isAuthenticated: true,
  }));
  membersStore.setState(() => ({ members: new Map(), typingUsers: new Map() }));
  channelsStore.setState(() => ({
    categories: [],
    channels: new Map(),
    activeChannelId: null,
    roles: ROLES,
  }));
}

function bannedUser(id: number, name: string, extra: object = {}): object {
  return {
    id,
    username: name,
    banned: true,
    role_id: 4,
    role_name: "member",
    status: "offline",
    created_at: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

let live: MemberPanel[] = [];

/** A roster change, as the dispatcher's member events make one. */
function rosterChanged(): void {
  membersStore.setState((prev) => ({ ...prev, roleRevision: (prev.roleRevision ?? 0) + 1 }));
}

function mount(extra: Partial<MemberPanelOptions> = {}, users: object[] = []): Harness {
  const show = vi.fn();
  const focusMember = vi.fn();
  const api = {
    adminListUsers: vi.fn().mockResolvedValue(users),
    adminUnbanMember: vi.fn().mockResolvedValue(undefined),
    setMemberNickname: vi.fn().mockResolvedValue(undefined),
  };
  let list: MemberListOptions | undefined;
  const ui = {
    createMemberList: vi.fn((o: MemberListOptions) => {
      list = o;
      return {
        mount: (container: HTMLElement) => {
          const root = document.createElement("div");
          root.className = "member-list";
          container.appendChild(root);
        },
        destroy: vi.fn(),
        focusMember,
      };
    }),
    buildVoiceModOptions: vi.fn().mockReturnValue(["voice-option"]),
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const panel = createMemberPanel({
    ui: ui,
    api: api as unknown as MemberPanelOptions["api"],
    getToast: () => ({ show }) as unknown as ReturnType<MemberPanelOptions["getToast"]>,
    ...extra,
  });
  live.push(panel);
  host.appendChild(panel.element);
  return { panel, host, list: list!, focusMember, show, api, ui };
}

/** Let the walk the mount started finish before a test swaps the api. */
async function mountSettled(users: object[] = []): Promise<Harness> {
  const h = mount({}, users);
  await vi.waitFor(() => expect(h.api.adminListUsers).toHaveBeenCalledTimes(1));
  await new Promise((r) => setTimeout(r, 0));
  return h;
}

const bannedRows = (h: Harness): HTMLElement[] => [
  ...h.panel.element.querySelectorAll<HTMLElement>(".banned-row"),
];
const section = (h: Harness): HTMLElement =>
  h.panel.element.querySelector<HTMLElement>("[data-testid='sidebar-banned']")!;

beforeEach(() => {
  resetStores();
  chunks.fail = false;
  for (const fn of [
    chunks.openUserReport,
    chunks.openBanDialog,
    chunks.openNicknameDialog,
    chunks.toggleBlock,
    chunks.confirmAndToggleBlock,
  ]) {
    fn.mockReset();
  }
  chunks.toggleBlock.mockResolvedValue(undefined);
});
afterEach(() => {
  for (const p of live) p.destroy();
  live = [];
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("member panel dialog chunks that cannot load", () => {
  it("tells the member for each action whose dialog could not open", async () => {
    chunks.fail = true;
    const h = mount();
    h.list.onReportUser?.(5, "bob");
    h.list.onBan?.(5, "bob", "Bob");
    h.list.onChangeNickname?.(5, "bob", null);
    await h.list.onToggleBlock?.(5, "bob", true);
    h.list.onBlockFromPopup?.(5, "bob", false);
    await new Promise((r) => setTimeout(r, 300));
    console.log(JSON.stringify(h.show.mock.calls));
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(5));
    const shown = h.show.mock.calls.map((c) => c.join("|"));
    expect(
      shown.filter((s) => s === "Couldn't open the report form. Try again.|error"),
    ).toHaveLength(1);
    expect(shown.filter((s) => s === "Failed to ban member|error")).toHaveLength(1);
    expect(
      shown.filter((s) => s === "Could not change the nickname. Try again.|error"),
    ).toHaveLength(1);
    // Blocking from the menu and unblocking from the popup each say so.
    expect(shown.filter((s) => s === "Failed to block user|error")).toHaveLength(1);
    expect(shown.filter((s) => s === "Failed to unblock user|error")).toHaveLength(1);
  });
});

describe("member panel banned section", () => {
  it("styles the section and hides it while there are no bans", async () => {
    const h = mount();
    await vi.waitFor(() => expect(h.api.adminListUsers).toHaveBeenCalled());
    expect(section(h).className).toBe("sidebar-banned-section");
    expect(section(h).style.display).toBe("none");
  });

  it("shows a styled header, rows and Unban buttons once there are bans", async () => {
    const h = mount({}, [bannedUser(10, "low")]);
    await vi.waitFor(() => expect(bannedRows(h)).toHaveLength(1));
    expect(section(h).style.display).toBe("");
    expect(section(h).style.display).not.toBe("none");
    const header = section(h).querySelector(".banned-header")!;
    expect(header.tagName).toBe("DIV");
    expect(header.textContent).toBe("BANNED");
    const unban = section(h).querySelector<HTMLButtonElement>("[data-testid='unban-member']")!;
    expect(unban.className).toBe("banned-unban-btn");
    expect(unban.textContent).toBe("Unban");
    unban.click();
    await vi.waitFor(() => expect(h.api.adminUnbanMember).toHaveBeenCalledWith(10));
  });

  it("measures the viewer's rank as a member once the account is signed out", async () => {
    // The sign-out lands while the user list is still being fetched.
    let resolve!: (rows: object[]) => void;
    const h = await mountSettled();
    h.api.adminListUsers.mockReset().mockReturnValue(new Promise((r) => (resolve = r)));
    rosterChanged();
    await vi.waitFor(() => expect(h.api.adminListUsers).toHaveBeenCalledTimes(1));
    authStore.setState((prev) => ({ ...prev, user: null }));
    resolve([bannedUser(10, "peer")]);
    await vi.waitFor(() => expect(bannedRows(h)).toHaveLength(1));
    // A member does not outrank a member, so there is nothing to offer.
    expect(bannedRows(h)[0]!.querySelector("[data-testid='unban-member']")).toBeNull();
  });

  it("lists a ban that ends at this very instant as served", async () => {
    const now = Date.parse("2026-09-01T12:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const h = mount({}, [
      bannedUser(10, "ends-now", { ban_expires: "2026-09-01T12:00:00.000Z" }),
      bannedUser(11, "ends-later", { ban_expires: "2026-09-01T12:00:01.000Z" }),
    ]);
    await vi.waitFor(() => expect(bannedRows(h)).toHaveLength(1));
    expect(bannedRows(h)[0]!.querySelector(".banned-name")?.textContent).toBe("ends-later");
  });

  it("reveals the section when a ban arrives after it was hidden", async () => {
    const h = await mountSettled();
    expect(section(h).style.display).toBe("none");
    h.api.adminListUsers.mockResolvedValue([bannedUser(10, "late")]);
    rosterChanged();
    await vi.waitFor(() => expect(bannedRows(h)).toHaveLength(1));
    expect(section(h).style.display).toBe("");
  });

  it("keeps what it already lists when a later fetch fails", async () => {
    const h = await mountSettled([bannedUser(10, "low")]);
    await vi.waitFor(() => expect(bannedRows(h)).toHaveLength(1));
    const row = bannedRows(h)[0]!;
    h.api.adminListUsers.mockRejectedValue(new Error("offline"));
    rosterChanged();
    await vi.waitFor(() => expect(h.api.adminListUsers).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0));
    // The same row element: the section was not rebuilt.
    expect(bannedRows(h)[0]).toBe(row);
  });
});

describe("member panel refresh walk", () => {
  async function controlled(): Promise<{
    h: Harness;
    pending: Array<(rows: object[]) => void>;
  }> {
    const pending: Array<(rows: object[]) => void> = [];
    const h = await mountSettled();
    h.api.adminListUsers
      .mockReset()
      .mockImplementation(() => new Promise<object[]>((r) => pending.push(r)));
    return { h, pending };
  }

  it("walks once more, and only once, after changes that arrive mid-walk", async () => {
    const { h, pending } = await controlled();
    // The mount's own walk was already answered; start a fresh one.
    rosterChanged();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    rosterChanged();
    rosterChanged();
    await Promise.resolve();
    // Nothing runs alongside the walk in flight.
    expect(h.api.adminListUsers).toHaveBeenCalledTimes(1);
    pending[0]!([]);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]!([bannedUser(10, "late")]);
    await vi.waitFor(() => expect(bannedRows(h)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.api.adminListUsers).toHaveBeenCalledTimes(2);
  });

  it("does not walk again when nothing changed during the walk", async () => {
    const { h, pending } = await controlled();
    rosterChanged();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0]!([bannedUser(10, "one")]);
    await vi.waitFor(() => expect(bannedRows(h)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.api.adminListUsers).toHaveBeenCalledTimes(1);
    // Free to start again once the walk has finished.
    rosterChanged();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
  });
});

describe("member panel list wiring", () => {
  it("leaves Message, Call and voice moderation out of the list unless given", () => {
    const bare = mount();
    expect(bare.list).not.toHaveProperty("onMessageUser");
    expect(bare.list).not.toHaveProperty("onCallUser");
    expect(bare.list).not.toHaveProperty("voiceModFor");
  });

  it("builds voice moderation rows from the senders it was given", () => {
    const onVoiceModerate = { onMute: vi.fn() } as never;
    const h = mount({ onVoiceModerate });
    const user = { id: 5 } as never;
    expect(h.list.voiceModFor?.(9, user)).toEqual(["voice-option"]);
    expect(h.ui.buildVoiceModOptions).toHaveBeenCalledWith(9, user, onVoiceModerate);
  });

  it("refreshes the banned list when a ban made from the dialog lands", async () => {
    const h = mount();
    h.list.onBan?.(5, "bob", "Bob");
    await vi.waitFor(() => expect(chunks.openBanDialog).toHaveBeenCalledTimes(1));
    const call = chunks.openBanDialog.mock.calls[0]![0] as {
      onBanned: () => void;
      notify: (msg: string, type: string) => void;
      fallbackFocus: () => void;
    };
    const before = h.api.adminListUsers.mock.calls.length;
    call.onBanned();
    await vi.waitFor(() => expect(h.api.adminListUsers.mock.calls.length).toBe(before + 1));
    call.notify("Banned", "success");
    expect(h.show).toHaveBeenCalledWith("Banned", "success");
    call.fallbackFocus();
    expect(h.focusMember).toHaveBeenCalledWith(5);
  });

  it("opens the nickname dialog with the member's display name", async () => {
    membersStore.setState((prev) => ({
      ...prev,
      members: new Map([
        [
          5,
          {
            id: 5,
            username: "bob",
            displayName: "Bobby",
            avatar: null,
            role: "member",
            status: "online",
          },
        ],
      ]),
    }));
    const h = mount();
    h.list.onChangeNickname?.(5, "bob", "Bobby");
    await vi.waitFor(() => expect(chunks.openNicknameDialog).toHaveBeenCalledTimes(1));
    const call = chunks.openNicknameDialog.mock.calls[0]![0] as {
      name: string;
      username: string;
      current: string | null;
      submit: (name: string | null) => Promise<void>;
      notify: (msg: string, type: string) => void;
      fallbackFocus: () => void;
      signal: AbortSignal;
    };
    expect(call.name).toBe("Bobby");
    expect(call.username).toBe("bob");
    expect(call.current).toBe("Bobby");
    await call.submit("Rob");
    expect(h.api.setMemberNickname).toHaveBeenCalledWith(5, "Rob");
    call.notify("Saved", "success");
    expect(h.show).toHaveBeenCalledWith("Saved", "success");
    call.fallbackFocus();
    expect(h.focusMember).toHaveBeenCalledWith(5);
    expect(call.signal.aborted).toBe(false);
    h.panel.destroy();
    expect(call.signal.aborted).toBe(true);
  });

  it("names a member the roster does not know by their username", async () => {
    const h = mount();
    h.list.onChangeNickname?.(77, "ghost", null);
    await vi.waitFor(() => expect(chunks.openNicknameDialog).toHaveBeenCalledTimes(1));
    const call = chunks.openNicknameDialog.mock.calls[0]![0] as { name: string };
    expect(call.name).toBe("ghost");
  });

  it("opens no nickname dialog for a panel that was destroyed first", async () => {
    const h = mount();
    h.list.onChangeNickname?.(5, "bob", null);
    h.panel.destroy();
    await vi.dynamicImportSettled();
    expect(chunks.openNicknameDialog).not.toHaveBeenCalled();
  });

  it("blocks through the block actions with the panel's api and toast", async () => {
    const h = mount();
    await h.list.onToggleBlock?.(5, "bob", true);
    expect(chunks.toggleBlock).toHaveBeenCalledTimes(1);
    const [deps, userId, username, block] = chunks.toggleBlock.mock.calls[0]!;
    expect(deps.api).toBe(h.api);
    expect([userId, username, block]).toEqual([5, "bob", true]);
    deps.notify("Blocked", "success");
    expect(h.show).toHaveBeenCalledWith("Blocked", "success");
    expect(h.show).toHaveBeenCalledTimes(1);
  });

  it("says the block failed when the request itself throws", async () => {
    const h = mount();
    chunks.toggleBlock.mockRejectedValueOnce(new Error("boom"));
    await h.list.onToggleBlock?.(5, "bob", true);
    expect(h.show).toHaveBeenCalledWith("Failed to block user", "error");
    chunks.toggleBlock.mockRejectedValueOnce(new Error("boom"));
    await h.list.onToggleBlock?.(5, "bob", false);
    expect(h.show).toHaveBeenCalledWith("Failed to unblock user", "error");
  });

  it("confirms a block from the profile popup with the panel's api and toast", async () => {
    const h = mount();
    h.list.onBlockFromPopup?.(5, "bob", true);
    await vi.waitFor(() => expect(chunks.confirmAndToggleBlock).toHaveBeenCalledTimes(1));
    const [deps, userId, username, block] = chunks.confirmAndToggleBlock.mock.calls[0]!;
    expect(deps.api).toBe(h.api);
    expect([userId, username, block]).toEqual([5, "bob", true]);
    deps.notify("Blocked", "info");
    expect(h.show).toHaveBeenCalledWith("Blocked", "info");
    expect(h.show).toHaveBeenCalledTimes(1);
  });
});
