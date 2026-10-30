// How a forum channel enters the rest of the client (WP 6.9d): the channel
// store, the dispatcher, the quick switcher, the "#" autocomplete and the
// header glyph.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wireDispatcher } from "../../src/lib/dispatcher";
import { createMockWsClient } from "../helpers/mock-ws";
import { makePost, seedForum, FORUM, TAGS } from "../helpers/forum-fixtures";
import { createIcon } from "@lib/icons";
import {
  addChannel,
  channelsStore,
  resetChannelsStore,
  setChannels,
  updateChannel,
} from "@stores/channels.store";
import { getThread, resetThreadsStore } from "@stores/threads.store";
import { resetMessagesStore } from "@stores/messages.store";
import { createQuickSwitcher } from "@components/QuickSwitcher";
import {
  filterChannelSuggestions,
  createChannelAutocomplete,
} from "@components/ChannelAutocomplete";
import { buildChatHeader, setChatHeaderChannelType } from "../../src/pages/main-page/ChatHeader";
import {
  applyReadyCapabilities,
  forumsEnabled,
  resetServerCapabilities,
} from "@lib/net/serverCapabilities";
import type { WsClient } from "@lib/ws";

const glyph = (el: Element | null): string => el?.querySelector("svg")?.innerHTML ?? "";
const FORUM_GLYPH = createIcon("messages-square", 14).innerHTML;

beforeEach(() => {
  resetChannelsStore();
  resetThreadsStore();
  resetMessagesStore();
});
afterEach(() => {
  resetServerCapabilities();
  document.body.replaceChildren();
});

describe("forum settings in the channel store", () => {
  it("come with ready, survive a channel_create that omits them, and follow a channel_update", () => {
    seedForum();
    expect(channelsStore.getState().channels.get(FORUM)?.forum?.tags).toEqual(TAGS);
    expect(channelsStore.getState().channels.get(FORUM)?.type).toBe("forum");

    addChannel({ id: FORUM, name: "feedback", type: "forum", category: null, position: 0 });
    expect(channelsStore.getState().channels.get(FORUM)?.forum?.tags).toEqual(TAGS);

    updateChannel({
      id: FORUM,
      forum: { tags: [], require_tag: true, default_auto_archive_minutes: 60 },
    });
    expect(channelsStore.getState().channels.get(FORUM)?.forum).toEqual({
      tags: [],
      require_tag: true,
      default_auto_archive_minutes: 60,
    });
    // An update that does not mention the forum leaves it alone.
    updateChannel({ id: FORUM, name: "ideas" });
    expect(channelsStore.getState().channels.get(FORUM)?.forum?.require_tag).toBe(true);
  });

  it("is absent on a text channel", () => {
    setChannels([{ id: 1, name: "general", type: "text", category: null, position: 0 }]);
    expect(channelsStore.getState().channels.get(1)?.forum).toBeUndefined();
  });

  it("reads the forums capability from ready", () => {
    expect(forumsEnabled()).toBe(false);
    applyReadyCapabilities({ forums: true });
    expect(forumsEnabled()).toBe(true);
  });
});

describe("forum_post_create_ok through the dispatcher", () => {
  it("writes the post's whole state into the threads store, like thread_create_ok", async () => {
    const ws = createMockWsClient();
    const cleanup = wireDispatcher(
      ws as unknown as WsClient,
      { listBlocks: vi.fn(async () => ({ blocked: [] })) } as never,
    );
    ws.simulateMessage("forum_post_create_ok", {
      thread: makePost(31, { tags: [1] }),
      message_id: 310,
      client_message_id: "1:x",
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(getThread(31)?.post?.tag_ids).toEqual([1]);
    cleanup();
  });
});

describe("forum rows elsewhere", () => {
  beforeEach(() => {
    setChannels([
      { id: 1, name: "general", type: "text", category: "Text", position: 0 },
      { id: FORUM, name: "feedback", type: "forum", category: "Text", position: 1 },
    ]);
  });

  it("the quick switcher draws a forum with the forum glyph", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const switcher = createQuickSwitcher({ onSelectChannel: vi.fn(), onClose: vi.fn() });
    switcher.mount(container);
    const icon = (id: number): string =>
      glyph(container.querySelector(`[data-channelid="${id}"] .quick-switcher__icon`));
    expect(icon(FORUM)).toBe(FORUM_GLYPH);
    expect(icon(1)).not.toBe(FORUM_GLYPH);
    switcher.destroy?.();
  });

  it("the # autocomplete flags a forum so its row draws the glyph", () => {
    const flags = filterChannelSuggestions("").map((s) => [s.name, s.forum === true]);
    expect(flags).toEqual([
      ["general", false],
      ["feedback", true],
    ]);
    const ac = createChannelAutocomplete({ onSelect: vi.fn(), onClose: vi.fn() });
    document.body.appendChild(ac.element);
    expect(ac.setQuery("")).toBe(true);
    const row = ac.element.querySelector('[data-testid="channel-option-9"] .ma-name');
    expect(glyph(row)).toBe(FORUM_GLYPH);
    expect(ac.element.querySelector('[data-testid="channel-option-1"] .ma-name')?.textContent).toBe(
      "#general",
    );
    ac.destroy();
  });

  it("the header draws the forum glyph instead of the hash", () => {
    const { refs } = buildChatHeader({ onTogglePins: vi.fn() });
    setChatHeaderChannelType(refs, "forum");
    expect(refs.hashEl.dataset["channelType"]).toBe("forum");
    expect(glyph(refs.hashEl)).toBe(createIcon("messages-square", 18).innerHTML);
    setChatHeaderChannelType(refs, "text");
    expect(refs.hashEl.textContent).toBe("#");
  });
});
