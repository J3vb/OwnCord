import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import * as mocks from "../../helpers/channelSidebarMocks";
import { cascadedDeclaration, varToken } from "../../helpers/app-css";
import { createChannelSidebar } from "../../../src/components/ChannelSidebar";
import {
  addChannel,
  channelsStore,
  setChannels,
  setRoles,
  type Channel,
} from "../../../src/stores/channels.store";
import { authStore } from "../../../src/stores/auth.store";
import { uiStore } from "../../../src/stores/ui.store";
import { voiceStore, updateVoiceState } from "../../../src/stores/voice.store";
import { Permission, type ReadyChannel, type VoiceStatePayload } from "../../../src/lib/types";
import {
  resetStores,
  addVoiceUser,
  testChannels,
  voiceModCallbacks,
  setAdminUser,
} from "../../helpers/channelSidebarHarness";
import { signInAs } from "../../helpers/storeSeeds";

vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());
vi.mock("@lib/ui/toast", () => mocks.uiToastMock());
vi.mock("@lib/net/e2eeCrypto", (importOriginal) => mocks.netE2eeCryptoMock(importOriginal));
vi.mock("../../../src/features/messaging/content/attachments", (importOriginal) =>
  mocks.listAttachmentsMock(importOriginal),
);
vi.mock("../../../src/features/profiles/openUserProfilePopup", () =>
  mocks.profilesOpenUserProfilePopupMock(),
);

const { mockGetUserLocalMute, mockOpenUserProfilePopup } = mocks;

describe("ChannelSidebar", () => {
  let container: HTMLDivElement;
  let sidebar: ReturnType<typeof createChannelSidebar>;
  let onVoiceJoin: Mock<(channelId: number) => void>;
  let onOpenCall: Mock<() => void>;

  beforeEach(() => {
    resetStores();
    mockOpenUserProfilePopup.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    onVoiceJoin = vi.fn<(channelId: number) => void>();
    onOpenCall = vi.fn<() => void>();
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall });
  });

  afterEach(() => {
    sidebar.destroy?.();
    container.remove();
    // Clean up any context menus left on document.body
    document.querySelectorAll(".context-menu").forEach((el) => el.remove());
    document.querySelectorAll(".user-vol-menu").forEach((el) => el.remove());
  });

  // ── Context menu for channel edit/delete ──

  it("right-click on channel opens context menu with Edit and Delete for admin", () => {
    const onEditChannel = vi.fn();
    const onDeleteChannel = vi.fn();
    sidebar.destroy?.();
    setAdminUser();
    sidebar = createChannelSidebar({
      onVoiceJoin,
      onOpenCall,
      onEditChannel,
      onDeleteChannel,
    });

    setChannels(testChannels);
    sidebar.mount(container);

    const channelEl = container.querySelector('[data-channel-id="1"]') as HTMLElement;
    expect(channelEl).not.toBeNull();

    // Dispatch right-click
    channelEl.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        clientX: 100,
        clientY: 200,
      }),
    );

    const ctxMenu = document.querySelector('[data-testid="channel-context-menu"]');
    expect(ctxMenu).not.toBeNull();

    const editItem = document.querySelector('[data-testid="ctx-edit-channel"]');
    expect(editItem).not.toBeNull();
    expect(editItem!.textContent).toBe("Edit Channel");

    const deleteItem = document.querySelector('[data-testid="ctx-delete-channel"]');
    expect(deleteItem).not.toBeNull();
    expect(deleteItem!.textContent).toBe("Delete Channel");
  });

  it("clicking Edit in context menu calls onEditChannel with the correct channel", () => {
    const onEditChannel = vi.fn();
    sidebar.destroy?.();
    setAdminUser();
    sidebar = createChannelSidebar({
      onVoiceJoin,
      onOpenCall,
      onEditChannel,
    });

    setChannels(testChannels);
    sidebar.mount(container);

    const channelEl = container.querySelector('[data-channel-id="1"]') as HTMLElement;
    channelEl.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        clientX: 100,
        clientY: 200,
      }),
    );

    const editItem = document.querySelector('[data-testid="ctx-edit-channel"]') as HTMLElement;
    editItem.click();

    expect(onEditChannel).toHaveBeenCalledTimes(1);
    const calledWith = onEditChannel.mock.calls[0]![0];
    expect(calledWith.id).toBe(1);
    expect(calledWith.name).toBe("general");
  });

  it("clicking Delete in context menu calls onDeleteChannel with the correct channel", () => {
    const onDeleteChannel = vi.fn();
    sidebar.destroy?.();
    setAdminUser();
    sidebar = createChannelSidebar({
      onVoiceJoin,
      onOpenCall,
      onDeleteChannel,
    });

    setChannels(testChannels);
    sidebar.mount(container);

    const channelEl = container.querySelector('[data-channel-id="1"]') as HTMLElement;
    channelEl.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        clientX: 100,
        clientY: 200,
      }),
    );

    const deleteItem = document.querySelector('[data-testid="ctx-delete-channel"]') as HTMLElement;
    deleteItem.click();

    expect(onDeleteChannel).toHaveBeenCalledTimes(1);
    expect(onDeleteChannel.mock.calls[0]![0].id).toBe(1);
  });

  // Mark as Read is offered to everyone (it touches only the caller's own read
  // state), so a non-admin now gets a menu — just without the admin entries.
  it("shows only Mark as Read in the context menu for non-admin users", () => {
    const onEditChannel = vi.fn();
    sidebar.destroy?.();
    // Set a regular member (not admin/owner)
    signInAs({ id: 2, username: "Member", avatar: null, role: "member" });
    sidebar = createChannelSidebar({
      onVoiceJoin,
      onOpenCall,
      onEditChannel,
    });

    setChannels(testChannels);
    sidebar.mount(container);

    const channelEl = container.querySelector('[data-channel-id="1"]') as HTMLElement;
    channelEl.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        clientX: 100,
        clientY: 200,
      }),
    );

    const ctxMenu = document.querySelector('[data-testid="channel-context-menu"]');
    expect(ctxMenu).not.toBeNull();
    expect(ctxMenu?.querySelector('[data-testid="ctx-mark-read"]')).not.toBeNull();
    expect(ctxMenu?.querySelector('[data-testid="ctx-edit-channel"]')).toBeNull();
    expect(ctxMenu?.querySelector('[data-testid="ctx-delete-channel"]')).toBeNull();
    expect(onEditChannel).not.toHaveBeenCalled();
  });

  // ── Purge messages context-menu item ──

  /** Right-click channel 1 and return the opened context menu. */
  function openChannelCtxMenu(): HTMLElement | null {
    const channelEl = container.querySelector('[data-channel-id="1"]') as HTMLElement;
    channelEl.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }),
    );
    return document.querySelector('[data-testid="channel-context-menu"]');
  }

  it("shows Purge Messages for a role holding MANAGE_MESSAGES", () => {
    const onPurgeChannel = vi.fn<(channel: Channel, count: number) => Promise<void>>(
      async () => {},
    );
    sidebar.destroy?.();
    setRoles([{ id: 3, name: "Moderator", color: null, permissions: Permission.MANAGE_MESSAGES }]);
    signInAs({ id: 3, username: "Mod", avatar: null, role: "moderator" });
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall, onPurgeChannel });

    setChannels(testChannels);
    sidebar.mount(container);

    // A moderator is not owner/admin, so the menu exists only because of purge.
    expect(openChannelCtxMenu()).not.toBeNull();
    expect(document.querySelector('[data-testid="ctx-purge-messages"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="ctx-edit-channel"]')).toBeNull();
  });

  it("hides Purge Messages for a role without MANAGE_MESSAGES", () => {
    const onPurgeChannel = vi.fn<(channel: Channel, count: number) => Promise<void>>(
      async () => {},
    );
    sidebar.destroy?.();
    setRoles([{ id: 2, name: "Admin", color: null, permissions: Permission.MANAGE_CHANNELS }]);
    setAdminUser();
    sidebar = createChannelSidebar({
      onVoiceJoin,
      onOpenCall,
      onEditChannel: vi.fn(),
      onPurgeChannel,
    });

    setChannels(testChannels);
    sidebar.mount(container);

    expect(openChannelCtxMenu()).not.toBeNull();
    expect(document.querySelector('[data-testid="ctx-purge-messages"]')).toBeNull();
  });

  it("offers Purge Messages once a live role update grants MANAGE_MESSAGES", () => {
    const onPurgeChannel = vi.fn<(channel: Channel, count: number) => Promise<void>>(
      async () => {},
    );
    sidebar.destroy?.();
    setRoles([{ id: 3, name: "Moderator", color: null, permissions: 0 }]);
    signInAs({ id: 3, username: "Mod", avatar: null, role: "moderator" });
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall, onPurgeChannel });
    setChannels(testChannels);
    sidebar.mount(container);
    openChannelCtxMenu();
    expect(document.querySelector('[data-testid="ctx-purge-messages"]')).toBeNull();
    document.querySelectorAll(".channel-ctx-menu").forEach((el) => el.remove());

    setRoles([{ id: 3, name: "Moderator", color: null, permissions: Permission.MANAGE_MESSAGES }]);
    channelsStore.flush();

    expect(openChannelCtxMenu()).not.toBeNull();
    expect(document.querySelector('[data-testid="ctx-purge-messages"]')).not.toBeNull();
  });

  it("purge prompt clamps the count and calls onPurgeChannel with the channel", async () => {
    const onPurgeChannel = vi.fn<(channel: Channel, count: number) => Promise<void>>(
      async () => {},
    );
    sidebar.destroy?.();
    setRoles([{ id: 2, name: "Admin", color: null, permissions: Permission.ADMINISTRATOR }]);
    setAdminUser();
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall, onPurgeChannel });

    setChannels(testChannels);
    sidebar.mount(container);
    openChannelCtxMenu();

    const trigger = document.querySelector('[data-testid="ctx-purge-messages"]') as HTMLElement;
    trigger.click();

    const input = document.querySelector('[data-testid="purge-count-input"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    input.value = "5000";
    (document.querySelector('[data-testid="purge-confirm"]') as HTMLElement).click();

    await vi.waitFor(() => {
      expect(onPurgeChannel).toHaveBeenCalledTimes(1);
    });
    expect(onPurgeChannel.mock.calls[0]![0]).toMatchObject({ id: 1, name: "general" });
    expect(onPurgeChannel.mock.calls[0]![1]).toBe(100);
  });

  it("does not offer purge on a voice channel", () => {
    const onPurgeChannel = vi.fn<(channel: Channel, count: number) => Promise<void>>(
      async () => {},
    );
    sidebar.destroy?.();
    setRoles([{ id: 2, name: "Admin", color: null, permissions: Permission.ADMINISTRATOR }]);
    setAdminUser();
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall, onPurgeChannel });

    setChannels(testChannels);
    sidebar.mount(container);

    const voiceEl = container.querySelector('[data-channel-id="3"]') as HTMLElement;
    voiceEl.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }));

    expect(document.querySelector('[data-testid="ctx-purge-messages"]')).toBeNull();
  });

  // ── Create channel button ──

  it("shows create channel button on category header for admin users", () => {
    const onCreateChannel = vi.fn();
    sidebar.destroy?.();
    setAdminUser();
    sidebar = createChannelSidebar({
      onVoiceJoin,
      onOpenCall,
      onCreateChannel,
    });

    setChannels(testChannels);
    sidebar.mount(container);

    const addBtn = container.querySelector('[data-testid="create-channel-text-channels"]');
    expect(addBtn).not.toBeNull();
    expect(addBtn!.textContent).toBe("+");
  });

  it("clicking create channel button calls onCreateChannel with the category (id and name)", () => {
    const onCreateChannel = vi.fn();
    sidebar.destroy?.();
    setAdminUser();
    sidebar = createChannelSidebar({
      onVoiceJoin,
      onOpenCall,
      onCreateChannel,
    });

    setChannels(testChannels);
    sidebar.mount(container);

    const addBtn = container.querySelector(
      '[data-testid="create-channel-text-channels"]',
    ) as HTMLElement;
    addBtn.click();

    // These fixtures carry no category_id: a name-only category (older server).
    expect(onCreateChannel).toHaveBeenCalledWith({ id: 0, name: "Text Channels" });
  });

  it("the + of a real category passes its id, and the synthetic Voice group's passes none and a voice hint", () => {
    const onCreateChannel = vi.fn();
    sidebar.destroy?.();
    setAdminUser();
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall, onCreateChannel });
    setChannels([
      { id: 1, name: "general", type: "text", category: "Chat", category_id: 4, position: 0 },
      { id: 2, name: "lounge", type: "voice", category: null, position: 1 },
    ]);
    sidebar.mount(container);

    (container.querySelector('[data-testid="create-channel-chat"]') as HTMLElement).click();
    expect(onCreateChannel).toHaveBeenLastCalledWith({ id: 4, name: "Chat" });
    (container.querySelector('[data-testid="create-channel-voice"]') as HTMLElement).click();
    expect(onCreateChannel).toHaveBeenLastCalledWith({ id: 0, name: "" }, "voice");
  });

  it("create channel button does not collapse the category", () => {
    const onCreateChannel = vi.fn();
    sidebar.destroy?.();
    setAdminUser();
    sidebar = createChannelSidebar({
      onVoiceJoin,
      onOpenCall,
      onCreateChannel,
    });

    setChannels(testChannels);
    sidebar.mount(container);

    // All 4 channels visible before click
    expect(container.querySelectorAll(".channel-item").length).toBe(4);

    const addBtn = container.querySelector(
      '[data-testid="create-channel-text-channels"]',
    ) as HTMLElement;
    addBtn.click();

    // Category should NOT have collapsed (stopPropagation in the handler)
    expect(container.querySelectorAll(".channel-item").length).toBe(4);
  });

  it("does not show create channel button for non-admin users", () => {
    const onCreateChannel = vi.fn();
    sidebar.destroy?.();
    signInAs({ id: 2, username: "Member", avatar: null, role: "member" });
    sidebar = createChannelSidebar({
      onVoiceJoin,
      onOpenCall,
      onCreateChannel,
    });

    setChannels(testChannels);
    sidebar.mount(container);

    const addBtn = container.querySelector(".category-add-btn");
    expect(addBtn).toBeNull();
  });

  // The button used to be gated on the role NAME, so a Moderator holding
  // MANAGE_CHANNELS — which the server now honors on /admin/api/channels — saw
  // no way to create one.
  it("shows create channel button for a role holding MANAGE_CHANNELS", () => {
    const onCreateChannel = vi.fn();
    sidebar.destroy?.();
    setRoles([{ id: 3, name: "Moderator", color: null, permissions: Permission.MANAGE_CHANNELS }]);
    signInAs({ id: 3, username: "Mod", avatar: null, role: "moderator" });
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall, onCreateChannel });

    setChannels(testChannels);
    sidebar.mount(container);

    expect(container.querySelector(".category-add-btn")).not.toBeNull();
  });

  it("hides create channel button for a server role without MANAGE_CHANNELS", () => {
    const onCreateChannel = vi.fn();
    sidebar.destroy?.();
    // A role the server DID send, holding no channel bit: the name fallback
    // must not apply, even for a role called "admin".
    setRoles([{ id: 2, name: "Admin", color: null, permissions: Permission.SEND_MESSAGES }]);
    signInAs({ id: 2, username: "Admin", avatar: null, role: "admin" });
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall, onCreateChannel });

    setChannels(testChannels);
    sidebar.mount(container);

    expect(container.querySelector(".category-add-btn")).toBeNull();
  });

  // ── Live role-change repaint (OC-0142) ──
  // canManageChannels() is evaluated at render time from authStore.user.role,
  // but the sidebar's only authStore subscription selects serverName. A
  // MEMBER_UPDATE for the signed-in user (dispatcher.ts writes the new role
  // via updateUser) must still cause a repaint without any unrelated event.

  it("repaints channel-management affordances when the signed-in user's own role changes", () => {
    const onCreateChannel = vi.fn();
    sidebar.destroy?.();
    signInAs({ id: 2, username: "Member", avatar: null, role: "member" });
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall, onCreateChannel });

    setChannels(testChannels);
    sidebar.mount(container);

    // Starts as a plain member: no "+" button.
    expect(container.querySelector(".category-add-btn")).toBeNull();

    // Promoted to admin (mirrors dispatcher.ts's MEMBER_UPDATE self-branch,
    // which patches authStore via updateUser({ role })) — no channel/voice
    // event fires alongside it.
    authStore.setState((prev) => ({
      ...prev,
      user: prev.user === null ? null : { ...prev.user, role: "admin" },
    }));
    authStore.flush();

    expect(container.querySelector(".category-add-btn")).not.toBeNull();
  });

  it("repaints channel-management affordances when the role list's permission mask changes", () => {
    const onCreateChannel = vi.fn();
    sidebar.destroy?.();
    setRoles([{ id: 3, name: "Moderator", color: null, permissions: Permission.SEND_MESSAGES }]);
    signInAs({ id: 3, username: "Mod", avatar: null, role: "moderator" });
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall, onCreateChannel });

    setChannels(testChannels);
    sidebar.mount(container);

    // Moderator role holds no MANAGE_CHANNELS bit yet.
    expect(container.querySelector(".category-add-btn")).toBeNull();

    // A ROLES_UPDATE grants MANAGE_CHANNELS to the same role (dispatcher.ts's
    // ROLES_UPDATE handler replaces the whole list via setRoles) — again with
    // no accompanying channel/voice event.
    setRoles([{ id: 3, name: "Moderator", color: null, permissions: Permission.MANAGE_CHANNELS }]);
    channelsStore.flush();

    expect(container.querySelector(".category-add-btn")).not.toBeNull();
  });

  // ── Voice user volume context menu ──

  it("right-click on other user's voice row opens volume context menu", async () => {
    // Set current user to something different from the voice user
    signInAs({ id: 99, username: "Me", avatar: null, role: "member" });

    setChannels(testChannels);
    updateVoiceState({
      channel_id: 3,
      user_id: 80,
      username: "OtherUser",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });
    sidebar.mount(container);

    const voiceRow = container.querySelector(".voice-user-item") as HTMLElement;
    voiceRow.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        clientX: 150,
        clientY: 250,
      }),
    );
    // The menu code loads on its first open (O-6b).
    await vi.dynamicImportSettled();

    const volMenu = document.querySelector(".user-vol-menu");
    expect(volMenu).not.toBeNull();
    // Should display the username
    expect(volMenu!.textContent).toContain("OtherUser");
    // Should have a volume slider
    const slider = volMenu!.querySelector('input[type="range"]');
    expect(slider).not.toBeNull();
    // Should have a Reset Volume button
    expect(volMenu!.textContent).toContain("Reset Volume");
  });

  // ── Voice moderation context menu (can_moderate_voice, B9-14) ──

  /** Signs in as a user whose role holds exactly `permissions`, puts one other
   *  user in the voice channel, mounts the sidebar and right-clicks their row.
   *  Every channel carries `verdict` as its can_moderate_voice (null: absent);
   *  by default the one the server computes with no channel override (the
   *  role's MUTE_MEMBERS, ADMINISTRATOR included). Returns the open menu
   *  element (or null). */
  const MUTE_AND_MOVE = Permission.MUTE_MEMBERS | Permission.MOVE_MEMBERS;

  async function openVoiceMenuAs(
    permissions: number,
    voiceUser: Partial<VoiceStatePayload> = {},
    onVoiceModerate?: Parameters<typeof createChannelSidebar>[0]["onVoiceModerate"],
    channels: ReadyChannel[] = testChannels,
    verdict: boolean | null = (permissions &
      (Permission.MUTE_MEMBERS | Permission.ADMINISTRATOR)) !==
      0,
  ): Promise<HTMLElement | null> {
    sidebar.destroy?.();
    setRoles([{ id: 3, name: "Moderator", color: null, permissions }]);
    signInAs({ id: 99, username: "Mod", avatar: null, role: "moderator" });
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall, onVoiceModerate });

    setChannels(
      channels.map((ch) =>
        verdict === null
          ? ch
          : {
              ...ch,
              can_moderate_voice: verdict,
              can_move_voice: (permissions & Permission.MOVE_MEMBERS) !== 0,
            },
      ),
    );
    updateVoiceState({
      channel_id: 3,
      user_id: 80,
      username: "Target",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
      ...voiceUser,
    });
    sidebar.mount(container);

    const voiceRow = container.querySelector(".voice-user-item") as HTMLElement;
    voiceRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    // The menu code loads on its first open (O-6b).
    await vi.dynamicImportSettled();
    return document.querySelector(".user-vol-menu");
  }

  it("hides the moderation section for a role without MUTE_MEMBERS", async () => {
    const menu = await openVoiceMenuAs(Permission.MANAGE_CHANNELS, {}, voiceModCallbacks());
    expect(menu).not.toBeNull();
    expect(menu!.querySelector('[data-action="server-mute"]')).toBeNull();
    expect(menu!.querySelector('[data-action="voice-disconnect"]')).toBeNull();
    // The volume controls stay available to everyone.
    expect(menu!.textContent).toContain("Reset Volume");
  });

  it("follows the channel's verdict, not the role: an override that denies hides the section", async () => {
    const menu = await openVoiceMenuAs(
      Permission.MUTE_MEMBERS,
      {},
      voiceModCallbacks(),
      testChannels,
      false,
    );
    expect(menu!.querySelector('[data-action="server-mute"]')).toBeNull();
    expect(menu!.querySelector('[data-action="voice-mod-unavailable"]')).toBeNull();
  });

  it("follows the channel's verdict, not the role: a verdict of true offers the section", async () => {
    const menu = await openVoiceMenuAs(
      Permission.MANAGE_CHANNELS,
      {},
      voiceModCallbacks(),
      testChannels,
      true,
    );
    expect(menu!.querySelector('[data-action="server-mute"]')).not.toBeNull();
  });

  it("offers nothing without a verdict, and says why to a role holding MUTE_MEMBERS", async () => {
    const cb = voiceModCallbacks();
    const menu = await openVoiceMenuAs(Permission.MUTE_MEMBERS, {}, cb, testChannels, null);
    expect(menu!.querySelector('[data-action="server-mute"]')).toBeNull();
    expect(menu!.querySelector('[data-action="voice-disconnect"]')).toBeNull();
    const why = menu!.querySelector('[data-action="voice-mod-unavailable"]');
    expect(why!.textContent).toBe(
      "Voice moderation unavailable: the server hasn't confirmed you can moderate this channel.",
    );
    expect(why!.getAttribute("aria-disabled")).toBe("true");
    (why as HTMLElement).click();
    expect(cb.onServerMute).not.toHaveBeenCalled();

    const member = await openVoiceMenuAs(Permission.SEND_MESSAGES, {}, cb, testChannels, null);
    expect(member!.querySelector('[data-action="voice-mod-unavailable"]')).toBeNull();
  });

  it("reads each channel's verdict: moderating one voice channel is not moderating another", async () => {
    const channels: ReadyChannel[] = [
      ...testChannels.map((ch) => (ch.id === 3 ? { ...ch, can_moderate_voice: false } : ch)),
      {
        id: 5,
        name: "voice-two",
        type: "voice",
        category: "Voice Channels",
        position: 1,
        can_moderate_voice: true,
      },
    ];
    const menu = await openVoiceMenuAs(
      Permission.MUTE_MEMBERS,
      {},
      voiceModCallbacks(),
      channels,
      null,
    );
    expect(menu!.querySelector('[data-action="server-mute"]')).toBeNull();
  });

  it("takes a live channel_create verdict at the next open, and keeps it when one is absent", async () => {
    const cb = voiceModCallbacks();
    expect(
      (await openVoiceMenuAs(Permission.MUTE_MEMBERS, {}, cb))!.querySelector(
        '[data-action="server-mute"]',
      ),
    ).not.toBeNull();
    const voice = testChannels.find((ch) => ch.id === 3)!;
    const row = (): HTMLElement => container.querySelector(".voice-user-item") as HTMLElement;
    const reopen = async (): Promise<HTMLElement | null> => {
      row().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
      await vi.dynamicImportSettled();
      return document.querySelector(".user-vol-menu");
    };

    // An override edit revokes it (RefreshChannelVisibility's targeted channel_create).
    addChannel({ ...voice, can_moderate_voice: false });
    expect((await reopen())!.querySelector('[data-action="server-mute"]')).toBeNull();
    // A channel_create without the field changes nothing.
    addChannel({ ...voice });
    expect((await reopen())!.querySelector('[data-action="server-mute"]')).toBeNull();
    addChannel({ ...voice, can_moderate_voice: true });
    expect((await reopen())!.querySelector('[data-action="server-mute"]')).not.toBeNull();
  });

  it("offers only Move to to a role whose verdict is can_move_voice without can_moderate_voice", async () => {
    const cb = voiceModCallbacks();
    const channels: ReadyChannel[] = [
      ...testChannels.map((ch) =>
        ch.type === "voice" ? { ...ch, can_moderate_voice: false, can_move_voice: true } : ch,
      ),
      {
        id: 5,
        name: "voice-two",
        type: "voice",
        category: "Voice Channels",
        position: 1,
        can_moderate_voice: false,
        can_move_voice: true,
      },
    ];
    const menu = await openVoiceMenuAs(Permission.MOVE_MEMBERS, {}, cb, channels, null);
    expect(menu!.querySelector('[data-action="move-to"]')).not.toBeNull();
    expect(menu!.querySelector('[data-action="server-mute"]')).toBeNull();
    expect(menu!.querySelector('[data-action="server-deafen"]')).toBeNull();
    expect(menu!.querySelector('[data-action="voice-disconnect"]')).toBeNull();
    expect(menu!.querySelector('[data-action="voice-mod-unavailable"]')).toBeNull();
    const target = menu!.querySelector<HTMLElement>('[data-move-channel="5"]');
    expect(target).not.toBeNull();
    target!.click();
    expect(cb.onMove).toHaveBeenCalledWith(80, 5);
  });

  it("shows the full section but no Move to when can_moderate_voice is true and can_move_voice is false", async () => {
    const channels = [
      ...testChannels,
      { id: 5, name: "voice-two", type: "voice", category: "Voice Channels", position: 1 },
    ].map((ch) =>
      ch.type === "voice" ? { ...ch, can_moderate_voice: true, can_move_voice: false } : ch,
    ) as ReadyChannel[];
    const menu = await openVoiceMenuAs(
      Permission.MUTE_MEMBERS,
      {},
      voiceModCallbacks(),
      channels,
      null,
    );
    expect(menu!.querySelector('[data-action="server-mute"]')).not.toBeNull();
    expect(menu!.querySelector('[data-action="voice-disconnect"]')).not.toBeNull();
    expect(menu!.querySelector('[data-action="move-to"]')).toBeNull();
  });

  it("offers nothing when both verdicts are false", async () => {
    const channels = testChannels.map((ch) =>
      ch.type === "voice" ? { ...ch, can_moderate_voice: false, can_move_voice: false } : ch,
    );
    const menu = await openVoiceMenuAs(
      Permission.MOVE_MEMBERS,
      {},
      voiceModCallbacks(),
      channels,
      null,
    );
    expect(menu!.querySelector('[data-action="move-to"]')).toBeNull();
    expect(menu!.querySelector('[data-action="voice-mod-unavailable"]')).toBeNull();
  });

  it("says why to a role holding MOVE_MEMBERS when the server gave no verdict", async () => {
    const menu = await openVoiceMenuAs(
      Permission.MOVE_MEMBERS,
      {},
      voiceModCallbacks(),
      testChannels,
      null,
    );
    expect(menu!.querySelector('[data-action="voice-mod-unavailable"]')).not.toBeNull();
  });

  it("hides the moderation section when the page wired no callbacks", async () => {
    const menu = await openVoiceMenuAs(Permission.MUTE_MEMBERS);
    expect(menu).not.toBeNull();
    expect(menu!.querySelector('[data-action="server-mute"]')).toBeNull();
  });

  it("shows the moderation section for a role holding MUTE_MEMBERS", async () => {
    const menu = await openVoiceMenuAs(Permission.MUTE_MEMBERS, {}, voiceModCallbacks());
    expect(menu).not.toBeNull();
    expect(menu!.querySelector('[data-action="server-mute"]')!.textContent).toBe("Server Mute");
    expect(menu!.querySelector('[data-action="server-deafen"]')!.textContent).toBe("Server Deafen");
    expect(menu!.querySelector('[data-action="voice-disconnect"]')).not.toBeNull();
  });

  it("shows the moderation section for an ADMINISTRATOR role", async () => {
    const menu = await openVoiceMenuAs(Permission.ADMINISTRATOR, {}, voiceModCallbacks());
    expect(menu!.querySelector('[data-action="server-mute"]')).not.toBeNull();
  });

  it("labels the toggles by the target's current server-imposed state", async () => {
    const menu = await openVoiceMenuAs(
      Permission.MUTE_MEMBERS,
      { muted: true, deafened: true, server_muted: true, server_deafened: true },
      voiceModCallbacks(),
    );
    expect(menu!.querySelector('[data-action="server-mute"]')!.textContent).toBe("Server Unmute");
    expect(menu!.querySelector('[data-action="server-deafen"]')!.textContent).toBe(
      "Server Undeafen",
    );
  });

  it("sends server mute with the channel and target, and disconnect with the target", async () => {
    const cb = voiceModCallbacks();
    const menu = await openVoiceMenuAs(Permission.MUTE_MEMBERS, {}, cb);

    (menu!.querySelector('[data-action="server-mute"]') as HTMLElement).click();
    expect(cb.onServerMute).toHaveBeenCalledWith(3, 80, true);

    const menu2 = await openVoiceMenuAs(Permission.MUTE_MEMBERS, {}, cb);
    (menu2!.querySelector('[data-action="voice-disconnect"]') as HTMLElement).click();
    expect(cb.onDisconnect).toHaveBeenCalledWith(80);
  });

  it("greys the moderation rows with a reason while the socket is not connected", async () => {
    const cb = voiceModCallbacks();
    const channels: ReadyChannel[] = [
      ...testChannels,
      { id: 5, name: "voice-two", type: "voice", category: "Voice Channels", position: 1 },
    ];
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "reconnecting" }));
    const menu = await openVoiceMenuAs(MUTE_AND_MOVE, {}, cb, channels);

    const why = menu!.querySelector('[data-action="voice-mod-offline"]');
    expect(why!.textContent).toBe(
      "Reconnecting. Voice moderation comes back once you are connected.",
    );
    for (const action of ["server-mute", "server-deafen", "voice-disconnect"]) {
      const item = menu!.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!;
      expect(item.disabled).toBe(true);
      expect(item.classList.contains("disabled")).toBe(true);
      item.click();
    }
    const move = menu!.querySelector('[data-action="move-to"]')!;
    expect(move.getAttribute("aria-disabled")).toBe("true");
    expect(move.querySelector("[data-move-channel]")).toBeNull();
    expect(cb.onServerMute).not.toHaveBeenCalled();
    expect(cb.onServerDeafen).not.toHaveBeenCalled();
    expect(cb.onDisconnect).not.toHaveBeenCalled();

    uiStore.setState((prev) => ({ ...prev, connectionStatus: "disconnected" }));
    const offline = await openVoiceMenuAs(MUTE_AND_MOVE, {}, cb, channels);
    expect(offline!.querySelector('[data-action="voice-mod-offline"]')!.textContent).toBe(
      "Not connected. Voice moderation needs a connection to the server.",
    );

    // Back online: the rows are live again and the reason is gone.
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    const live = await openVoiceMenuAs(MUTE_AND_MOVE, {}, cb, channels);
    expect(live!.querySelector('[data-action="voice-mod-offline"]')).toBeNull();
    const mute = live!.querySelector<HTMLButtonElement>('[data-action="server-mute"]')!;
    expect(mute.disabled).toBe(false);
    mute.click();
    expect(cb.onServerMute).toHaveBeenCalledWith(3, 80, true);
  });

  it("gives a MUTE_MEMBERS-only role no Move to: only MOVE_MEMBERS opens a move", async () => {
    const menu = await openVoiceMenuAs(Permission.MUTE_MEMBERS, {}, voiceModCallbacks(), [
      ...testChannels,
      { id: 5, name: "voice-two", type: "voice", category: "Voice Channels", position: 1 },
    ]);
    expect(menu!.querySelector('[data-action="server-mute"]')).not.toBeNull();
    expect(menu!.querySelector('[data-action="move-to"]')).toBeNull();
    expect(menu!.querySelector("[data-move-channel]")).toBeNull();
  });

  it("offers only the other voice channels as move targets", async () => {
    const cb = voiceModCallbacks();
    const menu = await openVoiceMenuAs(MUTE_AND_MOVE, {}, cb);

    const moveItems = menu!.querySelectorAll("[data-move-channel]");
    // testChannels has one voice channel (id 3) — the one the target is in.
    expect(moveItems.length).toBe(0);

    const menu2 = await openVoiceMenuAs(MUTE_AND_MOVE, {}, cb, [
      ...testChannels,
      { id: 5, name: "voice-two", type: "voice", category: "Voice Channels", position: 1 },
    ]);
    const moveItems2 = menu2!.querySelectorAll("[data-move-channel]");
    expect(moveItems2.length).toBe(1);
    expect((moveItems2[0] as HTMLElement).dataset.moveChannel).toBe("5");

    (moveItems2[0] as HTMLElement).click();
    expect(cb.onMove).toHaveBeenCalledWith(80, 5);
  });

  it("marks a server-muted participant distinctly from a self-muted one", () => {
    sidebar.destroy?.();
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall });
    setChannels(testChannels);
    updateVoiceState({
      channel_id: 3,
      user_id: 81,
      username: "Selfmuted",
      muted: true,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });
    sidebar.mount(container);
    expect(container.querySelector(".vu-muted.vu-server-muted")).toBeNull();

    updateVoiceState({
      channel_id: 3,
      user_id: 81,
      username: "Selfmuted",
      muted: true,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
      server_muted: true,
    });
    voiceStore.flush();

    const icon = container.querySelector(".vu-muted.vu-server-muted") as HTMLElement;
    expect(icon).not.toBeNull();
    expect(icon.title).toBe("Muted by a moderator");
  });

  it("shows a locally muted participant's icon and redraws on a local Mute change", () => {
    sidebar.destroy?.();
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall });
    setChannels(testChannels);
    addVoiceUser(3, 82, "loud");
    sidebar.mount(container);
    expect(container.querySelector(".vu-local-muted")).toBeNull();

    mockGetUserLocalMute.mockImplementation((id) => id === 82);
    try {
      window.dispatchEvent(
        new CustomEvent("owncord:user-local-mute-changed", { detail: { userId: 82 } }),
      );
      const icon = container.querySelector(
        '.voice-user-item[data-voice-uid="82"] .vu-local-muted',
      ) as HTMLElement;
      expect(icon).not.toBeNull();
      expect(icon.title).toBe("Muted for you");
    } finally {
      mockGetUserLocalMute.mockImplementation(() => false);
    }
  });

  it("colours a self-mute grey and a moderator's mute red, with a steady speaking ring", () => {
    expect(varToken(cascadedDeclaration(".voice-user-item .vu-muted", "color"))).toBe(
      "--text-muted",
    );
    expect(varToken(cascadedDeclaration(".vu-muted.vu-server-muted", "color"))).toBe("--red");
    // The ring is steady: no pulse on the sidebar row or on the user bar.
    expect(cascadedDeclaration(".voice-user-item.speaking .vu-avatar", "box-shadow")).toBeDefined();
    expect(
      cascadedDeclaration(".voice-user-item.speaking .vu-avatar", "animation"),
    ).toBeUndefined();
    expect(cascadedDeclaration(".user-bar .ub-avatar.speaking", "animation")).toBeUndefined();
  });

  it("keeps a moderator's mute on the single icon of a self-deafened user", () => {
    sidebar.destroy?.();
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall });
    setChannels(testChannels);
    updateVoiceState({
      channel_id: 3,
      user_id: 82,
      username: "DeafAndModMuted",
      muted: true,
      deafened: true,
      speaking: false,
      camera: false,
      screenshare: false,
      server_muted: true,
    });
    sidebar.mount(container);

    const icons = container.querySelectorAll(".vu-muted");
    expect(icons.length).toBe(1);
    const icon = icons[0] as HTMLElement;
    expect(icon.classList.contains("vu-server-muted")).toBe(true);
    expect(icon.title).toBe("Muted by a moderator");
  });
});

// ── Channel context menu: Edit/Delete follow MANAGE_CHANNELS ──
//
// These items used to be gated on the role NAME ("owner"/"admin"), so a custom
// role the server would happily let edit a channel saw no way to, and a role
// merely *called* "admin" with no channel bit saw items every click would be
// refused for.
describe("ChannelSidebar channel context menu permissions", () => {
  let container: HTMLDivElement;
  let sidebar: ReturnType<typeof createChannelSidebar>;

  beforeEach(() => {
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    sidebar.destroy?.();
    container.remove();
    document.querySelectorAll(".context-menu").forEach((el) => el.remove());
  });

  function mountAs(roleName: string, permissions: number): HTMLElement | null {
    setRoles([{ id: 9, name: roleName, color: null, permissions }]);
    signInAs({ id: 9, username: "U", avatar: null, role: roleName });
    sidebar = createChannelSidebar({
      onVoiceJoin: vi.fn(),
      onOpenCall: vi.fn(),
      onEditChannel: vi.fn(),
      onDeleteChannel: vi.fn(),
    });
    setChannels([{ id: 1, name: "general", type: "text", category: "Text Channels", position: 0 }]);
    sidebar.mount(container);

    (container.querySelector('[data-channel-id="1"]') as HTMLElement).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }),
    );
    return document.querySelector('[data-testid="channel-context-menu"]');
  }

  it("offers Edit and Delete to a custom role holding MANAGE_CHANNELS", () => {
    const menu = mountAs("Curator", Permission.MANAGE_CHANNELS);
    expect(menu?.querySelector('[data-testid="ctx-edit-channel"]')).not.toBeNull();
    expect(menu?.querySelector('[data-testid="ctx-delete-channel"]')).not.toBeNull();
  });

  it("hides them from a role named 'admin' that lacks the bit", () => {
    const menu = mountAs("Admin", Permission.SEND_MESSAGES);
    expect(menu?.querySelector('[data-testid="ctx-edit-channel"]')).toBeNull();
    expect(menu?.querySelector('[data-testid="ctx-delete-channel"]')).toBeNull();
  });

  it("offers them to a role holding ADMINISTRATOR", () => {
    const menu = mountAs("Owner", Permission.ADMINISTRATOR);
    expect(menu?.querySelector('[data-testid="ctx-edit-channel"]')).not.toBeNull();
  });
});
