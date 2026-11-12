import { describe, it, expect, beforeEach } from "vitest";
import {
  channelsStore,
  addChannel,
  updateChannel,
  readyChannelMap,
  type Channel,
} from "../../src/stores/channels.store";
import type { ReadyChannel, ChannelCreatePayload } from "../../src/lib/types";
import { makeChannel } from "../helpers/channelFactory";
import { resetChannelsState } from "../helpers/storeSeeds";

const seed = (...channels: Channel[]): void => {
  channelsStore.setState((prev) => ({
    ...prev,
    channels: new Map(channels.map((c) => [c.id, c])),
  }));
};

const row = (id: number): Channel => channelsStore.getState().channels.get(id)!;

const created = (overrides: Partial<ChannelCreatePayload> = {}): ChannelCreatePayload => ({
  id: 7,
  name: "lounge",
  type: "text",
  category: null,
  position: 3,
  ...overrides,
});

beforeEach(resetChannelsState);

describe("readyChannelMap", () => {
  it("maps every optional field with its older-server default", () => {
    const ready: ReadyChannel = { id: 1, name: "a", type: "text", category: null, position: 2 };

    const map = readyChannelMap([ready]);

    expect(map.get(1)).toEqual({
      id: 1,
      name: "a",
      type: "text",
      category: null,
      categoryId: 0,
      categoryPosition: 0,
      topic: "",
      position: 2,
      unreadCount: 0,
      mentionCount: 0,
      lastMessageId: null,
      lastReadMessageId: undefined,
      canSend: true,
      canModerateVoice: undefined,
      canMoveVoice: undefined,
      canDeleteOthers: undefined,
      canPin: undefined,
      canReact: undefined,
      slowMode: 0,
      nsfw: false,
      isPrivate: false,
      nsfwAcknowledged: false,
      voiceMaxUsers: 0,
      voiceMaxVideo: 0,
      passwordProtected: undefined,
      afk: false,
      forum: undefined,
    });
  });

  it("carries the server's values and honours the acknowledgement only on a labelled channel", () => {
    const ready: ReadyChannel = {
      id: 2,
      name: "b",
      type: "voice",
      category: "Voice",
      category_id: 4,
      category_position: 9,
      topic: "t",
      position: 1,
      unread_count: 3,
      mention_count: 2,
      last_message_id: 40,
      last_read_message_id: 38,
      can_send: false,
      can_moderate_voice: true,
      can_move_voice: false,
      can_delete_others: true,
      can_pin: false,
      can_react: true,
      slow_mode: 5,
      nsfw: true,
      nsfw_acknowledged: true,
      private: true,
      voice_max_users: 8,
      voice_max_video: 4,
      password_protected: true,
      afk: true,
    };

    const withLabel = readyChannelMap([ready]).get(2)!;
    const withoutLabel = readyChannelMap([{ ...ready, nsfw: false }]).get(2)!;

    expect(withLabel).toMatchObject({
      categoryId: 4,
      categoryPosition: 9,
      topic: "t",
      unreadCount: 3,
      mentionCount: 2,
      lastMessageId: 40,
      lastReadMessageId: 38,
      canSend: false,
      canModerateVoice: true,
      canMoveVoice: false,
      canDeleteOthers: true,
      canPin: false,
      canReact: true,
      slowMode: 5,
      nsfw: true,
      nsfwAcknowledged: true,
      isPrivate: true,
      voiceMaxUsers: 8,
      voiceMaxVideo: 4,
      passwordProtected: true,
      afk: true,
    });
    expect(withoutLabel.nsfwAcknowledged).toBe(false);
  });
});

describe("addChannel merge", () => {
  it("gives a new channel the permissive defaults and zeroed per-user fields", () => {
    addChannel(created());

    expect(row(7)).toEqual({
      id: 7,
      name: "lounge",
      type: "text",
      category: null,
      categoryId: 0,
      categoryPosition: 0,
      topic: "",
      position: 3,
      unreadCount: 0,
      mentionCount: 0,
      lastMessageId: null,
      lastReadMessageId: undefined,
      canSend: true,
      canModerateVoice: undefined,
      canMoveVoice: undefined,
      canDeleteOthers: undefined,
      canPin: undefined,
      canReact: undefined,
      slowMode: 0,
      nsfw: false,
      isPrivate: false,
      nsfwAcknowledged: false,
      voiceMaxUsers: 0,
      voiceMaxVideo: 0,
      passwordProtected: undefined,
      afk: false,
      forum: undefined,
    });
  });

  it("keeps every per-user field the frame does not carry on a re-add", () => {
    seed(
      makeChannel({
        id: 7,
        categoryId: 5,
        categoryPosition: 6,
        unreadCount: 4,
        mentionCount: 2,
        lastMessageId: 90,
        lastReadMessageId: 88,
        canSend: false,
        canModerateVoice: true,
        canMoveVoice: true,
        canDeleteOthers: true,
        canPin: true,
        canReact: false,
        isPrivate: true,
        nsfw: true,
        nsfwAcknowledged: true,
        passwordProtected: true,
        afk: true,
        forum: { tags: [] } as unknown as Channel["forum"],
      }),
    );
    const forumBefore = row(7).forum;

    addChannel(created({ nsfw: true, position: 1 }));

    expect(row(7)).toMatchObject({
      categoryId: 5,
      categoryPosition: 6,
      position: 1,
      unreadCount: 4,
      mentionCount: 2,
      lastMessageId: 90,
      lastReadMessageId: 88,
      canSend: false,
      canModerateVoice: true,
      canMoveVoice: true,
      canDeleteOthers: true,
      canPin: true,
      canReact: false,
      isPrivate: true,
      nsfwAcknowledged: true,
      passwordProtected: true,
      afk: true,
    });
    expect(row(7).forum).toBe(forumBefore);
  });

  it("lets the frame override what it carries and drops the acknowledgement with the label", () => {
    seed(makeChannel({ id: 7, categoryId: 5, canSend: false, nsfw: true, nsfwAcknowledged: true }));

    addChannel(
      created({
        category_id: 8,
        category_position: 2,
        can_send: true,
        can_pin: false,
        private: false,
        afk: false,
        password_protected: false,
        voice_max_users: 6,
        slow_mode: 9,
        topic: "new",
      }),
    );

    expect(row(7)).toMatchObject({
      categoryId: 8,
      categoryPosition: 2,
      canSend: true,
      canPin: false,
      isPrivate: false,
      afk: false,
      passwordProtected: false,
      voiceMaxUsers: 6,
      slowMode: 9,
      topic: "new",
      nsfw: false,
      nsfwAcknowledged: false,
    });
  });

  it("leaves other rows and the active channel alone and replaces the map", () => {
    seed(makeChannel({ id: 1 }));
    const before = channelsStore.getState();

    addChannel(created());

    const after = channelsStore.getState();
    expect(after.channels).not.toBe(before.channels);
    expect(after.channels.get(1)).toBe(before.channels.get(1));
    expect(after.activeChannelId).toBe(before.activeChannelId);
  });
});

describe("updateChannel merge", () => {
  it("applies each field the update carries and keeps the rest", () => {
    const forum = { tags: [] } as unknown as Channel["forum"];
    seed(makeChannel({ id: 3, unreadCount: 5, canSend: false }));

    updateChannel({
      id: 3,
      name: "n",
      topic: "t",
      category: "",
      category_id: 2,
      category_position: 4,
      position: 8,
      slow_mode: 3,
      private: true,
      voice_max_users: 5,
      voice_max_video: 2,
      password_protected: true,
      afk: true,
      forum,
    });

    expect(row(3)).toEqual({
      ...makeChannel({ id: 3, unreadCount: 5, canSend: false }),
      name: "n",
      topic: "t",
      category: "",
      categoryId: 2,
      categoryPosition: 4,
      position: 8,
      slowMode: 3,
      isPrivate: true,
      voiceMaxUsers: 5,
      voiceMaxVideo: 2,
      passwordProtected: true,
      afk: true,
      forum,
    });
  });

  it("leaves an absent field alone, including an empty topic and the label", () => {
    seed(makeChannel({ id: 3, topic: "keep", nsfw: true, nsfwAcknowledged: true }));

    updateChannel({ id: 3, name: "renamed" });

    expect(row(3)).toMatchObject({ topic: "keep", nsfw: true, nsfwAcknowledged: true });
  });

  it("clears the acknowledgement when the label goes and keeps it when the label stays", () => {
    seed(makeChannel({ id: 3, nsfw: true, nsfwAcknowledged: true }));

    updateChannel({ id: 3, nsfw: true });
    expect(row(3).nsfwAcknowledged).toBe(true);

    updateChannel({ id: 3, nsfw: false });
    expect(row(3)).toMatchObject({ nsfw: false, nsfwAcknowledged: false });

    updateChannel({ id: 3, nsfw: true });
    expect(row(3).nsfwAcknowledged).toBe(false);
  });

  it("writes a new map and row and leaves a sibling row identical", () => {
    seed(makeChannel({ id: 3 }), makeChannel({ id: 4 }));
    const before = channelsStore.getState();

    updateChannel({ id: 3, topic: "x" });

    const after = channelsStore.getState();
    expect(after.channels).not.toBe(before.channels);
    expect(after.channels.get(3)).not.toBe(before.channels.get(3));
    expect(after.channels.get(4)).toBe(before.channels.get(4));
  });
});
