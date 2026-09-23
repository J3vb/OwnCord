// B9-6: accept, ignore, delete or block a Message Request — the server's
// answer decides, races refetch, focus stays put, and accepting opens the
// conversation only once the server has opened it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { ApiClientError, type DmRequestDecision } from "@lib/api";
import type { DmRequestListItem } from "@lib/types";
import { blocksStore, resetBlocksStore } from "@stores/blocks.store";
import { channelsStore, setActiveChannel } from "@stores/channels.store";
import { addDmChannel, dmStore, setDmChannels, type DmChannel } from "@stores/dm.store";
import { setConnectionStatus, uiStore } from "@stores/ui.store";
import type { DispatchApi } from "../connection/dispatchContext";
import { renderInbox } from "./Inbox";
import { messageRequestsStore, resetMessageRequests } from "./store";
import { applyReadyDmRequests, handleDmRequest } from "./wsHandlers";

function item(id: number): DmRequestListItem {
  return {
    id,
    channel_id: 100 + id,
    sender: { id: 10 + id, username: `stranger${id}`, display_name: `Stranger ${id}`, avatar: "" },
    preview: { message_id: 500 + id, content: `hello ${id}`, timestamp: "2026-09-05T12:00:00Z" },
    created_at: "2026-09-05T12:00:00Z",
  };
}

function dm(id: number): DmChannel {
  const recipient = {
    id: 10 + id,
    username: `stranger${id}`,
    avatar: "",
    status: "online",
    displayName: `Stranger ${id}`,
  };
  return {
    channelId: 100 + id,
    recipient,
    participants: [recipient],
    name: "",
    isGroup: false,
    lastMessageId: null,
    lastMessage: "",
    lastMessageAt: "",
    unreadCount: 0,
    mentionCount: 0,
  };
}

interface Call {
  readonly id: number;
  readonly decision: DmRequestDecision;
  readonly resolve: () => void;
  readonly reject: (err: unknown) => void;
}

/** Decisions and snapshots the test answers by hand. */
function fakeApi() {
  const decisions: Call[] = [];
  const snapshots: Array<(items: DmRequestListItem[]) => void> = [];
  const api = {
    listBlocks: vi.fn(),
    listDmRequests: vi.fn(
      () =>
        new Promise<{ requests: DmRequestListItem[] }>((resolve) => {
          snapshots.push((requests) => resolve({ requests }));
        }),
    ),
    decideDmRequest: vi.fn(
      (id: number, decision: DmRequestDecision) =>
        new Promise((resolve, reject) => {
          decisions.push({
            id,
            decision,
            resolve: () =>
              resolve({ id, state: `${decision}ed`, decided_at: "2026-09-05T12:01:00Z" }),
            reject,
          });
        }),
    ),
  } as unknown as DispatchApi;
  return { api, decisions, snapshots };
}

const settle = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
  messageRequestsStore.flush();
  dmStore.flush();
  channelsStore.flush();
  uiStore.flush();
};

let owner: AbortController;
let root: HTMLElement;
let heading: HTMLElement;
let fx: ReturnType<typeof fakeApi>;

/** The inbox inside the content view's frame, as contentView.ts builds it. */
async function open(...requests: number[]): Promise<void> {
  fx = fakeApi();
  applyReadyDmRequests(fx.api);
  fx.snapshots.shift()!(requests.map(item));
  await settle();
  owner = new AbortController();
  const view = document.createElement("div");
  view.className = "feature-view";
  heading = document.createElement("h2");
  heading.className = "feature-view-title";
  heading.tabIndex = -1;
  root = document.createElement("div");
  view.append(heading, root);
  document.body.appendChild(view);
  renderInbox(root, owner.signal);
}

const row = (id: number): HTMLElement =>
  [...root.querySelectorAll<HTMLElement>(".requests-item")].find((li) =>
    li.querySelector("h3")!.textContent.endsWith(` ${id}`),
  )!;
const button = (id: number, d: DmRequestDecision): HTMLButtonElement =>
  row(id).querySelector(`[data-testid='request-${d}']`)!;
const outcome = (): string => root.querySelector("[data-testid='requests-outcome']")!.textContent;
const pendingIds = (): number[] => messageRequestsStore.getState().pending.map((r) => r.id);
const dialog = (): HTMLElement | null =>
  document.querySelector("[data-testid='request-confirm-dialog'] [role='dialog']");

beforeEach(() => {
  resetMessageRequests();
  resetBlocksStore();
  setDmChannels([]);
  setActiveChannel(null);
  setConnectionStatus("connected");
});

afterEach(() => {
  owner.abort();
  root.parentElement?.remove();
  document.body.replaceChildren();
});

describe("message request decisions", () => {
  it("offers four named decisions and explains what Accept, Ignore and Delete mean", async () => {
    await open(1);
    const group = row(1).querySelector("[role='group']")!;
    expect(group.getAttribute("aria-label")).toBe("Request from Stranger 1");
    expect([...group.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Accept",
      "Ignore",
      "Delete…",
      "Block…",
    ]);
    expect(root.textContent).toContain("Accept trusts the sender on this server");
    expect(root.textContent).toContain("without telling the sender");
  });

  it("accepts once, and opens the conversation only after the server opens it", async () => {
    await open(1);
    button(1, "accept").click();
    button(1, "accept").click();
    expect(fx.api.decideDmRequest).toHaveBeenCalledTimes(1);
    expect(fx.decisions[0]).toMatchObject({ id: 1, decision: "accept" });
    expect(button(1, "accept").textContent).toBe("Accepting…");
    expect(button(1, "ignore").getAttribute("aria-disabled")).toBe("true");
    expect(row(1).getAttribute("aria-busy")).toBe("true");

    fx.decisions[0]!.resolve();
    await settle();
    expect(pendingIds()).toEqual([]);
    expect(outcome()).toBe("Accepted Stranger 1's request. Opening your conversation…");
    // Accepted, but the server's dm_channel_open has not arrived: stay put.
    expect(channelsStore.getState().activeChannelId).toBeNull();

    addDmChannel(dm(1));
    await settle();
    expect(channelsStore.getState().activeChannelId).toBe(101);
    expect(uiStore.getState().sidebarMode).toBe("dms");
    expect(uiStore.getState().activeDmUserId).toBe(11);
  });

  it("opens at once when the conversation is already there", async () => {
    await open(1);
    addDmChannel(dm(1));
    button(1, "accept").click();
    fx.decisions[0]!.resolve();
    await settle();
    expect(channelsStore.getState().activeChannelId).toBe(101);
  });

  it("opens from GET /dms when the server's dm_channel_open was lost", async () => {
    await open(1);
    const dms = vi.fn(() =>
      Promise.resolve({
        dm_channels: [
          {
            channel_id: 101,
            recipient: { id: 11, username: "stranger1", avatar: "", status: "online" },
            last_message_id: 501,
            last_message: "hello 1",
            last_message_at: "2026-09-05T12:00:00Z",
            unread_count: 1,
          },
        ],
      }),
    );
    Object.assign(fx.api, { getDmChannels: dms });
    button(1, "accept").click();
    // No GET before the server said yes.
    expect(dms).not.toHaveBeenCalled();
    fx.decisions[0]!.resolve();
    await settle();
    await settle();
    expect(dms).toHaveBeenCalledTimes(1);
    expect(channelsStore.getState().activeChannelId).toBe(101);
  });

  it("never opens a conversation for a request that only disappeared", async () => {
    await open(1);
    button(1, "accept").click();
    // Another device decided first: the frame removes it, then our POST loses.
    handleDmRequest({ ...item(1), state: "accepted", preview: null, decided_at: "x" });
    fx.decisions[0]!.reject(new ApiClientError(409, "CONFLICT", "not pending"));
    await settle();
    addDmChannel(dm(1));
    await settle();
    expect(channelsStore.getState().activeChannelId).toBeNull();
    expect(outcome()).toBe(
      "Stranger 1's request was already handled, perhaps on another device. The list was refreshed.",
    );
    // A conflict refetches the inbox rather than guessing.
    expect(fx.api.listDmRequests).toHaveBeenCalledTimes(2);
  });

  it("refetches when the request is gone (404) and shows what the server says", async () => {
    await open(1, 2);
    button(1, "ignore").click();
    fx.decisions[0]!.reject(new ApiClientError(404, "NOT_FOUND", "gone"));
    await settle();
    expect(fx.api.listDmRequests).toHaveBeenCalledTimes(2);
    fx.snapshots.shift()!([item(2)]);
    await settle();
    expect(pendingIds()).toEqual([2]);
  });

  it("keeps a failed decision retryable and says why, then succeeds on retry", async () => {
    await open(1);
    button(1, "ignore").click();
    fx.decisions[0]!.reject(new TypeError("Failed to fetch"));
    await settle();
    const error = row(1).querySelector<HTMLElement>("[data-testid='request-error']")!;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain("didn't go through");
    expect(outcome()).toBe(error.textContent);
    expect(button(1, "ignore").getAttribute("aria-disabled")).toBe("false");
    expect(button(1, "ignore").textContent).toBe("Ignore");
    expect(pendingIds()).toEqual([1]);

    button(1, "ignore").click();
    expect(error.hidden).toBe(true);
    fx.decisions[1]!.resolve();
    await settle();
    expect(pendingIds()).toEqual([]);
    expect(outcome()).toBe("Ignored Stranger 1's request.");
  });

  it("confirms Delete in a dialog: Cancel is first, focused, and returns focus", async () => {
    await open(1);
    button(1, "delete").focus();
    button(1, "delete").click();
    const d = dialog()!;
    expect(d.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(d.getAttribute("aria-labelledby")!)!.textContent).toBe(
      "Delete this request?",
    );
    expect(d.textContent).toContain("Stranger 1 is not told.");
    expect(document.activeElement?.textContent).toBe("Cancel");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(button(1, "delete"));
    expect(fx.api.decideDmRequest).not.toHaveBeenCalled();

    button(1, "delete").click();
    dialog()!.querySelector<HTMLButtonElement>("[data-testid='request-confirm']")!.click();
    expect(dialog()).toBeNull();
    expect(fx.decisions[0]).toMatchObject({ id: 1, decision: "delete" });
    fx.decisions[0]!.resolve();
    await settle();
    expect(outcome()).toBe("Deleted Stranger 1's request.");
  });

  it("confirms Block, then records the sender as blocked", async () => {
    await open(1);
    button(1, "block").click();
    expect(dialog()!.textContent).toContain("Block Stranger 1?");
    dialog()!.querySelector<HTMLButtonElement>("[data-testid='request-confirm-cancel']")!.click();
    expect(fx.api.decideDmRequest).not.toHaveBeenCalled();

    button(1, "block").click();
    dialog()!.querySelector<HTMLButtonElement>("[data-testid='request-confirm']")!.click();
    expect(fx.decisions[0]).toMatchObject({ id: 1, decision: "block" });
    expect(blocksStore.getState().blockedByMe.has(11)).toBe(false);
    fx.decisions[0]!.resolve();
    await settle();
    expect(blocksStore.getState().blockedByMe.has(11)).toBe(true);
    expect(outcome()).toBe("Blocked Stranger 1 and removed their request.");
  });

  it("moves focus to the next request, then the previous, then the heading", async () => {
    await open(1, 2, 3);
    // Newest first: 3, 2, 1.
    button(2, "ignore").focus();
    button(2, "ignore").click();
    fx.decisions[0]!.resolve();
    await settle();
    // The row, not a decision: a repeated Enter must not decide another request.
    expect(document.activeElement).toBe(row(1));

    button(1, "ignore").click();
    fx.decisions[1]!.resolve();
    await settle();
    expect(document.activeElement).toBe(row(3));

    button(3, "ignore").click();
    fx.decisions[2]!.resolve();
    await settle();
    expect(document.activeElement).toBe(heading);
  });

  it("keeps focus and rows in place when another request changes", async () => {
    await open(1, 2);
    const kept = row(1);
    button(1, "block").focus();
    handleDmRequest({ ...item(2), state: "ignored", preview: null, decided_at: "x" });
    handleDmRequest({ ...item(5), state: "pending", decided_at: null });
    messageRequestsStore.flush();
    expect(row(1)).toBe(kept);
    expect(document.activeElement).toBe(button(1, "block"));
    expect(row(5)).toBeDefined();
  });

  it("closes an open confirm when the request is decided elsewhere", async () => {
    await open(1, 2);
    button(2, "delete").click();
    expect(dialog()).not.toBeNull();
    handleDmRequest({ ...item(2), state: "accepted", preview: null, decided_at: "x" });
    messageRequestsStore.flush();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(row(1));
  });

  it("drops a decision that lands after the view closed or the account changed", async () => {
    await open(1);
    button(1, "accept").click();
    owner.abort();
    resetMessageRequests();
    handleDmRequest({ ...item(1), state: "pending", decided_at: null });
    fx.decisions[0]!.resolve();
    await settle();
    // The late 200 wrote nothing: the next session's copy of id 1 stays.
    expect(pendingIds()).toEqual([1]);
    addDmChannel(dm(1));
    await settle();
    expect(channelsStore.getState().activeChannelId).toBeNull();
  });

  it("keeps a decided request out of a snapshot that was already in flight", async () => {
    await open(1);
    applyReadyDmRequests(fx.api); // a reconnect's GET, answered late
    button(1, "ignore").click();
    fx.decisions[0]!.resolve();
    await settle();
    fx.snapshots.shift()!([item(1)]);
    await settle();
    expect(pendingIds()).toEqual([]);
  });
});
