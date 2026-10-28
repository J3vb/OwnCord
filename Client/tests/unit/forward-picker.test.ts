import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openForwardPicker } from "../../src/components/ForwardPicker";
import { channelsStore, setRoles, type Channel } from "../../src/stores/channels.store";
import { authStore } from "../../src/stores/auth.store";
import { dmStore, type DmChannel } from "../../src/stores/dm.store";
import { resetBlocksStore } from "../../src/stores/blocks.store";
import { addMessage, resetMessagesStore } from "../../src/stores/messages.store";
import { createMockWsClient, type MockWsClient } from "../helpers/mock-ws";

const toast = vi.hoisted(() => vi.fn());
vi.mock("@lib/toast", () => ({ showToast: toast }));

function channel(id: number, over: Partial<Channel> = {}): Channel {
  return {
    id,
    name: `chan-${id}`,
    type: "text",
    category: null,
    topic: "",
    position: id,
    unreadCount: 0,
    mentionCount: 0,
    lastMessageId: null,
    canSend: true,
    slowMode: 0,
    nsfw: false,
    isPrivate: false,
    voiceMaxUsers: 0,
    voiceMaxVideo: 0,
    ...over,
  };
}

function dmChannel(channelId: number): DmChannel {
  const user = { id: 7, username: "user7", avatar: "", status: "online" };
  return {
    channelId,
    recipient: user,
    participants: [user],
    name: "",
    isGroup: false,
    lastMessageId: null,
    lastMessage: "",
    lastMessageAt: "",
    unreadCount: 0,
    mentionCount: 0,
  };
}

interface Sent {
  readonly type: string;
  readonly id: string;
  readonly payload: Record<string, unknown>;
}

let ws: MockWsClient;
let abort: AbortController;
const sent = (): Sent[] => ws.getSentMessages() as unknown as Sent[];
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const q = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel) as T;
const row = (id: number): HTMLElement => q(`[data-testid="forward-target-${id}"]`);
const box = (id: number): HTMLInputElement => row(id).querySelector("input") as HTMLInputElement;

function pick(id: number): void {
  const b = box(id);
  b.checked = !b.checked;
  b.dispatchEvent(new Event("change", { bubbles: true }));
}
function ack(frame: Sent): void {
  ws.simulateMessage(
    "chat_forward_ok",
    {
      message_id: 1,
      channel_id: frame.payload["channel_id"] as number,
      client_message_id: frame.payload["client_message_id"] as string,
      deduplicated: false,
    },
    frame.id,
  );
}

function open(): void {
  openForwardPicker({ ws, channelId: 1, messageId: 900, signal: abort.signal });
}

beforeEach(() => {
  ws = createMockWsClient();
  ws.connect();
  abort = new AbortController();
  toast.mockClear();
  resetMessagesStore();
  resetBlocksStore();
  dmStore.setState(() => ({ channels: [] }));
  channelsStore.setState((s) => ({
    ...s,
    channels: new Map(
      [channel(1), ...[2, 3, 4, 5, 6, 7].map((i) => channel(i, { name: `room-${i}` }))].map((c) => [
        c.id,
        c,
      ]),
    ),
  }));
  addMessage({
    id: 900,
    channel_id: 1,
    user: { id: 5, username: "alice", avatar: null },
    content: "the original",
    reply_to: null,
    attachments: [],
    reactions: [],
    pinned: false,
    edited_at: null,
    deleted: false,
    timestamp: "2024-01-15T12:00:00Z",
  } as never);
});
afterEach(() => {
  abort.abort();
  document.body.replaceChildren();
});

describe("ForwardPicker", () => {
  it("opens lazily-built dialog with the sendable targets and Forward disabled until one is picked", () => {
    open();
    expect(q("[data-testid=forward-picker]")).not.toBeNull();
    expect(document.querySelectorAll("[data-testid^=forward-target-]")).toHaveLength(7);
    expect(q<HTMLButtonElement>("[data-testid=forward-send]").disabled).toBe(true);
    pick(2);
    expect(q<HTMLButtonElement>("[data-testid=forward-send]").disabled).toBe(false);
  });

  it("offers no channel without ATTACH_FILES when the source has files, but keeps DMs", () => {
    addMessage({
      id: 901,
      channel_id: 1,
      user: { id: 5, username: "alice", avatar: null },
      content: "with a file",
      reply_to: null,
      attachments: [{ id: "a", filename: "f.txt", size: 1, mime: "text/plain", url: "/f" }],
      reactions: [],
      pinned: false,
      edited_at: null,
      deleted: false,
      timestamp: "2024-01-15T12:00:00Z",
    } as never);
    setRoles([{ id: 1, name: "member", color: null, permissions: 0x6, position: 1 }]);
    authStore.setState((s) => ({
      ...s,
      user: { id: 1, username: "me", avatar: null, role: "member" } as never,
    }));
    dmStore.setState(() => ({ channels: [dmChannel(50)] }));
    openForwardPicker({ ws, channelId: 1, messageId: 901, signal: abort.signal });
    expect(
      [...document.querySelectorAll("[data-testid^=forward-target-]")].map((e) =>
        e.getAttribute("data-testid"),
      ),
    ).toEqual(["forward-target-50"]);
    setRoles([]);
    authStore.setState((s) => ({ ...s, user: null }));
  });

  it("does nothing for a message that is not loaded", () => {
    openForwardPicker({ ws, channelId: 1, messageId: 12345, signal: abort.signal });
    expect(q("[data-testid=forward-picker]")).toBeNull();
  });

  it("caps the selection at five and disables the unpicked rows", () => {
    open();
    for (const id of [1, 2, 3, 4, 5]) pick(id);
    expect(box(6).disabled).toBe(true);
    expect(box(5).disabled).toBe(false);
    pick(5);
    expect(box(6).disabled).toBe(false);
  });

  it("search narrows the list", () => {
    open();
    const s = q<HTMLInputElement>("[data-testid=forward-search]");
    s.value = "room-3";
    s.dispatchEvent(new Event("input"));
    expect(document.querySelectorAll("[data-testid^=forward-target-]")).toHaveLength(1);
  });

  it("sends one forward at a time, then toasts and closes when all succeed", async () => {
    open();
    pick(2);
    pick(3);
    q("[data-testid=forward-send]").click();
    await flush();
    expect(sent().map((f) => [f.type, f.payload["channel_id"]])).toEqual([["chat_forward", 2]]);
    ack(sent()[0]!);
    await flush();
    ack(sent()[1]!);
    await flush();
    expect(toast).toHaveBeenCalledWith("Forwarded to 2", "success");
    expect(q("[data-testid=forward-picker]")).toBeNull();
  });

  it("keeps the picker on a refusal, names the failure and retries with the same id", async () => {
    open();
    pick(2);
    q("[data-testid=forward-send]").click();
    await flush();
    const first = sent()[0]!;
    ws.simulateMessage("error", { code: "FORBIDDEN", message: "no" } as never, first.id);
    await flush();
    expect(q("[data-testid=forward-result-2]").dataset["status"]).toBe("failed");
    expect(toast.mock.calls[0]![0]).toContain("Forwarded to 0 of 1");
    const retry = q<HTMLButtonElement>("[data-testid=forward-send]");
    expect(retry.disabled).toBe(false);
    retry.click();
    await flush();
    expect(sent()).toHaveLength(2);
    expect(sent()[1]!.payload["client_message_id"]).toBe(first.payload["client_message_id"]);
  });

  it("locks every close control while a batch is sending, and Escape and the backdrop wait", async () => {
    open();
    pick(2);
    q("[data-testid=forward-send]").click();
    await flush();
    expect(q<HTMLButtonElement>("[data-testid=forward-cancel]").disabled).toBe(true);
    expect(q<HTMLButtonElement>(".modal-close").disabled).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    q("[data-testid=forward-picker]").click();
    expect(q("[data-testid=forward-picker]")).not.toBeNull();
    ack(sent()[0]!);
    await flush();
    // Done: the batch resolved, so the picker closes with its toast.
    expect(toast).toHaveBeenCalledWith("Forwarded to 1", "success");
    expect(q("[data-testid=forward-picker]")).toBeNull();
  });

  it("stays open when a drag-select ends on the backdrop, and a backdrop click still closes", () => {
    open();
    const overlay = q("[data-testid=forward-picker]");
    overlay.firstElementChild!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(q("[data-testid=forward-picker]")).not.toBeNull();
    overlay.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector("[data-testid=forward-picker]")).toBeNull();
  });

  it("frees Done and Escape once a failed batch has resolved", async () => {
    open();
    pick(2);
    q("[data-testid=forward-send]").click();
    await flush();
    ws.simulateMessage("error", { code: "FORBIDDEN", message: "no" } as never, sent()[0]!.id);
    await flush();
    expect(q<HTMLButtonElement>("[data-testid=forward-cancel]").disabled).toBe(false);
    expect(q("[data-testid=forward-cancel]").textContent).toBe("Done");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(q("[data-testid=forward-picker]")).toBeNull();
  });

  it("moves focus to the results list, a polite live region", async () => {
    open();
    pick(2);
    q("[data-testid=forward-send]").click();
    const list = q("[data-testid=forward-list]");
    expect(list.getAttribute("aria-live")).toBe("polite");
    expect(list.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(list);
  });

  it("an abort mid-batch (a channel switch) says how many were not sent", async () => {
    open();
    pick(2);
    pick(3);
    q("[data-testid=forward-send]").click();
    await flush();
    abort.abort();
    await flush();
    expect(toast).toHaveBeenCalledWith("Forwarding stopped: 2 not sent", "warning");
    expect(q("[data-testid=forward-picker]")).toBeNull();
  });

  it("drops a picked target whose channel loses SEND while the picker is open", async () => {
    open();
    pick(2);
    channelsStore.setState((s) => ({
      ...s,
      channels: new Map(
        [...s.channels].map(([id, c]) => [id, id === 2 ? { ...c, canSend: false } : c]),
      ),
    }));
    await flush();
    expect(document.querySelector("[data-testid=forward-target-2]")).toBeNull();
    expect(q<HTMLButtonElement>("[data-testid=forward-send]").disabled).toBe(true);
  });
});
