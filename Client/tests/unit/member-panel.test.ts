import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as voiceSession from "../helpers/voiceSessionMock";

vi.mock("@lib/voice/livekitSession", () =>
  voiceSession.withOverrides({
    switchInputDevice: vi.fn().mockResolvedValue(undefined),
    switchOutputDevice: vi.fn().mockResolvedValue(undefined),
  }),
);

vi.mock("@components/MemberList", () => ({
  createMemberList: vi.fn().mockImplementation(() => ({
    mount: vi.fn((container: HTMLElement) => {
      const root = document.createElement("div");
      root.className = "member-list";
      root.dataset.testid = "member-list";
      container.appendChild(root);
    }),
    destroy: vi.fn(),
  })),
}));

const openUserReport = vi.fn();
vi.mock("../../src/features/reports/openers", () => ({ openUserReport }));
const openBanDialog = vi.fn();
vi.mock("../../src/features/moderation/BanDialog", () => ({ openBanDialog }));

import { createMemberPanel, type MemberPanelOptions } from "../../src/features/members/memberPanel";
import { memberPanelUi } from "../../src/pages/main-page/SidebarMemberSection";
import { membersStore } from "../../src/stores/members.store";
import { channelsStore, setRoles } from "../../src/stores/channels.store";
import { createMemberList } from "@components/MemberList";
import { Permission } from "../../src/lib/types";
import { resetMembersState } from "../helpers/storeResets";
import { signInAsAdmin } from "../helpers/storeSeeds";

function resetStores(): void {
  signInAsAdmin("testuser", { token: null });
  resetMembersState();
  channelsStore.setState(() => ({
    categories: [],
    channels: new Map(),
    activeChannelId: null,
    roles: [
      { id: 2, name: "admin", color: null, permissions: Permission.BAN_MEMBERS },
      { id: 4, name: "member", color: null, permissions: 0 },
    ],
  }));
}

function opts(): MemberPanelOptions {
  return {
    ui: memberPanelUi,
    api: {
      adminListUsers: vi.fn().mockResolvedValue([]),
      adminUnbanMember: vi.fn().mockResolvedValue(undefined),
    } as unknown as MemberPanelOptions["api"],
    getToast: vi.fn().mockReturnValue({ show: vi.fn() }),
  };
}

describe("memberPanel", () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    resetStores();
    vi.mocked(createMemberList).mockClear();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
    vi.restoreAllMocks();
  });

  it("mounts the list and the banned section into a host that is not the sidebar", () => {
    const panel = createMemberPanel(opts());
    host.appendChild(panel.element);

    expect(panel.element.classList.contains("member-panel")).toBe(true);
    expect(host.querySelector(".sidebar-members-section")).toBeNull();
    const children = Array.from(panel.element.children);
    expect(children[0]?.getAttribute("data-testid")).toBe("member-list");
    expect(children[children.length - 1]?.getAttribute("data-testid")).toBe("sidebar-banned");
    panel.destroy();
  });

  it("destroy removes both store subscriptions and closes popups it opened", () => {
    const unsubMembers = vi.fn();
    const unsubChannels = vi.fn();
    vi.spyOn(membersStore, "subscribeSelector").mockReturnValue(unsubMembers);
    vi.spyOn(channelsStore, "subscribeSelector").mockReturnValue(unsubChannels);

    const panel = createMemberPanel(opts());
    const list = vi.mocked(createMemberList).mock.results[0]!.value as { destroy: () => void };

    panel.destroy();
    expect(unsubMembers).toHaveBeenCalledTimes(1);
    expect(unsubChannels).toHaveBeenCalledTimes(1);
    // The list's own destroy is what closes the popups it opened.
    expect(list.destroy).toHaveBeenCalledTimes(1);

    // A second destroy (host teardown after an explicit one) does nothing.
    panel.destroy();
    expect(unsubMembers).toHaveBeenCalledTimes(1);
    expect(list.destroy).toHaveBeenCalledTimes(1);
  });

  it("a report or ban dialog whose chunk loads after destroy opens nothing", async () => {
    openUserReport.mockClear();
    openBanDialog.mockClear();
    const live = createMemberPanel(opts());
    const liveOpts = vi.mocked(createMemberList).mock.calls[0]![0];
    liveOpts.onReportUser?.(5, "bob");
    liveOpts.onBan?.(5, "bob", "Bob");
    await vi.dynamicImportSettled();
    expect(openUserReport).toHaveBeenCalledTimes(1);
    expect(openBanDialog).toHaveBeenCalledTimes(1);
    live.destroy();

    openUserReport.mockClear();
    openBanDialog.mockClear();
    const gone = createMemberPanel(opts());
    const goneOpts = vi.mocked(createMemberList).mock.calls[1]![0];
    goneOpts.onReportUser?.(5, "bob");
    goneOpts.onBan?.(5, "bob", "Bob");
    gone.destroy();
    await vi.dynamicImportSettled();
    expect(openUserReport).not.toHaveBeenCalled();
    expect(openBanDialog).not.toHaveBeenCalled();
  });

  it("forwards Message, Call and voice moderation only when given", () => {
    const onMessageUser = vi.fn();
    const onCallUser = vi.fn();
    createMemberPanel({
      ...opts(),
      onMessageUser,
      onCallUser,
      onVoiceModerate: {} as never,
    }).destroy();
    const full = vi.mocked(createMemberList).mock.calls[0]![0];
    expect(full.onMessageUser).toBe(onMessageUser);
    expect(full.onCallUser).toBe(onCallUser);
    expect(full.voiceModFor).toBeTypeOf("function");

    createMemberPanel(opts()).destroy();
    const bare = vi.mocked(createMemberList).mock.calls[1]![0];
    expect(bare.onMessageUser).toBeUndefined();
    expect(bare.onCallUser).toBeUndefined();
    expect(bare.voiceModFor).toBeUndefined();
  });

  it("lists bans in force for a moderator and re-walks on a roster change", async () => {
    const user = (id: number, name: string, extra: object = {}) => ({
      id,
      username: name,
      banned: true,
      role_id: 4,
      role_name: "member",
      status: "offline",
      created_at: "2026-01-01T00:00:00Z",
      ...extra,
    });
    const o = opts();
    vi.mocked(o.api.adminListUsers).mockResolvedValue([
      user(10, "banned-forever"),
      user(11, "ban-served", { ban_expires: "2000-01-01T00:00:00Z" }),
    ] as never);
    const panel = createMemberPanel(o);
    host.appendChild(panel.element);

    await vi.waitFor(() => expect(panel.element.querySelectorAll(".banned-row")).toHaveLength(1));
    expect(panel.element.querySelector(".banned-name")?.textContent).toBe("banned-forever");

    panel.destroy();
    setRoles([]);
    await Promise.resolve();
    expect(o.api.adminListUsers).toHaveBeenCalledTimes(1);
  });
  it("offers Unban only for bans the viewer outranks", async () => {
    channelsStore.setState((prev) => ({
      ...prev,
      roles: [
        { id: 1, name: "owner", color: null, permissions: Permission.BAN_MEMBERS, position: 100 },
        { id: 3, name: "senior", color: null, permissions: 0, position: 60 },
        { id: 2, name: "admin", color: null, permissions: Permission.BAN_MEMBERS, position: 50 },
        { id: 4, name: "member", color: null, permissions: 0, position: 1 },
      ],
    }));
    const banned = (id: number, name: string, roleName: string, extra: object = {}) => ({
      id,
      username: name,
      banned: true,
      role_id: 4,
      role_name: roleName,
      status: "offline",
      created_at: "2026-01-01T00:00:00Z",
      ...extra,
    });
    const o = opts();
    vi.mocked(o.api.adminListUsers).mockResolvedValue([
      banned(10, "low", "member"),
      banned(11, "peer", "admin"),
      banned(12, "boss", "owner"),
      banned(13, "multi", "member", { role_ids: [3, 4] }),
    ] as never);
    const panel = createMemberPanel(o);
    host.appendChild(panel.element);

    await vi.waitFor(() => expect(panel.element.querySelectorAll(".banned-row")).toHaveLength(4));
    const withButton = [...panel.element.querySelectorAll(".banned-row")]
      .filter((row) => row.querySelector('[data-testid="unban-member"]') !== null)
      .map((row) => row.querySelector(".banned-name")?.textContent);
    expect(withButton).toEqual(["low"]);
    panel.destroy();
  });
});
