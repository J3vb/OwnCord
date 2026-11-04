import { afterEach } from "vitest";
import { createMessageList } from "@components/MessageList";
import { messagesStore } from "@stores/messages.store";
import type { Message } from "@stores/messages.store";
import { makeOpts } from "./message-actions-fixtures";

/** Even ids are the signed-in user's (id 1), so they can be edited. */
export function browserMessage(id: number): Message {
  return {
    id,
    channelId: 1,
    user: { id: (id % 2) + 1, username: id % 2 === 0 ? "Alice" : "Bob", avatar: null },
    content: `Message ${id}`,
    replyTo: null,
    attachments: [],
    reactions: [],
    pinned: false,
    editedAt: null,
    deleted: false,
    timestamp: new Date(Date.UTC(2024, 0, 15, 12, id)).toISOString(),
    status: "sent",
    correlationId: null,
    errorCode: null,
  };
}

export function setRows(rows: readonly Message[]): void {
  messagesStore.setState((prev) => ({
    ...prev,
    messagesByChannel: new Map([[1, rows]]),
    hasMore: new Map([[1, false]]),
  }));
}

export const frames = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r));
};

/** A 400px message region host, removed again after each test. */
export function useMessageListHost(): {
  host: HTMLElement;
  mountList(): ReturnType<typeof createMessageList>;
} {
  const style = document.createElement("style");
  style.textContent = ".messages-region { height: 400px; display: flex; flex-direction: column; }";
  const host = document.createElement("div");

  afterEach(() => {
    host.replaceChildren();
    style.remove();
    host.remove();
  });

  return {
    host,
    /** Mounts a list of 150 messages in the host. */
    mountList() {
      document.head.appendChild(style);
      document.body.appendChild(host);
      setRows(Array.from({ length: 150 }, (_, i) => browserMessage(i + 1)));
      const list = createMessageList(makeOpts({ currentUserId: 1 }));
      list.mount(host);
      return list;
    },
  };
}
