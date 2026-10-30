/**
 * Every per-server store registers its reset with the session registry, and
 * clearAuth runs them (ARCH-012). The probe table is the contract. The set of
 * names registered anywhere under src/ is collected from the source text, not
 * from this file's import graph, and must equal the probe names plus the
 * commented EXEMPT list: a registration added in any module fails the
 * completeness test until it gets a probe or an exemption.
 */
import { hasWaved, markWaved } from "@components/message-list/welcomeRows";
import {
  claimForwardRequest,
  isForwardRequest,
} from "../../src/features/messaging/forwardRequests";
import { claimPollRequest, isPollRequest } from "../../src/features/messaging/pollRequests";
import { pollCardState } from "../../src/components/message-list/pollCard";
import { withThreadsStore } from "../../src/stores/threadsLoader";
import { setFocusedThread, threadsStore, upsertThread } from "../../src/stores/threads.store";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
// The attachment cache is probed through its own fetch path: a second fetch of
// the same file is a cache miss, which is how a reset shows.
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: fetchMock }));
vi.mock("@lib/net/httpProxy", () => ({
  ensureHttpProxy: vi.fn().mockResolvedValue("http://127.0.0.1:49812"),
}));
import { listSessionResets, registerSessionReset } from "../../src/lib/net/sessionRegistry";
import { authStore, clearAuth } from "../../src/stores/auth.store";
import { emojiStore, setCustomEmoji } from "../../src/stores/emoji.store";
import { stickersStore, setStickers } from "../../src/stores/stickers.store";
import {
  externalPartition,
  fetchMediaAsObjectUrl,
  setServerHost,
} from "../../src/components/message-list/attachments";
import { renderGenericLinkPreview } from "../../src/components/message-list/embeds";
import { renderInlineImage } from "../../src/components/message-list/media";
import { getImageBox, setImageBox } from "../../src/components/message-list/imageSizes";
import {
  rememberRowHeight,
  rememberedRowHeight,
} from "../../src/components/message-list/rowHeights";
import { discardMedia, observeMedia } from "../../src/lib/prefs/mediaVisibility";
import {
  EXTERNAL_CONSENT_PREF,
  admitDerived,
  externalAllowed,
  setExternalConsentChoice,
} from "../../src/features/content-consent/external";
import { handleMentionCount } from "../../src/features/channels/wsHandlers";
import type { Channel } from "../../src/stores/channels.store";
import { savePref } from "../../src/lib/prefs/preferences";
import { expectConsole } from "../helpers/console";
import { leaveVoiceChannel, voiceStore } from "../../src/stores/voice.store";
import { promptForChannelPassword } from "../../src/features/voice/passwordPrompt";
import { messagesStore } from "../../src/stores/messages.store";
import { channelsStore } from "../../src/stores/channels.store";
import { blocksStore, setUserBlockedByMe } from "../../src/stores/blocks.store";
import {
  collapseCategories,
  loadCollapsedCategories,
  setActiveDmUser,
  setConnectionStatus,
  setSidebarMode,
  uiStore,
} from "../../src/stores/ui.store";
import { membersStore, setMembers, setTyping } from "../../src/stores/members.store";
import { hasMemberModelMemo, memberModelFor } from "../../src/components/MemberList";
import { dmStore, setDmChannels } from "../../src/stores/dm.store";
import type { DmChannel } from "../../src/stores/dm.store";
import { safetyStore, setReadyNotices } from "../../src/features/safety/store";
import { memberTimeoutsStore, setMemberTimeouts } from "../../src/features/moderation/store";
// Loaded for its registrations: the two notification resets.
import "../../src/lib/notifications";
import {
  getCachedReactionUsers,
  loadReactionUsers,
  setReactionUsersFetcher,
} from "../../src/features/messaging/reactionUsers";
import { buildBlockedUsersSection } from "../../src/features/safety/BlockedUsers";
import { createAvatarElement } from "../../src/components/message-list/avatar";
import { isVoiceMovePending, noteVoiceMoved } from "../../src/features/voice/moveHint";
import { noteWatchSent, takeWatchRefusal } from "../../src/lib/voice/watchRequest";
import { getChannelMutesHost, setChannelMutesHost } from "../../src/lib/prefs/channelMutes";
import {
  bindGifFavoritesApi,
  gifFavoritesAvailable,
  gifFavoritesStore,
} from "../../src/stores/gifFavorites.store";
import {
  applyFrame,
  applySnapshot,
  beginSnapshot,
  messageRequestsStore,
} from "../../src/features/message-requests/store";
import type { MessageRequest } from "../../src/features/message-requests/api";
import { loadRequests, requestsApi } from "../../src/features/message-requests/sync";
import type { DispatchApi } from "../../src/features/connection/dispatchContext";
import type { GifFavoritesApi } from "../../src/lib/media/gifProvider";
import type { ReadyMember } from "../../src/lib/types";

interface Probe {
  /** The registry name this probe covers. */
  readonly name: string;
  mutate(): void | Promise<void>;
  isInitial(): boolean | Promise<boolean>;
}

const member = {
  id: 7,
  username: "alex",
  avatar: null,
  role: "member",
  status: "online",
} as unknown as ReadyMember;

const dm = {
  channelId: 9,
  recipient: { id: 7, username: "alex", avatar: "", status: "online" },
  participants: [],
  name: "",
  isGroup: false,
  lastMessageId: null,
  lastMessage: "hi",
  lastMessageAt: "",
  unreadCount: 3,
  mentionCount: 1,
} as DmChannel;

let roleRevBefore = 0;
let snapshotRevBefore = 0;
const COLLAPSED_KEY = "owncord:collapsed:a.example";

let emojiRevBefore = 0;
let stickerRevBefore = 0;
let partitionBefore = "";
const FILE_URL = "https://chat.example/api/v1/files/1";
const LINK_URL = "https://news.example/story";
const IMAGE_URL = "https://cdn.example/cat.png";

/** Let a fetch and the `.then` chains hanging off it settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** An element's `offsetWidth` and `offsetHeight` are 0 in jsdom; the image-size cache needs a size. */
function withOffsetSize<T>(width: number, height: number, run: () => T): T {
  const proto = HTMLElement.prototype;
  const saved = {
    offsetWidth: Object.getOwnPropertyDescriptor(proto, "offsetWidth"),
    offsetHeight: Object.getOwnPropertyDescriptor(proto, "offsetHeight"),
  };
  Object.defineProperty(proto, "offsetWidth", { configurable: true, get: () => width });
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get: () => height });
  try {
    return run();
  } finally {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor !== undefined) Object.defineProperty(proto, name, descriptor);
      else delete (proto as unknown as Record<string, unknown>)[name];
    }
  }
}

const messageRequest: MessageRequest = {
  id: 4,
  channelId: 31,
  sender: { id: 8, username: "sam", displayName: "" },
  preview: null,
  createdAt: "2026-01-01T00:00:00Z",
};

const blockedUsersApi = {
  listBlocks: () => new Promise<{ blocked_user_ids: number[] }>(() => {}),
  unblockUser: () => new Promise<void>(() => {}),
};
let blockedUsersTab = new AbortController();
/** A fresh Blocked users section's Unblock button for user 5, as drawn now. */
function unblockButtonFor5(): HTMLButtonElement | null {
  const section = buildBlockedUsersSection(
    blockedUsersTab.signal,
    blockedUsersApi,
    createAvatarElement,
  );
  return section.querySelector<HTMLButtonElement>("[data-testid='blocked-user-unblock']");
}

const mentionChannel: Channel = {
  id: 77,
  name: "general",
  type: "text",
  category: null,
  position: 0,
  unreadCount: 0,
  mentionCount: 0,
  lastMessageId: null,
  canSend: true,
  topic: "",
  slowMode: 0,
  nsfw: false,
  isPrivate: false,
  voiceMaxUsers: 0,
  voiceMaxVideo: 0,
};

let threadsJobRan = false;

const PROBES: readonly Probe[] = [
  {
    name: "welcomeRows:waved",
    mutate: () => markWaved(77),
    isInitial: () => !hasWaved(77),
  },
  {
    name: "voice:store",
    mutate: () => voiceStore.setState((s) => ({ ...s, currentChannelId: 3, voiceStatus: "idle" })),
    isInitial: () => voiceStore.getState().currentChannelId === null,
  },
  {
    name: "messages:store",
    mutate: () => messagesStore.setState((s) => ({ ...s, detachedChannels: new Set([42]) })),
    isInitial: () => messagesStore.getState().detachedChannels.size === 0,
  },
  {
    name: "channels:store",
    mutate: () => channelsStore.setState((s) => ({ ...s, activeChannelId: 42 })),
    isInitial: () => channelsStore.getState().activeChannelId === null,
  },
  {
    name: "blocks:store",
    mutate: () => setUserBlockedByMe(5, true),
    isInitial: () => blocksStore.getState().blockedByMe.size === 0,
  },
  {
    name: "ui:session",
    mutate: () => {
      localStorage.removeItem(COLLAPSED_KEY);
      loadCollapsedCategories("a.example");
      collapseCategories(["Text"]);
      setSidebarMode("dms");
      setActiveDmUser(7);
    },
    isInitial: () => {
      const cleared =
        uiStore.getState().collapsedCategories.size === 0 &&
        uiStore.getState().sidebarMode === "channels" &&
        uiStore.getState().activeDmUserId === null;
      // The persistence host must be nulled too: a collapse after the reset
      // writes no key for the old server. (Side effect, run after the reads.)
      localStorage.removeItem(COLLAPSED_KEY);
      collapseCategories(["Probe"]);
      const hostNulled = localStorage.getItem(COLLAPSED_KEY) === null;
      localStorage.removeItem(COLLAPSED_KEY);
      return cleared && hostNulled;
    },
  },
  {
    // The roster, and the typing timers it owns (asserted by timer count).
    name: "members:store",
    mutate: () => {
      roleRevBefore = membersStore.getState().roleRevision ?? 0;
      snapshotRevBefore = membersStore.getState().snapshotRevision ?? 0;
      setMembers([member]);
      setTyping(1, 7);
    },
    isInitial: () =>
      membersStore.getState().members.size === 0 &&
      membersStore.getState().typingUsers.size === 0 &&
      vi.getTimerCount() === 0 &&
      (membersStore.getState().roleRevision ?? 0) > roleRevBefore &&
      (membersStore.getState().snapshotRevision ?? 0) > snapshotRevBefore,
  },
  {
    // The virtual member list's reopen memo holds the roster's model.
    name: "members:model-memo",
    mutate: () => {
      memberModelFor(new Map([[7, { ...member, id: 7 } as never]]), []);
      expect(hasMemberModelMemo()).toBe(true);
    },
    isInitial: () => !hasMemberModelMemo(),
  },
  {
    name: "dm:store",
    mutate: () => setDmChannels([dm]),
    isInitial: () => dmStore.getState().channels.length === 0,
  },
  {
    // Bumped, not reset to INITIAL (OC-0362): a late GET /emoji from the old
    // session must not match the next session's snapshot.
    name: "emoji:store",
    mutate: () => {
      emojiRevBefore = emojiStore.getState().rev ?? 0;
      setCustomEmoji([{ id: 1, shortcode: "wave", url: "/api/v1/emoji/1/image" }]);
    },
    isInitial: () =>
      emojiStore.getState().emoji.length === 0 && (emojiStore.getState().rev ?? 0) > emojiRevBefore,
  },
  {
    // Bumped, not reset (like emoji): a late GET /stickers from the old server
    // must not match the next session's snapshot.
    name: "stickers:store",
    mutate: () => {
      stickerRevBefore = stickersStore.getState().rev;
      setStickers([{ id: 1, name: "Wave", emoji: null, url: "/api/v1/stickers/1/image" }]);
    },
    isInitial: () =>
      stickersStore.getState().stickers.length === 0 &&
      !stickersStore.getState().loaded &&
      stickersStore.getState().rev > stickerRevBefore,
  },
  {
    name: "attachments:caches",
    mutate: async () => {
      setServerHost("chat.example");
      URL.createObjectURL = vi.fn(() => "blob:test/1");
      URL.revokeObjectURL = vi.fn();
      fetchMock.mockReset().mockResolvedValue({
        ok: true,
        headers: { get: () => "video/mp4" },
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
      });
      await fetchMediaAsObjectUrl(FILE_URL);
      await fetchMediaAsObjectUrl(FILE_URL);
      expect(fetchMock).toHaveBeenCalledTimes(1); // cached: the probe can fail
    },
    isInitial: async () => {
      await fetchMediaAsObjectUrl(FILE_URL);
      return fetchMock.mock.calls.length === 2; // refetched, so the cache was dropped
    },
  },
  {
    // Before the cache probes: its pref write fires owncord:pref-change, which
    // clears the embed, media and external-image caches on its own.
    name: "consent:admitted-items",
    mutate: () => {
      setExternalConsentChoice("auto");
      admitDerived("parent", "admitted-child");
      // Back to "no choice yet", so only the one-by-one admission could allow it.
      savePref(EXTERNAL_CONSENT_PREF, {});
      expect(externalAllowed("admitted-child")).toBe(true);
    },
    isInitial: () => !externalAllowed("admitted-child"),
  },
  {
    name: "attachments:external-images",
    mutate: () => {
      partitionBefore = externalPartition();
    },
    // The broker partition is renamed so its cache is dropped with the session.
    isInitial: () => externalPartition() !== partitionBefore,
  },
  {
    name: "embeds:caches",
    mutate: async () => {
      // No consent for the link: the preview settles at once as a cached refusal.
      renderGenericLinkPreview(LINK_URL);
      await flush();
      expect(renderGenericLinkPreview(LINK_URL).dataset.embedState).not.toBe("loading");
    },
    isInitial: () => renderGenericLinkPreview(LINK_URL).dataset.embedState === "loading",
  },
  {
    name: "media:caches",
    mutate: () => {
      withOffsetSize(400, 333, () => {
        const wrap = renderInlineImage(IMAGE_URL);
        wrap.querySelector("img")!.dispatchEvent(new Event("load"));
      });
      expect(renderInlineImage(IMAGE_URL).style.aspectRatio).toBe("400 / 333");
    },
    isInitial: () => renderInlineImage(IMAGE_URL).style.minHeight === "200px",
  },
  {
    // The persisted per-URL image boxes go with the session too.
    name: "message-list:image-sizes",
    mutate: () => {
      setImageBox("https://cdn.example/box-probe.png", { w: 40, h: 30 });
      expect(getImageBox("https://cdn.example/box-probe.png")).toEqual({ w: 40, h: 30 });
    },
    isInitial: () => getImageBox("https://cdn.example/box-probe.png") === undefined,
  },
  {
    // Row heights measured on one server never seed the next one's lists.
    name: "message-list:row-heights",
    mutate: () => {
      rememberRowHeight("row-probe", 800, 140);
      expect(rememberedRowHeight("row-probe", 800)).toBe(140);
    },
    isInitial: () => rememberedRowHeight("row-probe", 800) === undefined,
  },
  {
    // A cached GIF still shows as an instant swap for the next row of that GIF.
    name: "media-visibility:stills",
    mutate: () => {
      URL.createObjectURL = vi.fn(() => "blob:probe-still");
      URL.revokeObjectURL = vi.fn();
      const restores = [
        vi
          .spyOn(HTMLCanvasElement.prototype, "getContext")
          .mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D),
        vi
          .spyOn(HTMLCanvasElement.prototype, "toBlob")
          .mockImplementation((cb) => cb(new Blob(["x"], { type: "image/png" }))),
      ];
      const img = document.createElement("img");
      img.src = STILL_GIF_URL;
      observeMedia(img, STILL_GIF_URL, document.createElement("div"), true);
      vi.advanceTimersByTime(1);
      expect(img.src).toBe("blob:probe-still");
      for (const restore of restores) restore.mockRestore();
    },
    isInitial: () => {
      const img = document.createElement("img");
      img.src = STILL_GIF_URL;
      observeMedia(img, STILL_GIF_URL, document.createElement("div"), true);
      const cached = img.src !== STILL_GIF_URL;
      discardMedia(img);
      return !cached;
    },
  },
  {
    // A mention alert is a pending timer keyed by this server's channel id.
    name: "channels:activity",
    mutate: () => {
      channelsStore.setState((s) => ({
        ...s,
        channels: new Map([[77, mentionChannel]]),
        activeChannelId: null,
      }));
      handleMentionCount({ channel_id: 77, count: 1 });
      expect(vi.getTimerCount()).toBeGreaterThan(0);
    },
    isInitial: () => vi.getTimerCount() === 0,
  },
  {
    name: "reactions:users",
    mutate: async () => {
      setReactionUsersFetcher(() => Promise.resolve([{ id: 7, username: "alex", avatar: "" }]));
      await loadReactionUsers(1, 2, "wave");
      expect(getCachedReactionUsers(2, "wave")).toBeDefined(); // cached: the probe can fail
      setReactionUsersFetcher(null);
    },
    isInitial: () => getCachedReactionUsers(2, "wave") === undefined,
  },
  {
    // The pending set is private; a row drawn from a fresh section shows it as busy.
    name: "blocked-users:pending",
    mutate: () => {
      blockedUsersTab = new AbortController();
      setUserBlockedByMe(5, true);
      unblockButtonFor5()!.click();
      expect(unblockButtonFor5()!.getAttribute("aria-busy")).toBe("true"); // busy: the probe can fail
    },
    isInitial: () => {
      setUserBlockedByMe(5, true);
      const busy = unblockButtonFor5()!.getAttribute("aria-busy") === "true";
      blockedUsersTab.abort();
      return !busy;
    },
  },
  {
    name: "voice:move-hint",
    mutate: () => {
      noteVoiceMoved(5);
      expect(isVoiceMovePending()).toBe(true);
    },
    isInitial: () => !isVoiceMovePending(),
  },
  {
    name: "voice:watch-request",
    mutate: () => {
      noteWatchSent("env-1");
    },
    // takeWatchRefusal consumes a pending id, so a live one reads as not initial.
    isInitial: () => !takeWatchRefusal("env-1"),
  },
  {
    name: "voice:passwordPrompt",
    mutate: async () => {
      const priorStatus = uiStore.getState().connectionStatus;
      // The prompt needs a live socket, a known channel and no call in progress to open.
      setConnectionStatus("connected");
      leaveVoiceChannel();
      channelsStore.setState((s) => ({
        ...s,
        channels: new Map([[5, { id: 5, name: "vault", type: "voice" } as Channel]]),
      }));
      promptForChannelPassword({ send: vi.fn(), disconnect: vi.fn() }, 5, null);
      await vi.waitFor(() => expect(passwordDialog()).not.toBeNull());
      setConnectionStatus(priorStatus);
    },
    isInitial: () => passwordDialog() === null,
  },
  {
    name: "channel-mutes:host",
    mutate: () => {
      setChannelMutesHost("a.example");
      expect(getChannelMutesHost()).toBe("a.example");
    },
    isInitial: () => getChannelMutesHost() === null,
  },
  {
    name: "gif:favorites",
    mutate: async () => {
      const api = {
        gifFavorites: () =>
          Promise.resolve({
            favorites: [{ url: "https://g.example/1.gif", preview_url: "", title: "" }],
          }),
      } as unknown as GifFavoritesApi;
      bindGifFavoritesApi(api);
      await flush();
      expect(gifFavoritesStore.getState().favorites).toHaveLength(1);
      expect(gifFavoritesAvailable()).toBe(true);
    },
    isInitial: () =>
      gifFavoritesStore.getState().favorites.length === 0 && !gifFavoritesAvailable(),
  },
  {
    // Before message-requests:store: loading a snapshot also moves that store.
    name: "message-requests:source",
    mutate: async () => {
      await loadRequests({
        listDmRequests: () => Promise.resolve({ requests: [] }),
      } as unknown as DispatchApi);
      expect(requestsApi()).toBeDefined();
    },
    isInitial: () => requestsApi() === undefined,
  },
  {
    name: "message-requests:store",
    mutate: () => {
      applySnapshot([], beginSnapshot());
      applyFrame(messageRequest, true);
      expect(messageRequestsStore.getState().status).toBe("ready");
    },
    isInitial: () =>
      messageRequestsStore.getState().pending.length === 0 &&
      messageRequestsStore.getState().status === "loading",
  },
  {
    name: "safety:store",
    mutate: () =>
      setReadyNotices([
        { id: 1, kind: "warning", reason: "r", created_at: "2026-01-01T00:00:00Z" },
      ]),
    isInitial: () => safetyStore.getState().notices.length === 0,
  },
  {
    name: "moderation:timeouts",
    mutate: () => setMemberTimeouts([{ user_id: 7, expires_at: "2099-01-01T00:00:00Z" }]),
    isInitial: () => memberTimeoutsStore.getState() === null,
  },
  {
    name: "messaging:forwardRequests",
    mutate: () => claimForwardRequest("fwd-probe"),
    isInitial: () => !isForwardRequest("fwd-probe"),
  },
  {
    name: "messaging:pollRequests",
    mutate: () => claimPollRequest("poll-probe"),
    isInitial: () => !isPollRequest("poll-probe"),
  },
  {
    name: "messages:pollCards",
    mutate: () => {
      pollCardState(901).selected = [2];
    },
    isInitial: () => pollCardState(901).selected.length === 0,
  },
  {
    name: "threads:loader",
    // A job queued while the store chunk is still loading must not outlive the session.
    mutate: () => {
      threadsJobRan = false;
      withThreadsStore(() => {
        threadsJobRan = true;
      });
    },
    isInitial: async () => {
      await vi.dynamicImportSettled();
      return !threadsJobRan;
    },
  },
  {
    name: "threads:store",
    mutate: () => {
      upsertThread({
        id: 9,
        parent_id: 1,
        name: "probe",
        owner_id: 1,
        starter_message_id: 5,
        archived: false,
        locked: false,
        auto_archive_minutes: 1440,
        message_count: 0,
        last_message_at: null,
        created_at: "2026-10-21T00:00:00Z",
      });
      setFocusedThread(9);
    },
    isInitial: () =>
      threadsStore.getState().byId.size === 0 && threadsStore.getState().focusedThreadId === null,
  },
];

/**
 * Registered names that cannot be probed in this file, each with the reason.
 * Adding to this list is a review decision: say where the behaviour is tested.
 */
const EXEMPT: readonly string[] = [
  // Probing it means rendering a row, whose fetch would disturb the shared
  // fetch mock the attachments:caches probe counts. clearAttachmentCaches
  // (probed above) calls the same reset, and attachments-text-preview.test.ts
  // pins that a reset drops the cache and an in-flight result.
  "attachments:text-preview",
  // main.ts is not loaded here; session-isolation.test.ts drives it and pins
  // that it runs before the domain resets.
  "main:pending-and-api",
  // Module state with no readable store (an audio context, a coalescing map);
  // the notification tests cover what each does.
  "notifications:audio",
  "notifications:coalescing",
  // Its reset is not observable: a kept DM needs the live voice session on that
  // channel, and the voice reset that follows prunes the set anyway.
  "dm:kept-calls",
  // Playing <audio> elements, not store state; features/voice-messages/player.test.ts
  // ("pauses every playing clip when the session ends") runs the reset.
  "voice-messages:player",
  // A DOM sheet, not store state, and mounting one here starts unrelated
  // body-observer timers the timer-count probes read; bottomSheet.test.ts
  // ("closes from closeBottomSheet and from a session reset") runs the reset.
  "bottomSheet:open",
  // Per-subscriber names built from a counter in auth.store (onAuthCleared);
  // page-scoped callers only, each removes its own entry with its disposer.
  "auth-cleared#${authClearedSeq}",
];

/** Every `registerSessionReset("<name>"` literal under src/, by source text. */
function registeredNamesInSource(): Set<string> {
  const names = new Set<string>();
  // Stryker's instrumenter wraps the name literal in its mutant switch:
  // registerSessionReset(stryMutAct_x("1") ? "" : (stryCov_x("1"), "name"), ...).
  const re =
    /registerSessionReset\(\s*(?:stryMutAct_\w+\("\d+"\)\s*\?\s*(?:""|``)\s*:\s*\(stryCov_\w+\("\d+"\),\s*)?[`'"]([^`'"]+)[`'"]/g;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts")) {
        for (const m of readFileSync(path, "utf8").matchAll(re)) names.add(m[1]!);
      }
    }
  };
  walk(join(__dirname, "../../src"));
  return names;
}

beforeEach(() => {
  vi.useFakeTimers();
});

const passwordDialog = (): Element | null =>
  document.querySelector("[data-testid='channel-password-dialog']");

const STILL_GIF_URL = "https://gifs.example/probe.gif";
const { createObjectURL, revokeObjectURL } = URL;

afterEach(() => {
  vi.useRealTimers();
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
});

describe("session reset completeness", () => {
  it("server_switch resets every per-server store and cache to its initial state", async () => {
    for (const probe of PROBES) await probe.mutate();

    clearAuth("server_switch");

    const stale: string[] = [];
    for (const probe of PROBES) if (!(await probe.isInitial())) stale.push(probe.name);
    // The media probe renders its image without consent: each render logs the
    // refusal (mutate renders twice, the check once).
    for (let i = 0; i < 3; i++) expectConsole("error", /Image failed to load/);
    expect(stale).toEqual([]);
    expect(authStore.getState().logoutReason).toBe("server_switch");
  });

  it("every registration in src/ has a probe or an exemption, and every probe is live", () => {
    const inSource = registeredNamesInSource();
    const accounted = new Set([...PROBES.map((p) => p.name), ...EXEMPT]);
    expect([...inSource].filter((n) => !accounted.has(n)).sort()).toEqual([]);
    expect([...accounted].filter((n) => !inSource.has(n)).sort()).toEqual([]);
    // A probe whose registration never ran would pass the reset check vacuously.
    const live = listSessionResets();
    expect(PROBES.map((p) => p.name).filter((n) => !live.includes(n))).toEqual([]);
  });

  it("runs the phases in order whatever the registration order", () => {
    const calls: string[] = [];
    const disposers = (["cache", "domain", "voice", "session"] as const).map((phase) =>
      registerSessionReset(`test:order-${phase}`, () => calls.push(phase), { phase }),
    );
    try {
      clearAuth("user");
    } finally {
      for (const dispose of disposers) dispose();
    }
    expect(calls).toEqual(["session", "voice", "domain", "cache"]);
  });

  it("takes the voice snapshot before the first session entry runs", () => {
    voiceStore.setState((s) => ({ ...s, currentChannelId: 3, voiceStatus: "idle" }));
    // A session entry that wipes voice state must not change what the
    // snapshot reported.
    const dispose = registerSessionReset(
      "test:session-wipes-voice",
      () => voiceStore.setState((s) => ({ ...s, currentChannelId: null })),
      { phase: "session" },
    );
    try {
      clearAuth("user");
    } finally {
      dispose();
    }
    expect(authStore.getState().logoutWasInVoice).toBe(true);
  });
});
