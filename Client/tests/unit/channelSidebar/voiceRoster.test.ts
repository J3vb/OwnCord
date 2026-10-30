import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import * as mocks from "../../helpers/channelSidebarMocks";
import { createChannelSidebar } from "../../../src/components/ChannelSidebar";
import { channelsStore, setChannels } from "../../../src/stores/channels.store";
import { authStore } from "../../../src/stores/auth.store";
import { uiStore } from "../../../src/stores/ui.store";
import {
  resetSafetyStore,
  safetyStore,
  setActiveTimeout,
} from "../../../src/features/safety/store";
import {
  voiceStore,
  updateVoiceState,
  setSpeakers,
  removeVoiceUser,
} from "../../../src/stores/voice.store";
import { membersStore } from "../../../src/stores/members.store";
import { noteJoinFailed, noteJoinSucceeded } from "../../../src/features/voice/joinBackoff";
import {
  resetStores,
  addVoiceUser,
  setPeerVerif,
  testChannels,
  voiceModCallbacks,
  setAdminUser,
} from "../../helpers/channelSidebarHarness";

vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());
vi.mock("@lib/ui/toast", () => mocks.uiToastMock());
vi.mock("@lib/net/e2eeCrypto", (importOriginal) => mocks.netE2eeCryptoMock(importOriginal));
vi.mock("../../../src/components/message-list/attachments", (importOriginal) =>
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

  // ── V11: a voice user with nothing to watch opens their profile ──

  it("clicking a voice user without camera or stream opens their profile (V11)", () => {
    const onWatchStream = vi.fn();
    sidebar.destroy?.();
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall, onWatchStream });
    setChannels(testChannels);
    addVoiceUser(3, 30, "alice");
    sidebar.mount(container);

    const row = container.querySelector('.voice-user-item[data-voice-uid="30"]') as HTMLElement;
    row.click();

    expect(mockOpenUserProfilePopup).toHaveBeenCalledOnce();
    expect(mockOpenUserProfilePopup).toHaveBeenCalledWith(expect.objectContaining({ userId: 30 }));
    expect(onWatchStream).not.toHaveBeenCalled();
    expect(onVoiceJoin).not.toHaveBeenCalled();
    expect(onOpenCall).not.toHaveBeenCalled();
  });

  it("Enter or Space on a voice user row opens the profile, own row included (V11)", () => {
    setAdminUser();
    setChannels(testChannels);
    addVoiceUser(3, 1, "Admin");
    addVoiceUser(3, 30, "alice");
    sidebar.mount(container);

    for (const [uid, key] of [
      [1, "Enter"],
      [30, " "],
    ] as const) {
      const row = container.querySelector(
        `.voice-user-item[data-voice-uid="${uid}"]`,
      ) as HTMLElement;
      expect(row.tabIndex).toBe(0);
      row.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      expect(mockOpenUserProfilePopup).toHaveBeenLastCalledWith(
        expect.objectContaining({ userId: uid }),
      );
    }
    expect(mockOpenUserProfilePopup).toHaveBeenCalledTimes(2);
  });

  it("clicking a voice user with a stream watches it and opens no profile (V11)", () => {
    const onWatchStream = vi.fn();
    sidebar.destroy?.();
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall, onWatchStream });
    setChannels(testChannels);
    updateVoiceState({
      channel_id: 3,
      user_id: 30,
      username: "alice",
      muted: false,
      deafened: false,
      speaking: false,
      camera: true,
      screenshare: false,
    });
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 3 }));
    sidebar.mount(container);

    (container.querySelector('.voice-user-item[data-voice-uid="30"]') as HTMLElement).click();

    expect(onWatchStream).toHaveBeenCalledWith(30);
    expect(mockOpenUserProfilePopup).not.toHaveBeenCalled();
  });

  it("destroy closes a profile popup a voice user row opened (V11)", () => {
    const close = vi.fn();
    mockOpenUserProfilePopup.mockReturnValueOnce(close);
    setChannels(testChannels);
    addVoiceUser(3, 30, "alice");
    sidebar.mount(container);

    (container.querySelector('.voice-user-item[data-voice-uid="30"]') as HTMLElement).click();
    sidebar.destroy?.();

    expect(close).toHaveBeenCalledOnce();
  });

  // ── Voice join/leave freeze while the WS socket is not connected (§3) ──

  it("disables voice channel join with a 'Reconnecting…' reason while reconnecting", () => {
    setChannels(testChannels);
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "reconnecting" }));
    sidebar.mount(container);

    const voiceItem = container.querySelector('[data-channel-id="3"]') as HTMLElement;
    expect(voiceItem.classList.contains("disabled")).toBe(true);
    expect(voiceItem.getAttribute("aria-disabled")).toBe("true");
    expect(voiceItem.title).toBe("Reconnecting…");

    // Frozen: the click must not fire the join callback.
    voiceItem.click();
    expect(onVoiceJoin).not.toHaveBeenCalled();
  });

  it("disables voice channel join with a 'Not connected' reason while disconnected", () => {
    setChannels(testChannels);
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "disconnected" }));
    sidebar.mount(container);

    const voiceItem = container.querySelector('[data-channel-id="3"]') as HTMLElement;
    expect(voiceItem.classList.contains("disabled")).toBe(true);
    expect(voiceItem.title).toBe("Not connected");

    voiceItem.click();
    expect(onVoiceJoin).not.toHaveBeenCalled();
  });

  it("frozen voice channel does not fire onOpenCall even when joined", () => {
    setChannels(testChannels);
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 3 }));
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "reconnecting" }));
    sidebar.mount(container);

    const voiceItem = container.querySelector('[data-channel-id="3"]') as HTMLElement;
    expect(voiceItem.classList.contains("disabled")).toBe(true);

    voiceItem.click();
    expect(onOpenCall).not.toHaveBeenCalled();
  });

  it("a timeout disables joining voice with the server expiry, never leaving", () => {
    setChannels(testChannels);
    setActiveTimeout(new Date(Date.now() + 3_600_000).toISOString());
    sidebar.mount(container);

    let voiceItem = container.querySelector('[data-channel-id="3"]') as HTMLElement;
    expect(voiceItem.getAttribute("aria-disabled")).toBe("true");
    expect(voiceItem.title).toMatch(/^You can't join voice until /);
    // The expiry is visible text in the row, not only a tooltip.
    expect(container.querySelector("[data-testid='voice-timeout-3']")?.textContent).toMatch(
      /^You can't join voice until /,
    );
    voiceItem.click();
    expect(onVoiceJoin).not.toHaveBeenCalled();

    // Already in the channel: the row stays usable (it opens the call).
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 3 }));
    voiceStore.flush();
    voiceItem = container.querySelector('[data-channel-id="3"]') as HTMLElement;
    expect(voiceItem.hasAttribute("aria-disabled")).toBe(false);
    expect(container.querySelector("[data-testid='voice-timeout-3']")).toBeNull();
    voiceItem.click();
    expect(onOpenCall).toHaveBeenCalled();

    // The lift re-enables the row.
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: null }));
    voiceStore.flush();
    setActiveTimeout(null);
    safetyStore.flush();
    voiceItem = container.querySelector('[data-channel-id="3"]') as HTMLElement;
    expect(voiceItem.hasAttribute("aria-disabled")).toBe(false);
    expect(container.querySelector("[data-testid='voice-timeout-3']")).toBeNull();
    resetSafetyStore();
  });

  it("re-enables voice channel join when the connection returns to connected", () => {
    setChannels(testChannels);
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "reconnecting" }));
    sidebar.mount(container);

    // Initially frozen.
    let voiceItem = container.querySelector('[data-channel-id="3"]') as HTMLElement;
    expect(voiceItem.classList.contains("disabled")).toBe(true);

    // Connection restored — the sidebar re-renders and unfreezes the row.
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" }));
    uiStore.flush();

    voiceItem = container.querySelector('[data-channel-id="3"]') as HTMLElement;
    expect(voiceItem.classList.contains("disabled")).toBe(false);
    expect(voiceItem.hasAttribute("aria-disabled")).toBe(false);

    voiceItem.click();
    expect(onVoiceJoin).toHaveBeenCalledWith(3);
  });

  it("shows connected voice users under voice channel", () => {
    setChannels(testChannels);
    // Add a member so username resolves
    membersStore.setState((prev) => ({
      ...prev,
      members: new Map([
        [
          10,
          { id: 10, username: "Alice", avatar: null, role: "member", status: "online" as const },
        ],
      ]),
    }));
    updateVoiceState({
      channel_id: 3,
      user_id: 10,
      username: "Alice",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });
    sidebar.mount(container);

    const voiceUsersList = container.querySelector(".voice-users-list");
    expect(voiceUsersList).not.toBeNull();

    const userItems = container.querySelectorAll(".voice-user-item");
    expect(userItems.length).toBe(1);

    const userName = userItems[0]?.querySelector(".vu-name");
    expect(userName?.textContent).toBe("Alice");
  });

  it("shows the member's display name (nickname), not the raw username, in the voice roster", () => {
    setChannels(testChannels);
    // Member has a nickname set — every other identity surface (member list,
    // message rows, DM sidebar) renders it instead of the raw username.
    membersStore.setState((prev) => ({
      ...prev,
      members: new Map([
        [
          10,
          {
            id: 10,
            username: "Bob",
            displayName: "Bobby",
            avatar: null,
            role: "member",
            status: "online" as const,
          },
        ],
      ]),
    }));
    updateVoiceState({
      channel_id: 3,
      user_id: 10,
      username: "Bob",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });
    sidebar.mount(container);

    const userName = container.querySelector(".voice-user-item .vu-name");
    expect(userName?.textContent).toBe("Bobby");
  });

  it("highlights voice channel as active when user is joined", () => {
    setChannels(testChannels);
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 3 }));
    sidebar.mount(container);

    const voiceItem = container.querySelector('[data-channel-id="3"]');
    expect(voiceItem?.classList.contains("active")).toBe(true);
  });

  it("re-renders when voice store changes", () => {
    setChannels(testChannels);
    sidebar.mount(container);

    // Initially no voice users
    let voiceUsers = container.querySelectorAll(".voice-user-item");
    expect(voiceUsers.length).toBe(0);

    // Add a voice user
    updateVoiceState({
      channel_id: 3,
      user_id: 20,
      username: "Bob",
      muted: true,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });
    voiceStore.flush();

    voiceUsers = container.querySelectorAll(".voice-user-item");
    expect(voiceUsers.length).toBe(1);

    // Should show muted icon
    const mutedIcon = voiceUsers[0]?.querySelector(".vu-muted");
    expect(mutedIcon).not.toBeNull();
  });

  it("shows LIVE badge when user has screenshare active", () => {
    setChannels(testChannels);
    updateVoiceState({
      channel_id: 3,
      user_id: 30,
      username: "Streamer",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: true,
    });
    sidebar.mount(container);

    const liveBadge = container.querySelector(".vu-live-badge");
    expect(liveBadge).not.toBeNull();
    expect(liveBadge!.textContent).toBe("LIVE");
  });

  it("shows monitor icon when user has screenshare active", () => {
    setChannels(testChannels);
    updateVoiceState({
      channel_id: 3,
      user_id: 30,
      username: "Streamer",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: true,
    });
    sidebar.mount(container);

    // The screenshare user row should contain an SVG icon (monitor)
    const voiceUserItems = container.querySelectorAll(".voice-user-item");
    expect(voiceUserItems.length).toBe(1);
    const screenIcon = voiceUserItems[0]?.querySelector("svg");
    expect(screenIcon).not.toBeNull();
  });

  it("calls onWatchStream when clicking a user row with active stream", () => {
    const onWatchStream = vi.fn();
    sidebar.destroy?.();
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall, onWatchStream });

    setChannels(testChannels);
    updateVoiceState({
      channel_id: 3,
      user_id: 30,
      username: "Streamer",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: true,
    });
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 3 }));
    sidebar.mount(container);

    const voiceUserItem = container.querySelector(".voice-user-item") as HTMLElement;
    expect(voiceUserItem).not.toBeNull();
    voiceUserItem.click();

    // User has screenshare: true, so tileId = userId + SCREENSHARE_TILE_ID_OFFSET
    expect(onWatchStream).toHaveBeenCalledWith(30 + 1_000_000);
  });

  it("clicking a peer's stream row also joins the channel when not already in it", () => {
    const onWatchStream = vi.fn();
    sidebar.destroy?.();
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall, onWatchStream });

    setChannels(testChannels);
    updateVoiceState({
      channel_id: 3,
      user_id: 30,
      username: "Streamer",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: true,
    });
    sidebar.mount(container);

    const voiceUserItem = container.querySelector(".voice-user-item") as HTMLElement;
    expect(voiceUserItem).not.toBeNull();
    voiceUserItem.click();

    // Watching a peer's stream needs a live LiveKit room -- without joining
    // first, showVideoGrid has no cells to focus and the user is stranded on
    // an empty grid. currentChannelId defaults to null (not channel 3 here).
    expect(onVoiceJoin).toHaveBeenCalledWith(3);
  });

  it("opens no stream when the join backoff refuses the stream row's join", () => {
    const onWatchStream = vi.fn();
    sidebar.destroy?.();
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall, onWatchStream });

    setChannels(testChannels);
    updateVoiceState({
      channel_id: 3,
      user_id: 30,
      username: "Streamer",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: true,
    });
    sidebar.mount(container);
    noteJoinFailed();

    try {
      (container.querySelector(".voice-user-item") as HTMLElement).click();
      // The join is still offered so its refusal toast shows, but no room was joined.
      expect(onVoiceJoin).toHaveBeenCalledWith(3);
      expect(onWatchStream).not.toHaveBeenCalled();
    } finally {
      noteJoinSucceeded();
    }
  });

  // ── Deafened and camera icons on voice users ──

  it("shows only the headphones-off icon for a deafened user (deafen implies mute)", () => {
    setChannels(testChannels);
    updateVoiceState({
      channel_id: 3,
      user_id: 40,
      username: "DeafUser",
      muted: false,
      deafened: true,
      speaking: false,
      camera: false,
      screenshare: false,
    });
    sidebar.mount(container);

    const userRow = container.querySelector(".voice-user-item");
    expect(userRow).not.toBeNull();
    // Deafened implies muted, so showing both mic-off and headphones-off is a
    // duplicate. Discord shows the single headphones-off.
    const mutedIcons = userRow!.querySelectorAll(".vu-muted");
    expect(mutedIcons.length).toBe(1);
    expect(mutedIcons[0]!.querySelector("svg")).not.toBeNull();
  });

  it("shows camera icon for user with active camera", () => {
    setChannels(testChannels);
    updateVoiceState({
      channel_id: 3,
      user_id: 50,
      username: "CameraUser",
      muted: false,
      deafened: false,
      speaking: false,
      camera: true,
      screenshare: false,
    });
    sidebar.mount(container);

    const statusIcon = container.querySelector(".vu-status");
    expect(statusIcon).not.toBeNull();
  });

  // ── Speaking state in-place toggle ──

  it("toggles speaking class in-place without re-rendering entire DOM", () => {
    setChannels(testChannels);
    updateVoiceState({
      channel_id: 3,
      user_id: 60,
      username: "Talker",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });
    sidebar.mount(container);

    const userRow = container.querySelector('.voice-user-item[data-voice-uid="60"]');
    expect(userRow).not.toBeNull();
    expect(userRow!.classList.contains("speaking")).toBe(false);

    // Update only speaking flag (structural signature stays the same).
    // setSpeakers is the only writer of speaking now (a voice_state no longer
    // clobbers the LiveKit-authoritative flag).
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 3 }));
    setSpeakers({ channel_id: 3, speakers: [60] });
    voiceStore.flush();

    // The same DOM element should now have speaking class toggled
    const updatedRow = container.querySelector('.voice-user-item[data-voice-uid="60"]');
    expect(updatedRow).not.toBeNull();
    expect(updatedRow!.classList.contains("speaking")).toBe(true);
  });

  it("speaking patch keeps the exact row element (cached map, no rebuild)", () => {
    setChannels(testChannels);
    updateVoiceState({
      channel_id: 3,
      user_id: 61,
      username: "Talker2",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });
    // setSpeakers only applies to the channel the client is in; set it before
    // mount so the later flip is speaking-only.
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 3 }));
    sidebar.mount(container);

    const rowBefore = container.querySelector('.voice-user-item[data-voice-uid="61"]');
    expect(rowBefore).not.toBeNull();

    // speaking-only flip → patched via the cached row map, not re-rendered
    setSpeakers({ channel_id: 3, speakers: [61] });
    voiceStore.flush();

    const rowAfter = container.querySelector('.voice-user-item[data-voice-uid="61"]');
    expect(rowAfter).toBe(rowBefore); // same element instance
    expect(rowAfter!.classList.contains("speaking")).toBe(true);

    // …and a structural change (mute) still re-renders with a fresh row.
    updateVoiceState({
      channel_id: 3,
      user_id: 61,
      username: "Talker2",
      muted: true,
      deafened: false,
      speaking: true,
      camera: false,
      screenshare: false,
    });
    voiceStore.flush();

    const rowRebuilt = container.querySelector('.voice-user-item[data-voice-uid="61"]');
    expect(rowRebuilt).not.toBe(rowBefore);
    expect(rowRebuilt!.querySelector(".vu-muted")).not.toBeNull();
    // The rebuilt row keeps the speaking class (patch runs after re-render).
    expect(rowRebuilt!.classList.contains("speaking")).toBe(true);
  });

  // ── Voice user avatar ──

  it("renders first-letter avatar with deterministic color for voice user", () => {
    setChannels(testChannels);
    updateVoiceState({
      channel_id: 3,
      user_id: 70,
      username: "Zara",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });
    sidebar.mount(container);

    const avatar = container.querySelector(".vu-avatar");
    expect(avatar).not.toBeNull();
    expect(avatar!.textContent).toBe("Z");
    // Avatar should have a background color set
    expect((avatar as HTMLElement).style.background).not.toBe("");
  });

  it("renders the member's profile picture in the voice row, keeping the speaking class", async () => {
    setChannels(testChannels);
    membersStore.setState((prev) => ({
      ...prev,
      members: new Map([
        [
          72,
          {
            id: 72,
            username: "Pic",
            avatar: "/api/v1/files/pic",
            role: "member",
            status: "online" as const,
          },
        ],
      ]),
    }));
    updateVoiceState({
      channel_id: 3,
      user_id: 72,
      username: "Pic",
      muted: false,
      deafened: false,
      speaking: true,
      camera: false,
      screenshare: false,
    });
    sidebar.mount(container);

    const row = container.querySelector(".voice-user-item")!;
    expect(row.classList.contains("speaking")).toBe(true);
    const avatar = row.querySelector<HTMLElement>(".vu-avatar")!;
    await vi.waitFor(() => {
      expect(avatar.querySelector<HTMLImageElement>(".avatar-img")?.getAttribute("src")).toBe(
        "data:image/png;base64,AAAA",
      );
    });
    expect(avatar.querySelector(".avatar-initial")).toBeNull();
  });

  it("keeps the initial for a voice user whose member has no avatar", () => {
    setChannels(testChannels);
    membersStore.setState((prev) => ({
      ...prev,
      members: new Map([
        [
          73,
          { id: 73, username: "Nopic", avatar: null, role: "member", status: "online" as const },
        ],
      ]),
    }));
    updateVoiceState({
      channel_id: 3,
      user_id: 73,
      username: "Nopic",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });
    sidebar.mount(container);

    const avatar = container.querySelector(".vu-avatar")!;
    expect(avatar.querySelector(".avatar-img")).toBeNull();
    expect(avatar.textContent).toBe("N");
  });

  it("shows '?' avatar for user with empty username", () => {
    setChannels(testChannels);
    updateVoiceState({
      channel_id: 3,
      user_id: 71,
      username: "",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });
    sidebar.mount(container);

    const avatar = container.querySelector(".vu-avatar");
    expect(avatar).not.toBeNull();
    expect(avatar!.textContent).toBe("?");
  });

  it("shows 'Unknown' name for user with empty username", () => {
    setChannels(testChannels);
    updateVoiceState({
      channel_id: 3,
      user_id: 71,
      username: "",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });
    sidebar.mount(container);

    const name = container.querySelector(".vu-name");
    expect(name?.textContent).toBe("Unknown");
  });

  // ── Multiple voice users in same channel ──

  it("renders multiple voice users under the same channel", () => {
    setChannels(testChannels);
    updateVoiceState({
      channel_id: 3,
      user_id: 90,
      username: "UserA",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });
    updateVoiceState({
      channel_id: 3,
      user_id: 91,
      username: "UserB",
      muted: true,
      deafened: false,
      speaking: true,
      camera: false,
      screenshare: false,
    });
    sidebar.mount(container);

    const userItems = container.querySelectorAll(".voice-user-item");
    expect(userItems.length).toBe(2);

    const names = Array.from(userItems).map((el) => el.querySelector(".vu-name")?.textContent);
    expect(names).toContain("UserA");
    expect(names).toContain("UserB");
  });

  // ── User with camera + screenshare shows both icons ──

  it("shows both camera and monitor icons when user has camera and screenshare", () => {
    setChannels(testChannels);
    updateVoiceState({
      channel_id: 3,
      user_id: 92,
      username: "MultiStream",
      muted: false,
      deafened: false,
      speaking: false,
      camera: true,
      screenshare: true,
    });
    sidebar.mount(container);

    const userRow = container.querySelector(".voice-user-item");
    expect(userRow).not.toBeNull();
    // Camera icon + screen icon = 2 .vu-status elements
    const statusIcons = userRow!.querySelectorAll(".vu-status");
    expect(statusIcons.length).toBe(2);
    // Plus LIVE badge
    const liveBadge = userRow!.querySelector(".vu-live-badge");
    expect(liveBadge).not.toBeNull();
  });

  // T1: Screenshare click → offset tileId
  it("passes screenshare tile offset when clicking screensharing user", () => {
    const onWatchStream = vi.fn();
    const sidebarWithWatch = createChannelSidebar({ onVoiceJoin, onOpenCall, onWatchStream });
    setChannels(testChannels);
    voiceStore.setState(() => ({
      currentChannelId: 3,
      voiceUsers: new Map([
        [
          3,
          new Map([
            [
              99,
              {
                userId: 99,
                username: "Streamer",
                speaking: false,
                muted: false,
                deafened: false,
                camera: false,
                screenshare: true,
              },
            ],
          ]),
        ],
      ]),
      voiceConfigs: new Map(),
      localMuted: false,
      localDeafened: false,
      localCamera: false,
      localScreenshare: false,
      joinedAt: null,
      listenOnly: false,
      voiceStatus: "idle",
    }));
    sidebarWithWatch.mount(container);

    const userRow = container.querySelector<HTMLElement>(".voice-user-item");
    expect(userRow).not.toBeNull();
    userRow!.click();

    expect(onWatchStream).toHaveBeenCalledWith(99 + 1_000_000);
    sidebarWithWatch.destroy?.();
  });

  // T2: Camera-only click → raw userId
  it("passes raw userId when clicking camera-only user", () => {
    const onWatchStream = vi.fn();
    const sidebarWithWatch = createChannelSidebar({ onVoiceJoin, onOpenCall, onWatchStream });
    setChannels(testChannels);
    voiceStore.setState(() => ({
      currentChannelId: 3,
      voiceUsers: new Map([
        [
          3,
          new Map([
            [
              99,
              {
                userId: 99,
                username: "Cammer",
                speaking: false,
                muted: false,
                deafened: false,
                camera: true,
                screenshare: false,
              },
            ],
          ]),
        ],
      ]),
      voiceConfigs: new Map(),
      localMuted: false,
      localDeafened: false,
      localCamera: false,
      localScreenshare: false,
      joinedAt: null,
      listenOnly: false,
      voiceStatus: "idle",
    }));
    sidebarWithWatch.mount(container);

    const userRow = container.querySelector<HTMLElement>(".voice-user-item");
    expect(userRow).not.toBeNull();
    userRow!.click();

    expect(onWatchStream).toHaveBeenCalledWith(99);
    sidebarWithWatch.destroy?.();
  });

  // The voice row has no hover/focus stream preview, for anyone.
  it("opens no stream preview when a voice row with video is hovered or focused", () => {
    vi.useFakeTimers();
    setChannels(testChannels);
    voiceStore.setState(() => ({
      currentChannelId: 3,
      voiceUsers: new Map([
        [
          3,
          new Map([
            [
              99,
              {
                userId: 99,
                username: "User",
                speaking: false,
                muted: false,
                deafened: false,
                camera: true,
                screenshare: false,
              },
            ],
          ]),
        ],
      ]),
      voiceConfigs: new Map(),
      localMuted: false,
      localDeafened: false,
      localCamera: false,
      localScreenshare: false,
      joinedAt: null,
      listenOnly: false,
      voiceStatus: "idle",
    }));
    sidebar.mount(container);
    const row = container.querySelector<HTMLElement>(".voice-user-item")!;
    row.dispatchEvent(new MouseEvent("mouseenter"));
    row.dispatchEvent(new FocusEvent("focusin"));
    vi.advanceTimersByTime(1000);
    expect(container.querySelector(".vu-preview")).toBeNull();
    vi.useRealTimers();
  });

  // T20: Constant shared — sidebar uses SCREENSHARE_TILE_ID_OFFSET from constants
  it("uses shared SCREENSHARE_TILE_ID_OFFSET constant", async () => {
    // Verify the constant is imported and used by checking the offset value
    const onWatchStream = vi.fn();
    const sidebarWithWatch = createChannelSidebar({ onVoiceJoin, onOpenCall, onWatchStream });
    setChannels(testChannels);
    voiceStore.setState(() => ({
      currentChannelId: 3,
      voiceUsers: new Map([
        [
          3,
          new Map([
            [
              1,
              {
                userId: 1,
                username: "User",
                speaking: false,
                muted: false,
                deafened: false,
                camera: false,
                screenshare: true,
              },
            ],
          ]),
        ],
      ]),
      voiceConfigs: new Map(),
      localMuted: false,
      localDeafened: false,
      localCamera: false,
      localScreenshare: false,
      joinedAt: null,
      listenOnly: false,
      voiceStatus: "idle",
    }));
    sidebarWithWatch.mount(container);

    container.querySelector<HTMLElement>(".voice-user-item")?.click();
    // 1 + 1_000_000 = 1_000_001 — proves the shared constant is used
    expect(onWatchStream).toHaveBeenCalledWith(1_000_001);
    sidebarWithWatch.destroy?.();
  });
});

// ── Voice rows drawn from row models (5.4c-2) ──
//
// The voice rows reconcile from VoiceUserRowModel / VoiceChannelChromeModel,
// kept current by one select over their stores. A row's node is kept unless
// something it draws changed; these pin which changes keep or rebuild which
// node, and where focus goes when its row goes.
describe("ChannelSidebar voice rows on models", () => {
  let container: HTMLDivElement;
  let sidebar: ReturnType<typeof createChannelSidebar>;
  let onVoiceJoin: Mock<(channelId: number) => void>;
  let onOpenCall: Mock<() => void>;

  const VOICE_CH = 3; // "voice-lobby" in testChannels

  function member(id: number, username: string, displayName?: string) {
    return {
      id,
      username,
      ...(displayName !== undefined ? { displayName } : {}),
      avatar: null,
      role: "member",
      status: "online" as const,
    };
  }

  function setMembersMap(list: ReturnType<typeof member>[]): void {
    membersStore.setState((prev) => ({
      ...prev,
      members: new Map(list.map((m) => [m.id, m] as const)),
    }));
  }

  function userRow(userId: number): HTMLElement | null {
    return container.querySelector<HTMLElement>(`.voice-user-item[data-voice-uid="${userId}"]`);
  }

  function wrapperOf(channelId: number): HTMLElement | null {
    return (
      container.querySelector<HTMLElement>(`.channel-item[data-channel-id="${channelId}"]`)
        ?.parentElement ?? null
    );
  }

  function leave(channelId: number, userId: number): void {
    removeVoiceUser({ channel_id: channelId, user_id: userId });
    voiceStore.flush();
  }

  it("a peer whose status flips to mismatch after mount gets a working badge click", async () => {
    setChannels(testChannels);
    addVoiceUser(VOICE_CH, 10, "Alice");
    setPeerVerif(10, "verified", "AB12 CD34 EF56 7890");
    sidebar.mount(container);
    const before = userRow(10)!;
    expect(before.querySelector(".vu-verify.verified")).not.toBeNull();

    setPeerVerif(10, "mismatch", null);
    voiceStore.flush();

    const after = userRow(10)!;
    expect(after).not.toBe(before);
    expect(after.querySelector(".vu-verify.verified")).toBeNull();
    (after.querySelector(".vu-verify.mismatch") as HTMLElement).click();
    await vi.waitFor(() => {
      expect(document.body.querySelector(".modal-overlay")).not.toBeNull();
    });
  });

  beforeEach(() => {
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
    onVoiceJoin = vi.fn<(channelId: number) => void>();
    onOpenCall = vi.fn<() => void>();
    sidebar = createChannelSidebar({ onVoiceJoin, onOpenCall });
  });

  afterEach(() => {
    sidebar.destroy?.();
    container.remove();
    mockGetUserLocalMute.mockImplementation(() => false);
  });

  it("rename mid-call updates the label", () => {
    setChannels(testChannels);
    setMembersMap([member(10, "alice", "Alice"), member(11, "bob", "Bob")]);
    addVoiceUser(VOICE_CH, 10, "alice");
    addVoiceUser(VOICE_CH, 11, "bob");
    sidebar.mount(container);
    expect(userRow(10)!.querySelector(".vu-name")!.textContent).toBe("Alice");
    const other = userRow(11);
    const revision = membersStore.getState().roleRevision;

    // A new display name in the member store alone: no roleRevision bump and
    // no voice store change.
    membersStore.setState((prev) => {
      const members = new Map(prev.members);
      members.set(10, member(10, "alice", "Alicia"));
      return { ...prev, members };
    });
    membersStore.flush();

    expect(membersStore.getState().roleRevision).toBe(revision);
    expect(userRow(10)!.querySelector(".vu-name")!.textContent).toBe("Alicia");
    expect(userRow(11)).toBe(other);
  });

  it("focused user row survives another user joining", () => {
    setChannels(testChannels.map((c) => (c.id === VOICE_CH ? { ...c, voice_max_users: 5 } : c)));
    addVoiceUser(VOICE_CH, 10, "alice");
    addVoiceUser(VOICE_CH, 11, "bob");
    sidebar.mount(container);
    const wrapper = wrapperOf(VOICE_CH);
    const focusedRow = userRow(11)!;
    focusedRow.focus();
    expect(document.activeElement).toBe(focusedRow);

    addVoiceUser(VOICE_CH, 12, "carol");
    voiceStore.flush();

    // The capacity readout is a chrome patch: the wrapper and the focused row
    // are kept, and focus never moves.
    expect(
      container.querySelector(`[data-testid="channel-capacity-${VOICE_CH}"]`)!.textContent,
    ).toBe("3/5");
    expect(wrapperOf(VOICE_CH)).toBe(wrapper);
    expect(userRow(11)).toBe(focusedRow);
    expect(document.activeElement).toBe(focusedRow);
  });

  it("focused user row survives a voice channel rename", () => {
    setChannels(testChannels);
    addVoiceUser(VOICE_CH, 10, "alice");
    addVoiceUser(VOICE_CH, 11, "bob");
    sidebar.mount(container);
    const wrapper = wrapperOf(VOICE_CH);
    userRow(11)!.focus();

    setChannels(testChannels.map((c) => (c.id === VOICE_CH ? { ...c, name: "hangout" } : c)));
    channelsStore.flush();

    // The wrapper is rebuilt (its signature changed); focus follows the key
    // path to the same participant in the replacement.
    expect(wrapperOf(VOICE_CH)).not.toBe(wrapper);
    expect(document.activeElement).toBe(userRow(11));
  });

  it("a focused user who leaves hands focus to the next participant, else the channel row", () => {
    setChannels(testChannels);
    addVoiceUser(VOICE_CH, 10, "alice");
    addVoiceUser(VOICE_CH, 11, "bob");
    addVoiceUser(VOICE_CH, 12, "carol");
    sidebar.mount(container);

    // The participant now at the leaver's position.
    userRow(11)!.focus();
    leave(VOICE_CH, 11);
    expect(document.activeElement).toBe(userRow(12));

    // The last one leaving: the participant before them.
    leave(VOICE_CH, 12);
    expect(document.activeElement).toBe(userRow(10));

    // The channel empties: its own row.
    leave(VOICE_CH, 10);
    expect(container.querySelector(".voice-users-list")).toBeNull();
    expect(document.activeElement).toBe(
      container.querySelector(`.channel-item[data-channel-id="${VOICE_CH}"]`),
    );
  });

  it("a focused participant whose channel stops showing hands focus to the category", () => {
    setChannels(testChannels);
    addVoiceUser(VOICE_CH, 10, "alice");
    uiStore.setState((prev) => ({
      ...prev,
      collapsedCategories: new Set(["Voice Channels"]),
    }));
    sidebar.mount(container);
    userRow(10)!.focus();

    // Collapsed, the channel shows only while occupied: emptied, it hides.
    leave(VOICE_CH, 10);

    expect(container.querySelector(`.channel-item[data-channel-id="${VOICE_CH}"]`)).toBeNull();
    const arrow = container.querySelector<HTMLElement>(
      '.category[data-category="Voice Channels"] .category-arrow',
    );
    expect(document.activeElement).toBe(arrow);
  });

  it("local mute event redraws only that user's row", () => {
    setChannels(testChannels);
    addVoiceUser(VOICE_CH, 82, "loud");
    addVoiceUser(VOICE_CH, 83, "quiet");
    sidebar.mount(container);
    const loud = userRow(82);
    const quiet = userRow(83);

    mockGetUserLocalMute.mockImplementation((id) => id === 82);
    window.dispatchEvent(
      new CustomEvent("owncord:user-local-mute-changed", { detail: { userId: 82 } }),
    );

    expect(userRow(82)).not.toBe(loud);
    expect(userRow(82)!.querySelector(".vu-local-muted")).not.toBeNull();
    expect(userRow(83)).toBe(quiet);
    expect(userRow(83)!.querySelector(".vu-local-muted")).toBeNull();
  });

  it("connection drop disables the channel without rebuilding user rows", () => {
    setChannels(testChannels);
    addVoiceUser(VOICE_CH, 10, "alice");
    addVoiceUser(VOICE_CH, 11, "bob");
    sidebar.mount(container);
    const wrapper = wrapperOf(VOICE_CH);
    const rows = [userRow(10), userRow(11)];

    uiStore.setState((prev) => ({ ...prev, connectionStatus: "reconnecting" as const }));
    uiStore.flush();

    const item = container.querySelector<HTMLElement>(
      `.channel-item[data-channel-id="${VOICE_CH}"]`,
    )!;
    expect(item.classList.contains("disabled")).toBe(true);
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.title).toBe("Reconnecting…");
    expect(wrapperOf(VOICE_CH)).toBe(wrapper);
    expect([userRow(10), userRow(11)]).toEqual(rows);
    expect(userRow(10)).toBe(rows[0]);
    expect(userRow(11)).toBe(rows[1]);
  });

  it("draggable follows connection status", () => {
    sidebar.destroy?.();
    authStore.setState(() => ({
      token: "tok",
      user: { id: 99, username: "Me", avatar: null, role: "admin" },
      serverName: "Test Server",
      motd: null,
      isAuthenticated: true,
    }));
    sidebar = createChannelSidebar({
      onVoiceJoin,
      onOpenCall,
      onVoiceModerate: voiceModCallbacks(),
    });
    setChannels(
      testChannels.map((c) => ({ ...c, can_moderate_voice: true, can_move_voice: true })),
    );
    addVoiceUser(VOICE_CH, 10, "alice");
    addVoiceUser(VOICE_CH, 99, "Me");
    sidebar.mount(container);
    const draggable = (id: number) => userRow(id)!.classList.contains("voice-user-draggable");
    expect(draggable(10)).toBe(true);
    expect(draggable(99)).toBe(false);

    uiStore.setState((prev) => ({ ...prev, connectionStatus: "reconnecting" as const }));
    uiStore.flush();
    expect(draggable(10)).toBe(false);

    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" as const }));
    uiStore.flush();
    expect(draggable(10)).toBe(true);
    expect(draggable(99)).toBe(false);
  });

  it("a click on the channel after joining opens the call", () => {
    setChannels(testChannels);
    sidebar.mount(container);
    const item = () =>
      container.querySelector<HTMLElement>(`.channel-item[data-channel-id="${VOICE_CH}"]`)!;
    const first = item();
    first.click();
    expect(onVoiceJoin).toHaveBeenCalledWith(VOICE_CH);
    expect(onOpenCall).not.toHaveBeenCalled();

    voiceStore.setState((prev) => ({ ...prev, currentChannelId: VOICE_CH }));
    voiceStore.flush();

    // The wrapper is reused (joined is a chrome patch), so the click reads
    // the joined channel when it fires, not when the row was built.
    expect(item()).toBe(first);
    expect(first.classList.contains("active")).toBe(true);
    first.click();
    expect(onOpenCall).toHaveBeenCalledTimes(1);
    expect(onVoiceJoin).toHaveBeenCalledTimes(1);
  });

  it("presence change of a member not in voice keeps every voice row node", () => {
    setChannels(testChannels);
    setMembersMap([member(10, "alice"), member(11, "bob"), member(50, "away")]);
    addVoiceUser(VOICE_CH, 10, "alice");
    addVoiceUser(VOICE_CH, 11, "bob");
    sidebar.mount(container);
    const wrapper = wrapperOf(VOICE_CH);
    const rows = [userRow(10), userRow(11)];

    membersStore.setState((prev) => {
      const members = new Map(prev.members);
      members.set(50, { ...member(50, "away"), status: "idle" as const });
      return { ...prev, members };
    });
    membersStore.flush();

    expect(wrapperOf(VOICE_CH)).toBe(wrapper);
    expect(userRow(10)).toBe(rows[0]);
    expect(userRow(11)).toBe(rows[1]);
  });

  it("speaking toggle keeps the same row node, its focus and a class another module set", () => {
    setChannels(testChannels);
    addVoiceUser(VOICE_CH, 60, "talker");
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: VOICE_CH }));
    sidebar.mount(container);
    const row = userRow(60)!;
    row.focus();
    // dragMove marks the live row it is dragging.
    row.classList.add("dragging");

    setSpeakers({ channel_id: VOICE_CH, speakers: [60] });
    voiceStore.flush();
    expect(userRow(60)).toBe(row);
    expect(row.classList.contains("speaking")).toBe(true);

    setSpeakers({ channel_id: VOICE_CH, speakers: [] });
    voiceStore.flush();
    expect(userRow(60)).toBe(row);
    expect(row.classList.contains("speaking")).toBe(false);
    expect(row.classList.contains("dragging")).toBe(true);
    expect(document.activeElement).toBe(row);
  });

  it("a reconnect replacing the voice state keeps unchanged rows and redraws a changed fingerprint", () => {
    setChannels(testChannels);
    addVoiceUser(VOICE_CH, 10, "alice");
    addVoiceUser(VOICE_CH, 11, "bob");
    setPeerVerif(10, "unverified", null, "AAAA 1111");
    setPeerVerif(11, "unverified", null, "BBBB 2222");
    sidebar.mount(container);
    const alice = userRow(10);
    const bob = userRow(11);

    // ready replaces both maps with fresh objects; only bob's fingerprint differs.
    voiceStore.setState((prev) => ({
      ...prev,
      voiceUsers: new Map(
        Array.from(prev.voiceUsers, ([ch, users]) => [
          ch,
          new Map(Array.from(users, ([uid, u]) => [uid, { ...u }] as const)),
        ]),
      ),
      peerVerifications: new Map([
        [
          10,
          { userId: 10, status: "unverified", safetyNumber: null, sessionFingerprint: "AAAA 1111" },
        ],
        [
          11,
          { userId: 11, status: "unverified", safetyNumber: null, sessionFingerprint: "CCCC 3333" },
        ],
      ]),
    }));
    voiceStore.flush();

    expect(userRow(10)).toBe(alice);
    expect(userRow(11)).not.toBe(bob);
    const title = userRow(11)!.querySelector(".vu-verify")!.getAttribute("title") ?? "";
    expect(title).toContain("CCCC 3333");
    expect(title).not.toContain("BBBB 2222");
  });
});
