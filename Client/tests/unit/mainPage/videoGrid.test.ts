import { describe, it, expect, vi } from "vitest";
import * as mocks from "../../helpers/mainPageMocks";
import { channelsStore, setActiveChannel } from "../../../src/stores/channels.store";
import { voiceStore, updateVoiceUserProfile } from "../../../src/stores/voice.store";
import { membersStore, updateMemberProfile } from "../../../src/stores/members.store";
import {
  fakeWs,
  fakeApi,
  textChannel,
  dmChannel,
  useWiredMainPage,
  mountPage,
  seedChannels,
  voiceChannel,
  openOneToOneDm,
  voiceUser,
  connectedDm,
  mountSettled,
  chatAreaProps,
  startCall,
  roster,
} from "../../helpers/mainPageHarness";

vi.mock("../../../src/features/content-consent/external", (importOriginal) =>
  mocks.consentExternalMock(importOriginal),
);
vi.mock("@lib/logger", () => mocks.loggerMock());
vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());
vi.mock("@lib/media/notificationSound", () => mocks.mediaNotificationSoundMock());
vi.mock("../../../src/features/direct-messages/callAlerts", () => mocks.messagesCallAlertsMock());
vi.mock("@components/UpdateNotifier", () => mocks.updateNotifierMock());
vi.mock("@lib/voice/audioElements", () => mocks.voiceAudioElementsMock());
vi.mock("@lib/presence/autoIdle", () => mocks.presenceAutoIdleMock());
vi.mock("../../../src/features/messaging/content/attachments", (importOriginal) =>
  mocks.listAttachmentsMock(importOriginal),
);
vi.mock("../../../src/pages/main-page/ChannelController", () => mocks.pageChannelControllerMock());
vi.mock("../../../src/pages/main-page/SidebarArea", () => mocks.pageSidebarAreaMock());
vi.mock("../../../src/features/navigation/destinations", () => mocks.navigationDestinationsMock());
vi.mock("../../../src/pages/main-page/ChatArea", () => mocks.pageChatAreaMock());

const {
  capturedOnRemoteVideo,
  mockCreateUpdateNotifier,
  mockCreateSidebarArea,
  capturedChatAreaRef,
  mockRenameGroup,
} = mocks;

describe("MainPage — video grid, DM profile panel, calls, settings", () => {
  const m = useWiredMainPage();

  /** Joins voice channel 9 alone and opens its call view from the sidebar. */
  const joinLoungeAndOpenCall = (): void => {
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 9, voiceUsers: roster(9, []) }));
    voiceStore.flush();
    (mockCreateSidebarArea.mock.calls.at(-1)![0] as { onOpenCall: () => void }).onOpenCall();
  };

  it("dismisses the video grid when switching to a non-voice channel (dm/announcement), not just 'text'", () => {
    seedChannels([textChannel(1, "general"), dmChannel(2, "dm-with-bob")], 1);

    m.page = mountPage(m.container);

    // Open the call view while in voice with the camera on (the real,
    // unmocked VideoModeController drives this off voiceStore).
    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 9,
      voiceUsers: roster(9, []),
      localCamera: true,
    }));
    voiceStore.flush();
    // Your own camera alone no longer covers the chat (WP 1B-4).
    expect(capturedChatAreaRef.current!.slots.messagesSlot.style.display).toBe("");
    (mockCreateSidebarArea.mock.calls.at(-1)![0] as { onOpenCall: () => void }).onOpenCall();

    expect(capturedChatAreaRef.current!.slots.messagesSlot.style.display).toBe("none");

    // Switch to a DM while the grid is up — a dm channel mounts a chat
    // surface just like text/announcement do, so the grid must not survive
    // the switch and hide it behind an unrelated video grid.
    setActiveChannel(2);
    channelsStore.flush();

    expect(capturedChatAreaRef.current!.slots.messagesSlot.style.display).toBe("");
  });

  it("opening the call view of a voice channel selects it and keeps its chat beside the grid", () => {
    seedChannels([textChannel(1, "general"), voiceChannel(9, "lounge", 1)], 1);

    m.page = mountPage(m.container);

    joinLoungeAndOpenCall();

    const { chatArea, slots } = capturedChatAreaRef.current!;
    expect(channelsStore.getState().activeChannelId).toBe(9);
    expect(slots.videoGridSlot.style.display).toBe("block");
    expect(slots.messagesSlot.style.display).toBe("");
    expect(slots.inputSlot.style.display).toBe("");
    expect(chatArea.classList.contains("chat-area--call-chat")).toBe(true);

    // Leaving the call closes the grid; the voice chat stays, full width.
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: null, voiceUsers: new Map() }));
    voiceStore.flush();
    channelsStore.flush();
    expect(channelsStore.getState().activeChannelId).toBe(9);
    expect(slots.videoGridSlot.style.display).toBe("none");
    expect(slots.messagesSlot.style.display).toBe("");
    expect(chatArea.classList.contains("chat-area--call-chat")).toBe(false);
  });

  it("opening another voice channel's chat while in a call dismisses the grid", () => {
    seedChannels(
      [textChannel(1, "general"), voiceChannel(9, "lounge", 1), voiceChannel(10, "music", 2)],
      1,
    );

    m.page = mountPage(m.container);

    joinLoungeAndOpenCall();
    const { slots } = capturedChatAreaRef.current!;
    expect(slots.videoGridSlot.style.display).toBe("block");

    setActiveChannel(10);
    channelsStore.flush();
    expect(slots.videoGridSlot.style.display).toBe("none");
    expect(slots.messagesSlot.style.display).toBe("");
  });

  it("does not clear a just-added remote video tile when a voice-channel switch left the camera/screenshare signature unchanged", () => {
    seedChannels([textChannel(1, "general")], 1);

    m.page = mountPage(m.container);

    // Alice joins voice channel A (9). Someone's camera briefly toggles the
    // signature so the real VideoModeController actually runs checkVideoMode
    // against channel 9 and latches its lastChannelId there — mirroring
    // "Alice is already in voice channel A" from the finding's repro.
    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 9,
      voiceUsers: roster(9, [voiceUser(100, { username: "carl", camera: true })]),
    }));
    voiceStore.flush();
    voiceStore.setState((prev) => ({
      ...prev,
      voiceUsers: roster(9, [voiceUser(100, { username: "carl" })]),
    }));
    voiceStore.flush();

    // Alice switches to voice channel B (10). Nobody in B has camera or
    // screenshare on either, so MainPage's camera/screenshare signature does
    // not change across the switch — the blind spot the finding describes.
    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 10,
      voiceUsers: roster(10, []),
    }));
    voiceStore.flush();

    // The switch itself may legitimately clear stale tiles from channel A
    // (that is the correct, eager fix) — what matters for this finding is
    // that nothing clears the grid again *after* the new tile is added.
    const videoGrid = capturedChatAreaRef.current!.videoGrid;
    videoGrid.clearStreams.mockClear();

    // Bob's screenshare track arrives via LiveKit in channel B ahead of the
    // server's voice_state broadcast (the documented TrackSubscribed race).
    const fakeStream = {} as MediaStream;
    capturedOnRemoteVideo.current!(200, fakeStream, true);

    expect(videoGrid.addStream).toHaveBeenCalled();
    // The bug: VideoModeController's lastChannelId is still stuck on channel
    // A (9) because the switch to B (10) never changed the signature, so the
    // checkVideoMode() call right after addStream sees a "channel change"
    // that isn't one and wipes the tile it was just given.
    expect(videoGrid.clearStreams).not.toHaveBeenCalled();
  });

  it("applies a cross-channel roster click's channel change before watching, so clearStreams cannot drop the watch", () => {
    seedChannels([textChannel(1, "general"), voiceChannel(10, "lounge", 1)], 1);
    m.page = mountPage(m.container);

    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 9,
      voiceUsers: new Map([
        ...roster(9, [voiceUser(100, { screenshare: true })]),
        ...roster(10, [voiceUser(200, { screenshare: true })]),
      ]),
    }));
    voiceStore.flush();
    channelsStore.flush();

    const grid = capturedChatAreaRef.current!.videoGrid;
    grid.clearStreams.mockClear();
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 10 }));
    // The roster click (ChannelSidebar) joins first, then asks the page to watch.
    (
      mockCreateSidebarArea.mock.calls.at(-1)![0] as { onWatchStream: (userId: number) => void }
    ).onWatchStream(200);

    expect(grid.watch).toHaveBeenCalledOnce();
    expect(grid.clearStreams).toHaveBeenCalled();
    expect(grid.clearStreams.mock.invocationCallOrder[0]!).toBeLessThan(
      grid.watch.mock.invocationCallOrder[0]!,
    );
  });

  it("opens the call view from the joined channel, and keeps its avatar tiles in step with who joins (1B-1)", () => {
    seedChannels([textChannel(1, "general")], 1);
    m.page = mountPage(m.container);

    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 9,
      voiceUsers: roster(9, [voiceUser(100)]),
    }));
    voiceStore.flush();

    (mockCreateSidebarArea.mock.calls.at(-1)![0] as { onOpenCall: () => void }).onOpenCall();

    const { slots, videoGrid } = capturedChatAreaRef.current!;
    expect(slots.messagesSlot.style.display).toBe("none");
    const ids = () =>
      (videoGrid.setPeople.mock.calls.at(-1)![0] as { userId: number }[]).map((p) => p.userId);
    expect(ids()).toEqual([100]);

    // A join with no video changes no camera/share flag.
    voiceStore.setState((prev) => ({
      ...prev,
      voiceUsers: roster(9, [voiceUser(100), voiceUser(101)]),
    }));
    voiceStore.flush();
    expect(ids()).toEqual([100, 101]);
    expect(slots.messagesSlot.style.display).toBe("none");
  });

  it("relabels a remote video tile with the member's display name, not the raw username, and keeps it in sync with a mid-call rename", () => {
    seedChannels([textChannel(1, "general")], 1);
    membersStore.setState(() => ({
      members: new Map([
        [
          200,
          {
            id: 200,
            username: "bob_1994",
            avatar: null,
            role: "member",
            status: "online" as const,
            displayName: "Bee",
          },
        ],
      ]),
      typingUsers: new Map(),
      roleRevision: 0,
    }));

    m.page = mountPage(m.container);

    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 9,
      voiceUsers: roster(9, [voiceUser(200, { username: "bob_1994", camera: true })]),
    }));
    voiceStore.flush();

    const fakeStream = {} as MediaStream;
    capturedOnRemoteVideo.current!(200, fakeStream, false);

    const videoGrid = capturedChatAreaRef.current!.videoGrid;
    // The tile must show the same identity the voice roster and every other
    // surface show for user 200 — the nickname "Bee" — not the raw username
    // "bob_1994" (ChannelSidebar.ts's memberDisplayName idiom).
    expect(videoGrid.addStream).toHaveBeenCalledWith(
      200,
      "Bee",
      fakeStream,
      expect.objectContaining({ isSelf: false }),
    );

    // Bob renames himself mid-call (Settings -> Account). The USER_UPDATE
    // fan-out updates both membersStore and voiceStore's frozen username
    // copy, exactly like dispatcher.ts's USER_UPDATE handler does.
    updateMemberProfile(200, { username: "bob_1994", avatar: null, displayName: "Robert" });
    updateVoiceUserProfile(200, { username: "bob_1994" });
    voiceStore.flush();

    // The already-open tile must pick up the new name without the tile
    // being torn down and re-created (no new addStream call for tile 200).
    expect(videoGrid.setLabel).toHaveBeenCalledWith(200, "Robert", "Robert");
  });

  it('keeps "(You)" on the self-view tile when the server echoes our own voice_state', () => {
    seedChannels([textChannel(1, "general")], 1);

    m.page = mountPage(m.container);

    // resetStores authenticates user 1 ("alice"). This is the server's own
    // voice_state echo landing in voiceUsers for the local user — updateVoiceState
    // writes self into the roster exactly like any other member.
    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 9,
      voiceUsers: roster(9, [voiceUser(1, { username: "alice", camera: true })]),
    }));
    voiceStore.flush();

    const videoGrid = capturedChatAreaRef.current!.videoGrid;
    // VideoModeController registers the self tile under the local user id with
    // "alice (You)". The relabel loop walks the whole roster, self included, so
    // it must produce the same self label — not the bare remote form, which
    // would leave your own tile indistinguishable from a participant's.
    expect(videoGrid.setLabel).not.toHaveBeenCalledWith(1, "alice", "alice");
    expect(videoGrid.setLabel).toHaveBeenCalledWith(1, "alice (You)", "alice");
  });

  it("brackets a bare IPv6 host when building the auto-updater URL", () => {
    seedChannels([textChannel(1, "general")], 1);

    m.page = mountPage(m.container, fakeWs(), fakeApi("2001:db8::1"));

    // A bare IPv6 literal spliced into a URL authority is not parseable — the
    // host parser enters the port state at the first colon — so build_updater
    // rejects it and checkForUpdate reports "no update available" forever.
    // Every other URL-building site brackets it (ws.ts, admin-panel.ts,
    // attachments.ts); this one did not.
    expect(mockCreateUpdateNotifier).toHaveBeenCalledWith({
      serverUrl: "https://[2001:db8::1]",
      keepChecking: true,
    });
  });

  it("leaves a DNS host unbracketed in the auto-updater URL", () => {
    seedChannels([textChannel(1, "general")], 1);

    m.page = mountPage(m.container, fakeWs(), fakeApi("chat.example.com:8443"));

    expect(mockCreateUpdateNotifier).toHaveBeenCalledWith({
      serverUrl: "https://chat.example.com:8443",
      keepChecking: true,
    });
  });

  it("stops your screen share from the grid's self-preview cover, and names remote tiles for their controls", async () => {
    const { disableScreenshare } = await import("@lib/voice/livekitSession");
    m.page = mountPage(m.container);
    const grid = capturedChatAreaRef.current!.videoGrid;
    const cbs = grid.setCallbacks.mock.calls.at(-1)![0] as { onStopSharing: () => void };

    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 9, localScreenshare: true }));
    cbs.onStopSharing();
    expect(disableScreenshare).toHaveBeenCalled();

    // A remote tile carries the person's name for its control labels.
    membersStore.setState((prev) => {
      const members = new Map(prev.members);
      members.set(10, {
        id: 10,
        username: "bob",
        displayName: "Bobby",
        avatar: null,
        role: "member",
        status: "online",
      });
      return { ...prev, members };
    });
    voiceStore.setState((prev) => ({
      ...prev,
      voiceUsers: roster(9, [voiceUser(10, { username: "bob", screenshare: true })]),
    }));
    capturedOnRemoteVideo.current!(10, {} as MediaStream, true);
    const config = grid.addStream.mock.calls.at(-1)![3] as { name?: string };
    expect(config.name).toBe("Bobby");
  });

  it("the header's video call button joins the DM call and turns the camera on once connected (3B-1)", async () => {
    const ws = fakeWs();
    connectedDm(50);
    m.page = await mountSettled(m.container, ws);
    const lk = await import("@lib/voice/livekitSession");
    vi.mocked(lk.enableCamera).mockClear();

    chatAreaProps().onStartVideoCall();
    // Not before the join lands: the camera follows "connected".
    expect(lk.enableCamera).not.toHaveBeenCalled();
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 50, voiceStatus: "connected" }));
    voiceStore.flush();
    expect(lk.enableCamera).toHaveBeenCalledTimes(1);
    m.page.destroy?.();
  });

  it("the header's group name click renames the open DM through the sidebar (3B-1)", () => {
    openOneToOneDm(50);
    m.page = mountPage(m.container);

    chatAreaProps().onRenameGroup();

    expect(mockRenameGroup).toHaveBeenCalledWith(50);
    m.page.destroy?.();
  });

  it("Video while already connected in the DM's call turns the camera on at once (3B-1)", async () => {
    const ws = fakeWs();
    connectedDm(50);
    m.page = await mountSettled(m.container, ws);
    const lk = await import("@lib/voice/livekitSession");
    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 50,
      voiceStatus: "connected",
      localCamera: false,
    }));
    voiceStore.flush();
    vi.mocked(lk.enableCamera).mockClear();

    chatAreaProps().onStartVideoCall();

    expect(lk.enableCamera).toHaveBeenCalledTimes(1);
    m.page.destroy?.();
  });

  it("a Video start refused by join backoff does not arm the camera for a later plain join (3B-1)", async () => {
    const ws = fakeWs();
    connectedDm(50);
    m.page = await mountSettled(m.container, ws);
    const lk = await import("@lib/voice/livekitSession");
    vi.mocked(lk.enableCamera).mockClear();
    const { noteJoinFailed } = await import("../../../src/features/voice/joinBackoff");
    noteJoinFailed(Date.now(), true);
    noteJoinFailed(Date.now(), true);
    noteJoinFailed(Date.now(), true);

    chatAreaProps().onStartVideoCall();
    // The refused join left no channel; a later join of the same DM, plain.
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 50, voiceStatus: "connected" }));
    voiceStore.flush();

    expect(lk.enableCamera).not.toHaveBeenCalled();
    m.page.destroy?.();
    const { noteJoinSucceeded } = await import("../../../src/features/voice/joinBackoff");
    noteJoinSucceeded();
  });

  it("a plain header call leaves the camera off (3B-1)", async () => {
    const ws = fakeWs();
    connectedDm(50);
    m.page = await mountSettled(m.container, ws);
    const lk = await import("@lib/voice/livekitSession");
    vi.mocked(lk.enableCamera).mockClear();

    startCall();
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 50, voiceStatus: "connected" }));
    voiceStore.flush();
    expect(lk.enableCamera).not.toHaveBeenCalled();
    m.page.destroy?.();
  });
});
