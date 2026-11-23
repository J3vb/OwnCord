/**
 * The channel list's tree mode. Command Deck draws today's rows as tree items
 * through a flag on the one implementation, so this table runs the region's
 * behaviours with the flag off (Classic) and on (Deck), and names the tree-mode
 * branch each case covers. The branches (Client brief, C7):
 *   1 channelRow.view   2 voiceRow.view (+ voiceUserRow.view)   3 voiceRowModel
 *   4 channelListRender 5 ChannelSidebar   6 channelRowBinders  7 categoryMenu
 *   8 volumeMenu + voiceSidebarRows        9 dragMove
 *   10 Direct folder: dmFolder, sidebarDmRow, dmNavRow and the `direct` mount in ChannelSidebar
 *   11 voiceUserRow.view + voiceRowModel: the second line   12 dragHitTest: the drop midpoint
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mocks from "../../helpers/channelSidebarMocks";
import { createChannelSidebar } from "../../../src/features/channels/ChannelSidebar";
import type { TreeSection } from "../../../src/features/channels/channelSidebarTypes";
import { drawVoiceChannelChrome } from "../../../src/features/channels/voiceRow.view";
import { voiceChannelChrome } from "../../../src/features/channels/voiceRowModel";
import { channelsStore, setActiveChannel, setChannels } from "../../../src/stores/channels.store";
import { membersStore } from "../../../src/stores/members.store";
import { applyReadyActivities, setMembers } from "../../../src/stores/members.store";
import {
  findDropTarget,
  type ChannelDrag,
} from "../../../src/features/channels/sidebar/dragHitTest";
import { uiStore } from "../../../src/stores/ui.store";
import { voiceStore, updateVoiceState, setSpeakers } from "../../../src/stores/voice.store";
import { publishFollowedThreads } from "../../../src/stores/followedThreads.store";
import { withMusicSharer } from "../../../src/stores/voicePeers";
import { muteChannel, invalidateMuteCache } from "@lib/prefs/channelMutes";
import { setHideMutedChannels } from "@lib/prefs/hideMutedChannels";
import { listenToMusic } from "@lib/voice/livekitSession";
import type { ReadyChannel } from "../../../src/lib/types";
import type { ReadyMember } from "../../../src/lib/types";
import {
  addVoiceUser,
  resetStores,
  rightClick,
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

const VOICE = 7;
const channel = (id: number, extra: Partial<ReadyChannel> = {}): ReadyChannel => ({
  id,
  name: `chan-${id}`,
  type: "text",
  category: "Info",
  category_id: 4,
  position: id,
  unread_count: 0,
  last_message_id: 1,
  ...extra,
});
const voiceChannel = (extra: Partial<ReadyChannel> = {}): ReadyChannel => ({
  id: VOICE,
  name: "lounge",
  type: "voice",
  category: "Voice",
  category_id: 5,
  position: 0,
  ...extra,
});

/** Two categories: Info (general, off-topic) and Voice (lounge). */
const SEED: ReadyChannel[] = [
  channel(1, { name: "general" }),
  channel(2, { name: "off-topic", unread_count: 3 }),
  voiceChannel(),
];

let container: HTMLDivElement;
let sidebar: ReturnType<typeof createChannelSidebar> | null = null;
const onVoiceJoin = vi.fn<(id: number) => void>();
const onOpenCall = vi.fn<() => void>();
const onCreateChannel = vi.fn();

function mount(tree: boolean, seed: ReadyChannel[] = SEED): void {
  sidebar?.destroy?.();
  setChannels(seed);
  sidebar = createChannelSidebar({
    tree,
    onVoiceJoin,
    onOpenCall,
    onCreateChannel,
    onCreateCategory: vi.fn(),
  });
  sidebar.mount(container);
}

const member = (id: number, username: string): ReadyMember => ({
  id,
  username,
  avatar: null,
  role: "member",
  status: "online",
});
const row = (id: number): HTMLElement =>
  container.querySelector<HTMLElement>(`.channel-item[data-channel-id="${id}"]`)!;
const header = (name: string): HTMLElement =>
  container.querySelector<HTMLElement>(`.category[data-category="${name}"]`)!;
const items = (): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>("[role=treeitem]"));
const flush = (): void => {
  channelsStore.flush();
  voiceStore.flush();
  uiStore.flush();
};

beforeEach(() => {
  localStorage.clear();
  invalidateMuteCache();
  resetStores();
  publishFollowedThreads({ byParent: new Map(), focusedId: null });
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  sidebar?.destroy?.();
  sidebar = null;
  mocks.mockGetUserLocalMute.mockReturnValue(false);
  container.remove();
  document.querySelectorAll(".context-menu, .user-vol-menu").forEach((el) => el.remove());
});

describe.each([
  ["classic", false],
  ["deck", true],
] as const)("channel list in %s", (_layout, tree) => {
  it("[1] a click opens a text row and the voice row joins", () => {
    mount(tree);
    row(1).click();
    expect(channelsStore.getState().activeChannelId).toBe(1);
    row(VOICE).click();
    expect(onVoiceJoin).toHaveBeenCalledWith(VOICE);
  });

  it("[1] an unread row is bold with a mention badge only for mentions", () => {
    mount(tree, [...SEED, channel(3, { name: "alerts", mention_count: 2 })]);
    expect(row(2).classList.contains("unread")).toBe(true);
    expect(row(2).querySelector(".mention-badge")).toBeNull();
    expect(row(3).querySelector(".mention-badge")?.textContent).toBe("2");
  });

  it("[1] a muted row is dimmed but keeps its mention badge; hidden when the preference says", () => {
    muteChannel(1);
    mount(tree, [channel(1, { name: "general", mention_count: 1 }), channel(2)]);
    expect(row(1).classList.contains("muted")).toBe(true);
    expect(row(1).querySelector(".mention-badge")).not.toBeNull();
    setHideMutedChannels(true);
    flush();
    // A muted row with a mention stays; a plain muted one goes.
    muteChannel(2);
    flush();
    expect(container.querySelector('.channel-item[data-channel-id="2"]')).toBeNull();
    expect(row(1)).not.toBeNull();
  });

  it("[2] a voice channel with a password shows the lock and a joined row is active", () => {
    mount(tree, [voiceChannel({ password_protected: true })]);
    expect(container.querySelector(".ch-password")).not.toBeNull();
    voiceStore.setState((p) => ({ ...p, currentChannelId: VOICE }));
    flush();
    expect(row(VOICE).classList.contains("active")).toBe(true);
  });

  it("[6] each menu: a channel row's and a category header's open on a right click", () => {
    setAdminUser();
    mount(tree);
    rightClick(row(1));
    expect(document.querySelector('[data-testid="channel-context-menu"]')).not.toBeNull();
    document.querySelectorAll(".context-menu").forEach((el) => el.remove());
    rightClick(header("Info"));
    expect(document.querySelector('[data-testid="category-context-menu"]')).not.toBeNull();
  });

  it("[1][6] collapse: a header click hides the category's idle rows, a second shows them", () => {
    mount(tree);
    header("Info").click();
    flush();
    expect(container.querySelector('.channel-item[data-channel-id="1"]')).toBeNull();
    // The unread row stays visible in a collapsed category.
    expect(row(2)).not.toBeNull();
    header("Info").click();
    flush();
    expect(row(1)).not.toBeNull();
  });

  it("[4] a focused unread row a collapsed category stops showing hands focus to the header in a tree, the arrow otherwise", () => {
    mount(tree);
    header("Info").click();
    flush();
    row(2).focus();
    expect(document.activeElement).toBe(row(2));
    channelsStore.setState((prev) => {
      const channels = new Map(prev.channels);
      channels.set(2, { ...channels.get(2)!, unreadCount: 0 });
      return { ...prev, channels };
    });
    flush();
    expect(container.querySelector('.channel-item[data-channel-id="2"]')).toBeNull();
    const expected = tree ? header("Info") : header("Info").querySelector(".category-arrow");
    expect(document.activeElement).toBe(expected);
  });

  it("[6] drag attributes follow the manager's permission", () => {
    setAdminUser();
    sidebar?.destroy?.();
    setChannels(SEED);
    sidebar = createChannelSidebar({
      tree,
      onVoiceJoin,
      onOpenCall,
      onReorderChannel: vi.fn(),
      onReorderCategory: vi.fn(),
    });
    sidebar.mount(container);
    expect(row(1).dataset.dragChannelId).toBe("1");
    expect(header("Info").classList.contains("category-draggable")).toBe(true);
  });

  it("[4][5] one Tab stop: a single tabbable row after a render", () => {
    mount(tree);
    // Classic's stop is a channel row; the tree's is its first item, a header.
    expect(container.querySelectorAll("[tabindex='0']")).toHaveLength(1);
  });

  it("[2][4] a joined voice channel in a collapsed category stays drawn", () => {
    voiceStore.setState((p) => ({ ...p, currentChannelId: VOICE }));
    mount(tree);
    header("Voice").click();
    flush();
    expect(header("Voice").classList.contains("collapsed")).toBe(true);
    expect(row(VOICE)).not.toBeNull();
  });

  it("[2][3] the voice-user state classes draw: shield, listen pill, server mute, local mute", () => {
    signInAs({ id: 1, username: "me", avatar: null, role: "member" });
    mocks.mockGetUserLocalMute.mockReturnValue(true);
    voiceStore.setState((p) => withMusicSharer({ ...p, currentChannelId: VOICE }, 2, true));
    mount(tree);
    addVoiceUser(VOICE, 2, "rin", { muted: true });
    updateVoiceState({
      channel_id: VOICE,
      user_id: 3,
      username: "sam",
      muted: true,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
      server_muted: true,
    });
    voiceStore.setState((p) => ({
      ...p,
      peerVerifications: new Map([
        [2, { userId: 2, status: "verified", safetyNumber: "1 2", sessionFingerprint: null }],
      ]),
    }));
    flush();
    expect(container.querySelector(".vu-verify.verified")).not.toBeNull();
    expect(container.querySelector(".vu-listen")).not.toBeNull();
    expect(container.querySelector(".vu-server-muted")).not.toBeNull();
    expect(container.querySelector(".vu-local-muted")).not.toBeNull();
  });

  it("[4][2] the list node and a voice row survive a speaking flip", () => {
    mount(tree);
    addVoiceUser(VOICE, 2, "rin");
    flush();
    const list = container.querySelector(".channel-list");
    const user = container.querySelector(".voice-user-item");
    // setSpeakers is the only writer of speaking.
    voiceStore.setState((p) => ({ ...p, currentChannelId: VOICE }));
    setSpeakers({ channel_id: VOICE, speakers: [2] });
    flush();
    expect(container.querySelector(".channel-list")).toBe(list);
    expect(container.querySelector(".voice-user-item")).toBe(user);
    expect(user?.classList.contains("speaking")).toBe(true);
  });

  it("[4] an empty list shows the empty state, and a fill leaves none behind", () => {
    mount(tree, []);
    expect(container.querySelectorAll(".channel-list-empty")).toHaveLength(1);
    // In a tree the empty state sits in the sidebar root, before the tree.
    if (tree) {
      expect(container.querySelector(".server-tree .channel-list-empty")).toBeNull();
      expect(container.querySelector(".channel-sidebar > .channel-list-empty")).not.toBeNull();
    }
    setChannels(SEED);
    flush();
    expect(container.querySelector(".channel-list-empty")).toBeNull();
    setChannels([]);
    flush();
    expect(container.querySelectorAll(".channel-list-empty")).toHaveLength(1);
  });
});

describe("channel list in classic only", () => {
  it("[1][2][5] draws no tree attribute, vu-self, LIVE or create-channel menu entry", () => {
    setAdminUser();
    voiceStore.setState((p) => ({ ...p, currentChannelId: VOICE }));
    mount(false);
    addVoiceUser(VOICE, 1, "Admin");
    addVoiceUser(VOICE, 2, "rin", { screenshare: true });
    flush();
    expect(container.querySelector("[role=treeitem], [data-tree-kind], .server-tree")).toBeNull();
    expect(container.querySelector("[data-tree-group], [role=tree]")).toBeNull();
    expect(container.querySelector(".vu-self, .ch-live")).toBeNull();
    expect(container.querySelector(".vu-text, .vu-activity")).toBeNull();
    expect(container.querySelector("button.category-arrow")).not.toBeNull();
    rightClick(header("Info"));
    expect(document.querySelector('[data-testid="ctx-category-create-channel"]')).toBeNull();
  });
});

describe("channel list in deck only", () => {
  const live = (): HTMLElement | null => row(VOICE).querySelector<HTMLElement>(".ch-live");

  function expectPatchedEqualsFresh(): void {
    const el = row(VOICE).parentElement!;
    const channelRow = channelsStore.getState().channels.get(VOICE)!;
    const model = voiceChannelChrome(
      channelRow,
      {
        voiceUsers: voiceStore.getState().voiceUsers,
        currentChannelId: voiceStore.getState().currentChannelId,
        peerVerifications: new Map(),
        localSessionFingerprint: null,
        localSafetyNumber: null,
        voiceMembers: new Map(),
        selfId: null,
        connectionStatus: "connected",
        timeout: null,
        movable: [],
        localMute: {},
      },
      true,
    );
    const fresh = drawVoiceChannelChrome(model, true);
    // The tree stamps level, set and Tab stop on a live row; a fresh draw has none yet.
    const bare = (node: Element): string =>
      node.outerHTML.replace(/ (aria-(level|setsize|posinset)|tabindex)="\d+"/g, "");
    expect(bare(el.querySelector(":scope > .channel-item")!)).toBe(
      bare(fresh.querySelector(":scope > .channel-item")!),
    );
  }

  it("[2][3] LIVE appears after the lock and AFK and before capacity, and tracks the share", () => {
    mount(true, [voiceChannel({ voice_max_users: 8 })]);
    addVoiceUser(VOICE, 2, "rin");
    flush();
    expect(live()).toBeNull();

    addVoiceUser(VOICE, 2, "rin", { screenshare: true });
    flush();
    expect(live()?.textContent).toBe("LIVE");
    expect(row(VOICE).querySelector(".ch-live + .ch-capacity")).not.toBeNull();
    expectPatchedEqualsFresh();

    addVoiceUser(VOICE, 2, "rin", { screenshare: false });
    flush();
    expect(live()).toBeNull();
    expectPatchedEqualsFresh();

    addVoiceUser(VOICE, 2, "rin", { screenshare: true });
    setChannels([voiceChannel({ voice_max_users: 8, password_protected: true })]);
    flush();
    const order = Array.from(row(VOICE).children).map((c) => c.className.split(" ")[0]);
    expect(order.indexOf("ch-password")).toBeLessThan(order.indexOf("ch-live"));
    expect(order.indexOf("ch-live")).toBeLessThan(order.indexOf("ch-capacity"));
    expectPatchedEqualsFresh();
  });

  it("[1] a thread is open: the thread and its parent channel match the active-row selector, and no other does", () => {
    mount(true);
    setActiveChannel(1);
    publishFollowedThreads({
      byParent: new Map([
        [1, [{ id: 50, parentId: 1, name: "patch notes", unread: 0, mentions: 0, activityAt: 1 }]],
      ]),
      focusedId: 50,
    });
    flush();
    const hits = Array.from(
      container.querySelectorAll<HTMLElement>('[role=treeitem][aria-current="page"]'),
    ).map((el) => el.getAttribute("data-testid"));
    expect(hits.sort()).toEqual(["channel-1", "thread-row-50"]);
  });

  it("[1] the active-row selector matches the active text channel, not the joined voice channel", () => {
    setActiveChannel(1);
    voiceStore.setState((p) => ({ ...p, currentChannelId: VOICE }));
    mount(true);
    expect(row(1).matches('[role=treeitem][aria-current="page"]')).toBe(true);
    expect(row(VOICE).classList.contains("active")).toBe(true);
    expect(row(VOICE).matches('[role=treeitem][aria-current="page"]')).toBe(false);
  });

  it("[1] no row or child item carries aria-expanded, and the views write no level", () => {
    mount(true);
    addVoiceUser(VOICE, 2, "rin");
    flush();
    for (const el of items()) {
      if (el.dataset.treeKind === "head") {
        expect(el.getAttribute("aria-expanded")).not.toBeNull();
      } else {
        expect(el.hasAttribute("aria-expanded"), el.dataset.testid).toBe(false);
      }
    }
  });

  it("[1][5] draws header, row and child kinds, a group marker and a labelled tree", () => {
    mount(true);
    addVoiceUser(VOICE, 2, "rin");
    flush();
    expect(container.querySelector(".server-tree")?.getAttribute("role")).toBe("tree");
    expect(container.querySelector(".server-tree")?.getAttribute("aria-labelledby")).toBe(
      "server-tree-name",
    );
    expect(header("Info").dataset.treeKind).toBe("head");
    expect(row(1).dataset.treeKind).toBe("row");
    expect(row(VOICE).dataset.treeKind).toBe("row");
    expect(container.querySelector(".voice-user-item")?.getAttribute("data-tree-kind")).toBe(
      "child",
    );
    expect(container.querySelectorAll("[data-tree-group]")).toHaveLength(2);
    // The chevron is decorative; the header is the control.
    expect(header("Info").querySelector("button.category-arrow")).toBeNull();
    expect(header("Info").querySelector(".category-arrow")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("[5][1] Enter on a voice channel calls the join callback once", () => {
    mount(true);
    row(VOICE).focus();
    row(VOICE).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    expect(onVoiceJoin).toHaveBeenCalledTimes(1);
    expect(onVoiceJoin).toHaveBeenCalledWith(VOICE);
  });

  it("[5][4] focus stays on a category header through Enter, Left and Right", () => {
    mount(true);
    const key = (k: string): void => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }),
      );
      flush();
    };
    header("Info").focus();
    key("Enter");
    expect(document.activeElement).toBe(header("Info"));
    expect(header("Info").getAttribute("aria-expanded")).toBe("false");
    key("ArrowRight");
    expect(document.activeElement).toBe(header("Info"));
    expect(header("Info").getAttribute("aria-expanded")).toBe("true");
    key("ArrowLeft");
    expect(document.activeElement).toBe(header("Info"));
    expect(header("Info").getAttribute("aria-expanded")).toBe("false");
  });

  it("[2] your own voice row's name carries vu-self, with no '(you)' text", () => {
    signInAs({ id: 1, username: "kade", avatar: null, role: "member" });
    mount(true);
    addVoiceUser(VOICE, 1, "kade");
    addVoiceUser(VOICE, 2, "rin");
    flush();
    const names = Array.from(container.querySelectorAll<HTMLElement>(".vu-name"));
    expect(names.map((n) => [n.textContent, n.classList.contains("vu-self")])).toEqual([
      ["kade", true],
      ["rin", false],
    ]);
  });

  it("[2][3][11] a person with a game gets a second line under the name; one without keeps the single line", () => {
    mount(true);
    setMembers([member(1, "kade"), member(2, "rin")]);
    applyReadyActivities([{ user_id: 2, name: "Hades II", started_at: 100 }]);
    addVoiceUser(VOICE, 1, "kade");
    addVoiceUser(VOICE, 2, "rin");
    flush();
    const rin = container.querySelector('.voice-user-item[data-voice-uid="2"]')!;
    expect(rin.querySelector(":scope > .vu-text > .vu-activity")?.textContent).toBe(
      "Playing Hades II",
    );
    const kade = container.querySelector('.voice-user-item[data-voice-uid="1"]')!;
    expect(kade.querySelector(".vu-text, .vu-activity")).toBeNull();
  });

  it("[12] over the voice channel's people the drop is after it; over its own row's top half, before", () => {
    setAdminUser();
    setChannels(SEED);
    sidebar = createChannelSidebar({
      tree: true,
      onVoiceJoin,
      onOpenCall,
      onReorderChannel: vi.fn(),
      onReorderCategory: vi.fn(),
    });
    sidebar.mount(container);
    addVoiceUser(VOICE, 2, "rin");
    flush();
    const wrapper = row(VOICE).parentElement!;
    const rect = (top: number, height: number): DOMRect =>
      ({ top, bottom: top + height, height, left: 0, right: 240, width: 240 }) as DOMRect;
    row(VOICE).getBoundingClientRect = () => rect(100, 24);
    wrapper.getBoundingClientRect = () => rect(100, 124);
    const source = row(1);
    const drag = {
      kind: "channel",
      channelId: 1,
      sourceEl: source,
      containerEl: source.parentElement!,
      channels: [],
      onReorder: () => undefined,
      owner: new AbortController().signal,
    } satisfies ChannelDrag;
    const over = (clientY: number) =>
      findDropTarget(drag, new MouseEvent("mouseup", { clientX: 20, clientY }));
    expect(over(104)).toMatchObject({ channelId: VOICE, before: true });
    expect(over(140)).toMatchObject({ channelId: VOICE, before: false });
  });

  describe("[7] the category menu's Create channel entry", () => {
    const entries = (): string[] =>
      Array.from(document.querySelectorAll('[data-testid^="ctx-category-"]')).map((el) =>
        el.getAttribute("data-testid")!,
      );

    it("is the first management entry for a manager and calls create with no hint on a text category", () => {
      setAdminUser();
      mount(true);
      rightClick(header("Info"));
      const ids = entries();
      expect(ids.indexOf("ctx-category-create-channel")).toBe(
        ids.indexOf("ctx-category-toggle") + 2,
      );
      expect(ids.indexOf("ctx-category-create-channel")).toBeLessThan(
        ids.indexOf("ctx-category-create"),
      );
      (
        document.querySelector('[data-testid="ctx-category-create-channel"]') as HTMLElement
      ).click();
      expect(onCreateChannel).toHaveBeenCalledWith({ id: 4, name: "Info" });
    });

    it("on the synthetic Voice group passes the voice hint", () => {
      setAdminUser();
      mount(true, [channel(1), voiceChannel({ category: null, category_id: 0 })]);
      rightClick(header("Voice"));
      (
        document.querySelector('[data-testid="ctx-category-create-channel"]') as HTMLElement
      ).click();
      expect(onCreateChannel).toHaveBeenCalledWith({ id: 0, name: "" }, "voice");
    });

    it("is absent without MANAGE_CHANNELS", () => {
      signInAs({ id: 2, username: "member", avatar: null, role: "member" });
      mount(true);
      rightClick(header("Info"));
      expect(document.querySelector('[data-testid="category-context-menu"]')).not.toBeNull();
      expect(entries()).not.toContain("ctx-category-create-channel");
    });

    it("leaves the header's + out of the Tab order", () => {
      setAdminUser();
      mount(true);
      expect(header("Info").querySelector(".category-add-btn")?.getAttribute("tabindex")).toBe(
        "-1",
      );
    });
  });

  describe("[8] the voice user menu's Listen entry", () => {
    function seedSharer(): void {
      signInAs({ id: 1, username: "kade", avatar: null, role: "member" });
      membersStore.setState((p) => ({
        ...p,
        members: new Map([
          [1, { id: 1, username: "kade", status: "online" } as never],
          [2, { id: 2, username: "rin", displayName: "Rinny", status: "online" } as never],
        ]),
      }));
      membersStore.flush();
      voiceStore.setState((p) => withMusicSharer({ ...p, currentChannelId: VOICE }, 2, true));
      mount(true);
      addVoiceUser(VOICE, 1, "kade");
      addVoiceUser(VOICE, 2, "rin");
      flush();
    }
    const entry = (): HTMLElement | null =>
      document.querySelector<HTMLElement>('[data-testid="ctx-voice-listen"]');
    const openMenu = async (uid: number): Promise<void> => {
      rightClick(container.querySelector<HTMLElement>(`[data-voice-uid="${uid}"]`)!);
      await vi.waitFor(() => expect(document.querySelector(".user-vol-menu")).not.toBeNull());
    };

    it("reads Listen with the display name and activates listenToMusic with the id", async () => {
      seedSharer();
      await openMenu(2);
      expect(entry()?.textContent).toContain("Listen to Rinny's music");
      entry()!.click();
      expect(listenToMusic).toHaveBeenCalledTimes(1);
      expect(listenToMusic).toHaveBeenCalledWith(2);
    });

    it("reads Stop listening while on and passes null", async () => {
      seedSharer();
      voiceStore.setState((p) => ({ ...p, listeningTo: 2 }));
      flush();
      await openMenu(2);
      expect(entry()?.textContent).toContain("Stop listening to Rinny");
      entry()!.click();
      expect(listenToMusic).toHaveBeenCalledWith(null);
    });

    it("is absent for a user who shares nothing, and the pill is out of the Tab order", async () => {
      seedSharer();
      voiceStore.setState((p) => withMusicSharer(p, 2, false));
      flush();
      await openMenu(2);
      expect(entry()).toBeNull();
      voiceStore.setState((p) => withMusicSharer(p, 2, true));
      flush();
      expect(container.querySelector(".vu-listen")?.getAttribute("tabindex")).toBe("-1");
    });
  });

  it("[2] Enter on a focused voice user opens the profile once", () => {
    mount(true);
    addVoiceUser(VOICE, 2, "rin");
    flush();
    const user = container.querySelector<HTMLElement>(".voice-user-item")!;
    user.focus();
    user.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    expect(mocks.mockOpenUserProfilePopup).toHaveBeenCalledTimes(1);
  });
});

describe("[10] the Direct folder mount", () => {
  function fakeFolder(): {
    section: TreeSection;
    destroy: ReturnType<typeof vi.fn>;
    onRender: ReturnType<typeof vi.fn>;
  } {
    const element = document.createElement("div");
    element.className = "fake-folder";
    element.innerHTML = '<div role="treeitem" data-tree-kind="head" tabindex="-1">Direct</div>';
    const destroy = vi.fn();
    const onRender = vi.fn();
    return { section: { element, destroy, onRender }, destroy, onRender };
  }

  function mountWith(tree: boolean, direct: () => TreeSection): void {
    sidebar?.destroy?.();
    setChannels(SEED);
    sidebar = createChannelSidebar({ tree, direct, onVoiceJoin, onOpenCall });
    sidebar.mount(container);
  }

  it("deck mounts the folder inside the tree after the list, and the first render stamps it", () => {
    const folder = fakeFolder();
    mountWith(true, () => folder.section);
    const tree = container.querySelector(".server-tree")!;
    expect(tree.lastElementChild).toBe(folder.section.element);
    expect(tree.querySelector(".channel-list")!.nextElementSibling).toBe(folder.section.element);
    expect(
      folder.section.element.querySelector("[role=treeitem]")!.getAttribute("aria-level"),
    ).toBe("1");
    // Registered before the first render, which is what stamped it.
    expect(folder.onRender).toHaveBeenCalledTimes(1);
  });

  it("a redraw the folder reports restamps the tree", () => {
    const folder = fakeFolder();
    mountWith(true, () => folder.section);
    const redraw = folder.onRender.mock.calls[0]![0] as () => void;
    const extra = document.createElement("div");
    extra.setAttribute("role", "treeitem");
    extra.dataset["treeKind"] = "head";
    folder.section.element.appendChild(extra);
    redraw();
    expect(extra.getAttribute("aria-level")).toBe("1");
  });

  it("destroying the sidebar destroys the folder once", () => {
    const folder = fakeFolder();
    mountWith(true, () => folder.section);
    sidebar!.destroy?.();
    expect(folder.destroy).toHaveBeenCalledTimes(1);
  });

  it("classic never builds the folder", () => {
    const build = vi.fn(() => fakeFolder().section);
    mountWith(false, build);
    expect(build).not.toHaveBeenCalled();
    expect(container.querySelector(".fake-folder")).toBeNull();
  });
});
