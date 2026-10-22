// A forum channel and its posts, for the forum tests (WP 6.9d).
import type { ForumSettings, ReadyChannel, ThreadInfo } from "../../src/lib/types";
import { setChannels } from "../../src/stores/channels.store";
import { makeThread } from "./thread-fixtures";

export const FORUM = 9;

export const TAGS: ForumSettings["tags"] = [
  { id: 1, name: "Bug", emoji: "🐛", position: 0 },
  { id: 2, name: "Idea", position: 1 },
  { id: 3, name: "Question", position: 2 },
];

/** A forum post: a thread of FORUM with no starter message and a `post` block. */
export function makePost(
  id: number,
  over: Partial<Omit<ThreadInfo, "id">> & { tags?: readonly number[]; preview?: string } = {},
): ThreadInfo {
  const { tags = [], preview = `opening message of ${id}`, ...rest } = over;
  return makeThread({
    id,
    parent_id: FORUM,
    name: `Post ${id}`,
    starter_message_id: null,
    owner_id: 10,
    message_count: 3,
    post: {
      tag_ids: tags,
      first_message: {
        id: id * 10,
        author_id: 10,
        preview,
        has_attachments: false,
        deleted: false,
      },
    },
    ...rest,
  });
}

export function seedForum(
  over: Partial<ReadyChannel> = {},
  forum: Partial<ForumSettings> = {},
): void {
  setChannels([
    {
      id: FORUM,
      name: "feedback",
      type: "forum",
      category: null,
      topic: "Be kind.\nSearch before you post.",
      position: 0,
      can_send: true,
      forum: { tags: TAGS, require_tag: false, default_auto_archive_minutes: 4320, ...forum },
      ...over,
    },
  ]);
}
