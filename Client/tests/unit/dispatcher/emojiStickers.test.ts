import { describe, it, expect, vi } from "vitest";
import * as dispatcherMocks from "../../helpers/dispatcherMocks";
import { wireDispatcher } from "../../../src/lib/dispatcher";
import { expectConsole } from "../../helpers/console";
import { messagesStore, getChannelMessages, setMessages } from "../../../src/stores/messages.store";
import {
  emojiStore,
  setCustomEmoji,
  listCustomEmoji,
  resolveEmoji,
} from "../../../src/stores/emoji.store";
import { stickersStore, setStickers, listStickers } from "../../../src/stores/stickers.store";
import type { MessageResponse } from "../../../src/lib/types";
import {
  useDispatcherHarness,
  type DispatcherMock,
  readyEvent,
  authOkEvent,
} from "../../helpers/dispatcherHarness";

vi.mock("@lib/notifications", () => dispatcherMocks.notificationsMock());
vi.mock("@lib/voice/livekitSession", () => dispatcherMocks.livekitSessionMock());
vi.mock("@lib/voice/screenShare", () => dispatcherMocks.screenShareMock());
vi.mock("@lib/ui/toast", () => dispatcherMocks.toastMock());
vi.mock("@lib/net/identity", () => dispatcherMocks.identityMock());
vi.mock("../../../src/features/connection/dispatchContext", async (importOriginal) =>
  dispatcherMocks.dispatchContextMock(await importOriginal<object>()),
);

describe("WS Dispatcher", () => {
  let cleanup: () => void;
  let mock: DispatcherMock;

  useDispatcherHarness({
    wired: (m, c) => {
      mock = m;
      cleanup = c;
    },
    currentCleanup: () => cleanup,
  });

  it("wires emoji_update to replace the custom-emoji set", () => {
    setCustomEmoji([
      { id: 1, shortcode: "wave", url: "/api/v1/emoji/1/image" },
      { id: 2, shortcode: "gone", url: "/api/v1/emoji/2/image" },
    ]);
    emojiStore.flush();

    // The deleted emoji must not survive the replace — the whole point of
    // sending the set rather than a delta.
    mock.dispatch("emoji_update", {
      emoji: [
        { id: 1, shortcode: "wave", url: "/api/v1/emoji/1/image" },
        { id: 3, shortcode: "party", url: "/api/v1/emoji/3/image" },
      ],
    });
    emojiStore.flush();

    expect(listCustomEmoji().map((e) => e.shortcode)).toEqual(["wave", "party"]);
    expect(resolveEmoji("gone")).toBeNull();
    expect(resolveEmoji("party")?.id).toBe(3);
  });

  it("treats an emoji_update with no emoji field as an empty set", () => {
    setCustomEmoji([{ id: 1, shortcode: "wave", url: "/api/v1/emoji/1/image" }]);
    emojiStore.flush();

    mock.dispatch("emoji_update", {} as { emoji: [] });
    emojiStore.flush();

    expect(listCustomEmoji()).toEqual([]);
  });

  it("on ready loads the custom-emoji set from the REST list", async () => {
    cleanup();
    const listBlocks = vi.fn().mockResolvedValue({ blocked_user_ids: [] });
    const listEmoji = vi
      .fn()
      .mockResolvedValue([{ id: 4, shortcode: "wave", url: "/api/v1/emoji/4/image" }]);
    cleanup = wireDispatcher(mock.ws, { listBlocks, listEmoji });

    mock.dispatch("ready", readyEvent());

    expect(listEmoji).toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    emojiStore.flush();
    expect(resolveEmoji("wave")?.id).toBe(4);
  });

  it("wires sticker_update to replace the custom-sticker set", () => {
    setStickers([
      { id: 1, name: "Wave", emoji: null, url: "/api/v1/stickers/1/image" },
      { id: 2, name: "Gone", emoji: null, url: "/api/v1/stickers/2/image" },
    ]);
    stickersStore.flush();

    // The deleted sticker must not survive the replace.
    mock.dispatch("sticker_update", {
      stickers: [
        { id: 1, name: "Wave", emoji: "👋", url: "/api/v1/stickers/1/image" },
        { id: 3, name: "Party", emoji: null, url: "/api/v1/stickers/3/image" },
      ],
    });
    stickersStore.flush();

    expect(listStickers().map((x) => x.name)).toEqual(["Wave", "Party"]);
    expect(listStickers()[0]!.emoji).toBe("👋");
  });

  it("sticker_update turns loaded messages of a removed sticker into deleted-sticker rows", () => {
    const msg = (id: number, sid: number): MessageResponse =>
      ({
        id,
        channel_id: 1,
        user: { id: 2, username: "bob", avatar: null },
        content: `[Sticker: S${sid}]`,
        reply_to: null,
        attachments: [],
        reactions: [],
        pinned: false,
        edited_at: null,
        deleted: false,
        timestamp: "2024-01-15T12:00:00Z",
        sticker: { id: sid, name: `S${sid}`, url: `/api/v1/stickers/${sid}/image` },
      }) as MessageResponse;
    setMessages(1, [msg(10, 1), msg(11, 2)], false);
    messagesStore.flush();

    mock.dispatch("sticker_update", {
      stickers: [{ id: 1, name: "S1", emoji: null, url: "/api/v1/stickers/1/image" }],
    });
    messagesStore.flush();

    const stored = getChannelMessages(1);
    expect(stored.find((m) => m.id === 10)?.sticker?.id).toBe(1);
    expect(stored.find((m) => m.id === 11)?.sticker).toEqual({ id: null, name: "S2", url: null });
  });

  it("treats a sticker_update with no stickers field as an empty set", () => {
    setStickers([{ id: 1, name: "Wave", emoji: null, url: "/api/v1/stickers/1/image" }]);
    stickersStore.flush();
    mock.dispatch("sticker_update", {} as never);
    stickersStore.flush();
    expect(listStickers()).toEqual([]);
  });

  it("on ready loads the stickers only when the server advertises the capability", async () => {
    cleanup();
    const listBlocks = vi.fn().mockResolvedValue({ blocked_user_ids: [] });
    const listStickersApi = vi
      .fn()
      .mockResolvedValue([{ id: 4, name: "Wave", emoji: null, url: "/api/v1/stickers/4/image" }]);
    cleanup = wireDispatcher(mock.ws, { listBlocks, listStickers: listStickersApi });

    mock.dispatch("ready", readyEvent());
    expect(listStickersApi).not.toHaveBeenCalled();

    mock.dispatch("ready", readyEvent({ capabilities: { stickers: true } }));
    expect(listStickersApi).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    stickersStore.flush();
    expect(listStickers().map((x) => x.id)).toEqual([4]);
  });

  it("refetches the stickers on a resumed connection, which gets no ready", async () => {
    cleanup();
    const listBlocks = vi.fn().mockResolvedValue({ blocked_user_ids: [] });
    const listStickersApi = vi.fn().mockResolvedValue([]);
    cleanup = wireDispatcher(mock.ws, { listBlocks, listStickers: listStickersApi });
    mock.dispatch("ready", readyEvent({ capabilities: { stickers: true } }));
    listStickersApi.mockClear();

    mock.dispatch("auth_ok", authOkEvent({ replay_source: "buffer" }) as never);
    expect(listStickersApi).toHaveBeenCalledTimes(1);
  });

  it("drops a ready-time sticker list that a fresher sticker_update overtook", async () => {
    cleanup();
    const listBlocks = vi.fn().mockResolvedValue({ blocked_user_ids: [] });
    let resolveList: (v: unknown[]) => void = () => {};
    const listStickersApi = vi.fn(
      () =>
        new Promise<unknown[]>((r) => {
          resolveList = r;
        }),
    );
    cleanup = wireDispatcher(mock.ws, {
      listBlocks,
      listStickers: listStickersApi as never,
    });
    mock.dispatch("ready", readyEvent({ capabilities: { stickers: true } }));
    mock.dispatch("sticker_update", {
      stickers: [{ id: 9, name: "Fresh", emoji: null, url: "/api/v1/stickers/9/image" }],
    });
    stickersStore.flush();
    resolveList([{ id: 1, name: "Stale", emoji: null, url: "/api/v1/stickers/1/image" }]);
    await Promise.resolve();
    await Promise.resolve();
    stickersStore.flush();
    expect(listStickers().map((x) => x.name)).toEqual(["Fresh"]);
  });

  // OC-0251: the ready-time GET /emoji and an `emoji_update` broadcast can
  // race — the GET travels over a separate HTTP connection while the
  // `emoji_update` arrives on the already-open socket, so a fresher
  // `emoji_update` can land and then be clobbered by the slower, stale GET
  // reply. Mirrors the OC-0218 blockedByMeRev guard for listBlocks.
  it("does not let a slow-to-resolve ready-time listEmoji revert a fresher emoji_update", async () => {
    cleanup(); // tear down the no-api dispatcher wired in beforeEach
    const listBlocks = vi.fn().mockResolvedValue({ blocked_user_ids: [] });
    let resolveListEmoji!: (v: { id: number; shortcode: string; url: string }[]) => void;
    const listEmoji = vi.fn(
      () =>
        new Promise<{ id: number; shortcode: string; url: string }[]>((resolve) => {
          resolveListEmoji = resolve;
        }),
    );
    cleanup = wireDispatcher(mock.ws, { listBlocks, listEmoji });

    // Reconnect: ready fires the GET, which does not resolve yet.
    mock.dispatch("ready", readyEvent());
    expect(listEmoji).toHaveBeenCalled();

    // While it's in flight, a fresher emoji_update lands on the socket (e.g.
    // an admin deleted :wave: and uploaded :party:).
    mock.dispatch("emoji_update", {
      emoji: [{ id: 9, shortcode: "party", url: "/api/v1/emoji/9/image" }],
    });
    emojiStore.flush();
    expect(resolveEmoji("party")?.id).toBe(9);

    // The stale GET (issued before the change) now resolves with the
    // pre-change full set — it must not clobber the fresher emoji_update.
    resolveListEmoji([{ id: 4, shortcode: "wave", url: "/api/v1/emoji/4/image" }]);
    await Promise.resolve();
    await Promise.resolve();
    emojiStore.flush();

    expect(resolveEmoji("party")?.id).toBe(9);
    expect(resolveEmoji("wave")).toBeNull();
  });

  it("survives a failed emoji load — shortcodes just stay plain text", async () => {
    cleanup();
    const listBlocks = vi.fn().mockResolvedValue({ blocked_user_ids: [] });
    const listEmoji = vi.fn().mockRejectedValue(new Error("offline"));
    cleanup = wireDispatcher(mock.ws, { listBlocks, listEmoji });

    mock.dispatch("ready", readyEvent());
    await Promise.resolve();
    await Promise.resolve();
    emojiStore.flush();
    expect(listCustomEmoji()).toEqual([]);
    expectConsole("warn", /\[dispatcher\] Failed to load custom emoji/);
  });
});
