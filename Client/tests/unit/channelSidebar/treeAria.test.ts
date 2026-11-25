/**
 * The tree's ARIA model: every row is its own treeitem and `treeKeys` stamps
 * level, set size and position from DOM order. The views write none of them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mocks from "../../helpers/channelSidebarMocks";
import { createChannelSidebar } from "../../../src/features/channels/ChannelSidebar";
import {
  drawCategoryGroup,
  drawTextChannelRow,
  drawThreadMoreRow,
  drawThreadRow,
} from "../../../src/features/channels/channelRow.view";
import { drawVoiceChannelChrome } from "../../../src/features/channels/voiceRow.view";
import { drawVoiceUserRow } from "../../../src/features/channels/voiceUserRow.view";
import { createAvatarElement } from "../../../src/features/profiles/avatar";
import { enableTreeNavigation } from "../../../src/lib/ui/treeKeys";
import { channelsStore, setChannels } from "../../../src/stores/channels.store";
import { voiceStore } from "../../../src/stores/voice.store";
import { publishFollowedThreads } from "../../../src/stores/followedThreads.store";
import type { ReadyChannel } from "../../../src/lib/types";
import { addVoiceUser, resetStores } from "../../helpers/channelSidebarHarness";

vi.mock("../../../src/features/voice/livekitSession", () => mocks.voiceLivekitSessionMock());
vi.mock("@lib/ui/toast", () => mocks.uiToastMock());
vi.mock("@lib/net/e2eeCrypto", (importOriginal) => mocks.netE2eeCryptoMock(importOriginal));
vi.mock("../../../src/features/messaging/content/attachments", (importOriginal) =>
  mocks.listAttachmentsMock(importOriginal),
);
vi.mock("../../../src/features/profiles/openUserProfilePopup", () =>
  mocks.profilesOpenUserProfilePopupMock(),
);

const ch = (id: number, extra: Partial<ReadyChannel> = {}): ReadyChannel => ({
  id,
  name: `chan-${id}`,
  type: "text",
  category: "Chat",
  category_id: 4,
  position: id,
  ...extra,
});

let container: HTMLDivElement;
let sidebar: ReturnType<typeof createChannelSidebar>;

const flush = (): void => {
  channelsStore.flush();
  voiceStore.flush();
};

/** `[testid, level, posinset, setsize]` for every tree item, in DOM order. */
const stamps = (): [string, string, string, string][] =>
  Array.from(container.querySelectorAll<HTMLElement>("[role=treeitem]")).map((el) => [
    el.getAttribute("data-testid") ?? el.dataset.voiceUid ?? el.dataset.category ?? "?",
    el.getAttribute("aria-level")!,
    el.getAttribute("aria-posinset")!,
    el.getAttribute("aria-setsize")!,
  ]);

beforeEach(() => {
  localStorage.clear();
  resetStores();
  publishFollowedThreads({ byParent: new Map(), focusedId: null });
  container = document.createElement("div");
  document.body.appendChild(container);
  sidebar = createChannelSidebar({ tree: true, onVoiceJoin: vi.fn(), onOpenCall: vi.fn() });
});

afterEach(() => {
  sidebar.destroy?.();
  container.remove();
});

describe("tree levels and sets", () => {
  it("stamps a categorized channel at level 2 under a level-1 header", () => {
    setChannels([ch(1), ch(2)]);
    sidebar.mount(container);
    expect(stamps()).toEqual([
      ["Chat", "1", "1", "1"],
      ["channel-1", "2", "1", "2"],
      ["channel-2", "2", "2", "2"],
    ]);
  });

  it("stamps an uncategorized channel at level 1, in the set with the headers", () => {
    setChannels([ch(1, { category: null, category_id: 0 }), ch(2)]);
    sidebar.mount(container);
    const byId = Object.fromEntries(stamps().map(([id, ...rest]) => [id, rest]));
    expect(byId["channel-1"]).toEqual(["1", expect.any(String), "2"]);
    expect(byId["channel-2"]).toEqual(["2", "1", "1"]);
  });

  it("stamps a followed thread one level under its channel", () => {
    setChannels([ch(1), ch(2)]);
    sidebar.mount(container);
    publishFollowedThreads({
      byParent: new Map([
        [1, [{ id: 50, parentId: 1, name: "notes", unread: 0, mentions: 0, activityAt: 1 }]],
      ]),
      focusedId: null,
    });
    flush();
    const thread = stamps().find(([id]) => id === "thread-row-50");
    expect(thread).toEqual(["thread-row-50", "3", "1", "1"]);
  });

  it("stamps voice users one level under their voice channel", () => {
    setChannels([ch(1, { type: "voice" })]);
    sidebar.mount(container);
    addVoiceUser(1, 8, "rin");
    addVoiceUser(1, 9, "sam");
    flush();
    const users = stamps().filter(([id]) => id === "8" || id === "9");
    expect(users).toEqual([
      ["8", "3", "1", "2"],
      ["9", "3", "2", "2"],
    ]);
  });

  it("counts a voice channel in the same set as the text channels of its category", () => {
    // The store sorts text channels before voice ones inside a group.
    setChannels([ch(1), ch(2, { type: "voice", name: "lounge" }), ch(3)]);
    sidebar.mount(container);
    const ids = stamps().map(([id, , pos, size]) => `${id}:${pos}/${size}`);
    expect(ids).toEqual(["Chat:1/1", "channel-1:1/3", "channel-3:2/3", "channel-2:3/3"]);
  });

  it("counts three rows of one group as 1, 2 and 3 of 3, whatever their kind", () => {
    const tree = document.createElement("div");
    const group = drawCategoryGroup(
      {
        key: "k",
        name: "Chat",
        categoryId: 4,
        label: "Chat",
        collapsed: false,
        showCreate: false,
        draggable: false,
      },
      true,
    );
    const kinds = ["row", "row", "row"] as const;
    const rows = kinds.map((kind, i) => {
      const el = document.createElement("div");
      el.setAttribute("role", "treeitem");
      el.dataset.treeKind = kind;
      el.dataset.testid = String(i + 1);
      return el;
    });
    group.querySelector(".category-channels-container")!.append(...rows);
    tree.append(group);
    document.body.append(tree);
    const life = new AbortController();
    enableTreeNavigation(tree, life.signal).refresh();
    life.abort();
    tree.remove();
    expect(
      rows.map((r) => `${r.getAttribute("aria-posinset")}/${r.getAttribute("aria-setsize")}`),
    ).toEqual(["1/3", "2/3", "3/3"]);
  });

  it("restamps after a row joins, and leaves no stale position behind", () => {
    setChannels([ch(1), ch(3)]);
    sidebar.mount(container);
    setChannels([ch(1), ch(2), ch(3)]);
    flush();
    expect(stamps().map(([id, , pos, size]) => `${id}:${pos}/${size}`)).toEqual([
      "Chat:1/1",
      "channel-1:1/3",
      "channel-2:2/3",
      "channel-3:3/3",
    ]);
  });
});

describe("the views write no level attribute", () => {
  const LEVEL_ATTRS = ["aria-level", "aria-setsize", "aria-posinset"];

  it("draws no level, set size or position, and no aria-expanded outside headers", () => {
    const text = drawTextChannelRow(
      {
        kind: "text",
        channelId: 1,
        name: "a",
        nsfw: false,
        private: false,
        active: false,
        unread: false,
        mentionCount: 0,
        muted: false,
        draggable: false,
        orderIds: "",
        access: { manageChannels: false, manageMessages: false, manageInvites: false },
      },
      true,
    );
    const thread = drawThreadRow(
      {
        kind: "thread",
        threadId: 2,
        parentId: 1,
        name: "t",
        active: false,
        unread: false,
        mentionCount: 0,
        muted: false,
      },
      true,
    );
    const more = drawThreadMoreRow({ kind: "threadMore", parentId: 1, count: 3 }, true);
    const group = drawCategoryGroup(
      {
        key: "k",
        name: "Chat",
        categoryId: 4,
        label: "Chat",
        collapsed: false,
        showCreate: true,
        draggable: false,
      },
      true,
    );
    const voice = drawVoiceChannelChrome(
      {
        channelId: 3,
        name: "v",
        nsfw: false,
        private: false,
        passwordProtected: false,
        afk: false,
        joined: false,
        frozenReason: null,
        timeoutReason: null,
        capacity: null,
        mentionCount: 0,
      },
      true,
    );
    const user = drawVoiceUserRow(
      {
        userId: 5,
        name: "rin",
        avatarName: "rin",
        avatarColor: "#fff",
        avatarUrl: null,
        speaking: false,
        camera: false,
        live: false,
        audio: null,
        localMuted: false,
        ownFingerprintTitle: null,
        verify: null,
        draggable: false,
        self: true,
      },
      createAvatarElement,
      true,
    );
    for (const el of [text, thread, more, group, voice, user]) {
      for (const node of [el, ...el.querySelectorAll("*")]) {
        for (const attr of LEVEL_ATTRS) expect(node.hasAttribute(attr), attr).toBe(false);
      }
    }
    for (const el of [text, thread, more, voice, user]) {
      for (const node of [el, ...el.querySelectorAll("[role=treeitem]")]) {
        expect(node.hasAttribute("aria-expanded")).toBe(false);
      }
    }
    expect(group.querySelector(".category")?.getAttribute("aria-expanded")).toBe("true");
  });
});
