// Send while uploading, controller half (WP 3A-9): a send queued behind its
// uploads is an "uploading" row, posts as one chat_send when the uploads land
// (also after a channel switch), and fails into the ordinary failed row. These
// run against the real messages store; only the components and the socket are
// stand-ins.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  listOpts: { value: null as any },
  inputOpts: { value: null as any },
  chunkFails: { value: false },
  restoreUnsent: vi.fn(),
  restoreDraft: vi.fn(),
}));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@components/MessageList", () => ({
  createMessageList: vi.fn((opts: unknown) => {
    h.listOpts.value = opts;
    return { mount: vi.fn(), destroy: vi.fn(), startEdit: vi.fn(), isEditing: vi.fn(() => false) };
  }),
}));
vi.mock("@components/MessageInput", () => ({
  createMessageInput: vi.fn((opts: unknown) => {
    h.inputOpts.value = opts;
    return {
      mount: vi.fn(),
      destroy: vi.fn(),
      focus: vi.fn(),
      isIdle: vi.fn(() => true),
      setDisabled: vi.fn(),
      setSendGate: vi.fn(),
      setSlowModeNote: vi.fn(),
      getDraft: vi.fn(() => ({ content: "", replyTo: null, attachments: [] })),
      peekDraft: vi.fn(() => ({ content: "", replyTo: null })),
      restoreDraft: h.restoreDraft,
      restoreUnsent: h.restoreUnsent,
    };
  }),
}));
vi.mock("@components/TypingIndicator", () => ({
  createTypingIndicator: vi.fn(() => ({ mount: vi.fn(), destroy: vi.fn() })),
}));
vi.mock("../../src/pages/main-page/ChatHeader", () => ({ updateChatHeaderForDm: vi.fn() }));
vi.mock("@lib/read-state", () => ({
  setKnownThreadCheck: vi.fn(),
  setThreadReadPointer: vi.fn(),
  markChannelRead: vi.fn(),
  leaveChannel: vi.fn(),
  markChannelReadSeen: vi.fn(),
}));
vi.mock("@lib/nav/messageNavigation", () => ({ jumpToMessage: vi.fn() }));
// The chunk can fail to load: the real loader, with a switch to make it reject.
vi.mock("../../src/features/messaging/sendQueue-loader", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/features/messaging/sendQueue-loader")
  >("../../src/features/messaging/sendQueue-loader");
  return {
    ...actual,
    loadSendQueue: () =>
      h.chunkFails.value ? Promise.reject(new Error("chunk")) : actual.loadSendQueue(),
  };
});

import { createChannelController } from "../../src/pages/main-page/ChannelController";
import type { ChannelControllerOptions } from "../../src/pages/main-page/ChannelController";
import type { QueuedAttachment, DraftUpload } from "@components/MessageInput";
import { Disposable } from "@lib/disposable";
import {
  addMessage,
  confirmSend,
  deleteMessage,
  getChannelMessages,
  messagesStore,
  resetMessagesStore,
} from "@stores/messages.store";
import { setAuth } from "@stores/auth.store";
import { channelsStore, setActiveChannel, setChannels, setRoles } from "@stores/channels.store";
import { setConnectionStatus } from "@stores/ui.store";
import { deactivatePendingMessages } from "@lib/pendingMessages";
import { failPendingOnDisconnect } from "../../src/features/messaging/wsHandlers";
import { ATTACHMENT_TTL_MS } from "../../src/features/messaging/attachmentTtl";
import { messagingText } from "../../src/i18n/messaging";

type Result = { id: string; filename: string };

/** A running upload as the composer hands it over, settled by the test. */
function held(name: string) {
  const file = new File(["x"], name);
  const owner = new Disposable();
  let resolve: (r: Result) => void = () => {};
  let reject: (e: Error) => void = () => {};
  const result = new Promise<Result>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  owner.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  let settledAt: number | undefined;
  result.then(
    () => (settledAt = Date.now()),
    () => {},
  );
  const upload: DraftUpload = {
    filename: name,
    file,
    owner,
    result,
    get settledAt() {
      return settledAt;
    },
    fraction: null,
    onProgress: null,
    refreshing: null,
  };
  const item: QueuedAttachment = { filename: name, file, upload };
  return {
    item,
    owner,
    file,
    resolve: (id: string) => resolve({ id, filename: name }),
    reject: () => reject(new Error("boom")),
  };
}

const settledItem = (id: string, filename: string, file?: File): QueuedAttachment => ({
  filename,
  id,
  uploadedAt: Date.now(),
  ...(file === undefined ? {} : { file }),
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

function setup(overrides: { userId?: () => number } = {}) {
  let nextId = 0;
  const handlers: { event: string; fn: (p: unknown, id?: string) => void; off: boolean }[] = [];
  const reuploads: {
    file: File;
    signal: AbortSignal;
    resolve: (id: string) => void;
    fail: () => void;
  }[] = [];
  const opts = {
    ws: {
      send: vi.fn((_frame: unknown) => `env-${++nextId}`),
      getState: vi.fn(() => "connected"),
      onStateChange: vi.fn(() => vi.fn()),
      on: vi.fn((event: string, fn: (p: unknown, id?: string) => void) => {
        const entry = { event, fn, off: false };
        handlers.push(entry);
        return () => {
          entry.off = true;
        };
      }),
      onSendFailure: vi.fn(() => vi.fn()),
    },
    api: {
      uploadFile: vi.fn(
        (file: File, signal?: AbortSignal) =>
          new Promise<{ id: string; url: string; filename: string }>((resolve, reject) => {
            reuploads.push({
              file,
              signal: signal!,
              resolve: (id) => resolve({ id, url: `/f/${id}`, filename: file.name }),
              fail: () => reject(new Error("boom")),
            });
            signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      ),
      discardUpload: vi.fn(async () => undefined),
      gifFavorites: vi.fn().mockResolvedValue({ favorites: [] }),
    },
    msgCtrl: { loadMessages: vi.fn(), loadOlderMessages: vi.fn(), loadNewerMessages: vi.fn() },
    reactionCtrl: { handleReaction: vi.fn(), destroy: vi.fn() },
    typingLimiter: { tryConsume: vi.fn(() => true) },
    showToast: vi.fn(),
    getCurrentUserId: overrides.userId ?? (() => 1),
    slots: {
      messagesSlot: document.createElement("div"),
      typingSlot: document.createElement("div"),
      inputSlot: document.createElement("div"),
    },
    chatHeaderName: document.createElement("span"),
    chatHeaderRefs: null,
  };
  const ctrl = createChannelController(opts as unknown as ChannelControllerOptions);
  const chatSends = (): {
    channel_id: number;
    content: string;
    reply_to: number | null;
    attachments: string[];
  }[] =>
    opts.ws.send.mock.calls
      .map((c) => c[0] as unknown as { type: string; payload: never })
      .filter((m) => m.type === "chat_send")
      .map((m) => m.payload);
  const fire = (event: string, payload: unknown, correlationId?: string): void => {
    for (const entry of handlers)
      if (entry.event === event && !entry.off) entry.fn(payload, correlationId);
  };
  return { opts, ctrl, chatSends, fire, reuploads };
}

const onSend = (
  content: string,
  queued?: readonly QueuedAttachment[],
  replyTo: number | null = null,
  settled: readonly { id: string; filename: string }[] = [],
): void =>
  h.inputOpts.value.onSend(
    content,
    replyTo,
    settled.map((s) => s.id),
    settled,
    replyTo !== null,
    queued,
  );

const rows = (channelId = 42) => getChannelMessages(channelId);
const rowByContent = (content: string, channelId = 42) =>
  rows(channelId).find((m) => m.content === content);

describe("send while uploading (controller)", () => {
  // Load the chunk once, so a test that needs it ready does not race its first import.
  beforeAll(async () => {
    await import("../../src/features/messaging/sendQueue");
  });
  beforeEach(() => {
    vi.clearAllMocks();
    h.chunkFails.value = false;
    deactivatePendingMessages();
    resetMessagesStore();
    setConnectionStatus("connected");
    setAuth("tok", { id: 1, username: "tester", avatar: null, role: "member" } as never, "s", "");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows an uploading row, then posts one chat_send with the ids, then a pending row, then sent", async () => {
    const { ctrl, opts, chatSends } = setup();
    ctrl.mountChannel(42, "general", "text");
    const a = held("a.pdf");
    const c = held("c.pdf");

    onSend("look", [a.item, settledItem("srv-b", "b.pdf"), c.item]);
    // The first import of the chunk can take longer than a few ticks.
    await vi.waitFor(() => expect(rowByContent("look")).toBeDefined());

    // The uploading row: not pending, not in pendingSends, no frame yet.
    const uploading = rowByContent("look")!;
    expect(uploading.status).toBe("uploading");
    expect(uploading.user.id).toBe(1);
    expect(messagesStore.getState().pendingSends.size).toBe(0);
    expect(chatSends()).toEqual([]);
    expect(
      h.listOpts.value.renderUploadStrip(uploading.correlationId, new AbortController().signal),
    ).toBeInstanceOf(HTMLElement);

    c.resolve("srv-c");
    await flush();
    expect(chatSends()).toEqual([]);
    a.resolve("srv-a");
    await flush();

    // One frame, ids in chip order; the uploading row became the pending one.
    expect(chatSends()).toEqual([
      { channel_id: 42, content: "look", reply_to: null, attachments: ["srv-a", "srv-b", "srv-c"] },
    ]);
    const sendId = opts.ws.send.mock.results[opts.ws.send.mock.results.length - 1]!.value as string;
    const pending = rows().filter((m) => m.content === "look");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ status: "pending", correlationId: sendId });
    expect(messagesStore.getState().pendingSends.get(sendId)).toBe(42);

    confirmSend(sendId, 900, "2026-10-16T10:00:00Z");
    expect(rowByContent("look")!.status).toBe("sent");
    ctrl.destroy();
  });

  it("a send queued in A posts to A after switching to B", async () => {
    const { ctrl, opts, chatSends } = setup();
    ctrl.mountChannel(42, "general", "text");
    const a = held("a.pdf");
    onSend("for A", [a.item]);
    await flush();

    ctrl.mountChannel(43, "random", "text");
    expect(a.owner.signal.aborted).toBe(false);
    a.resolve("srv-a");
    await flush();

    expect(chatSends()).toEqual([
      { channel_id: 42, content: "for A", reply_to: null, attachments: ["srv-a"] },
    ]);
    expect(rowByContent("for A", 42)!.status).toBe("pending");
    expect(rows(43)).toEqual([]);
    expect(opts.ws.send).toHaveBeenCalledWith(expect.objectContaining({ type: "chat_send" }));
    ctrl.destroy();
  });

  it("keeps the strip and Retry working when the user comes back to the channel", async () => {
    const { ctrl } = setup();
    ctrl.mountChannel(42, "general", "text");
    const a = held("a.pdf");
    onSend("hello", [a.item]);
    await flush();
    const cid = rowByContent("hello")!.correlationId!;

    ctrl.mountChannel(43, "random", "text");
    ctrl.mountChannel(42, "general", "text");

    const strip = h.listOpts.value.renderUploadStrip(cid, new AbortController().signal);
    expect(strip.querySelector(".msg-upload-cancel")).not.toBeNull();
    expect(rowByContent("hello")!.status).toBe("uploading");
    ctrl.destroy();
  });

  it("disconnect while uploading leaves the row uploading", async () => {
    const { ctrl } = setup();
    ctrl.mountChannel(42, "general", "text");
    const a = held("a.pdf");
    onSend("slow", [a.item]);
    await flush();

    failPendingOnDisconnect("reconnecting");

    expect(rowByContent("slow")!.status).toBe("uploading");
    expect(a.owner.signal.aborted).toBe(false);
    ctrl.destroy();
  });

  it("uploads finishing while offline give an OFFLINE row whose Retry sends the ids", async () => {
    const { ctrl, chatSends } = setup();
    ctrl.mountChannel(42, "general", "text");
    const a = held("a.pdf");
    onSend("offline", [a.item, settledItem("srv-b", "b.pdf")]);
    await flush();

    setConnectionStatus("disconnected");
    a.resolve("srv-a");
    await flush();
    const failed = rowByContent("offline")!;
    expect(failed).toMatchObject({ status: "failed", errorCode: "OFFLINE" });
    expect(chatSends()).toEqual([]);

    setConnectionStatus("connected");
    h.listOpts.value.onRetry(failed.correlationId);

    expect(chatSends()).toEqual([
      { channel_id: 42, content: "offline", reply_to: null, attachments: ["srv-a", "srv-b"] },
    ]);
    expect(rowByContent("offline")!.status).toBe("pending");
    ctrl.destroy();
  });

  it("a text sent mid-upload posts first and the uploading row stays last", async () => {
    const { ctrl, chatSends } = setup();
    ctrl.mountChannel(42, "general", "text");
    const a = held("a.pdf");
    onSend("with file", [a.item]);
    await flush();

    onSend("just text");
    expect(chatSends().map((s) => s.content)).toEqual(["just text"]);
    expect(rows().map((m) => [m.content, m.status])).toEqual([
      ["just text", "pending"],
      ["with file", "uploading"],
    ]);

    a.resolve("srv-a");
    await flush();

    expect(chatSends().map((s) => s.content)).toEqual(["just text", "with file"]);
    expect(rows().map((m) => m.status)).toEqual(["pending", "pending"]);
    ctrl.destroy();
  });

  it("keeps two queued sends in submission order of their own completion", async () => {
    const { ctrl, chatSends } = setup();
    ctrl.mountChannel(42, "general", "text");
    const first = held("a.pdf");
    const second = held("b.pdf");
    onSend("first", [first.item]);
    onSend("second", [second.item]);
    await flush();
    expect(rows().map((m) => m.content)).toEqual(["first", "second"]);

    second.resolve("srv-b");
    await flush();
    first.resolve("srv-a");
    await flush();

    expect(chatSends().map((s) => s.content)).toEqual(["second", "first"]);
    ctrl.destroy();
  });

  it("sends a plain message when the reply target was deleted before dispatch", async () => {
    const { ctrl, chatSends } = setup();
    ctrl.mountChannel(42, "general", "text");
    addMessage({
      id: 5,
      channel_id: 42,
      user: { id: 2, username: "ana", avatar: null },
      content: "parent",
      reply_to: null,
      attachments: [],
      timestamp: "2026-10-16T09:00:00Z",
    } as never);
    const a = held("a.pdf");
    onSend("reply", [a.item], 5);
    await flush();
    expect(rowByContent("reply")!.replyTo).toBe(5);

    deleteMessage({ channel_id: 42, message_id: 5 } as never);
    a.resolve("srv-a");
    await flush();

    expect(chatSends()).toEqual([
      { channel_id: 42, content: "reply", reply_to: null, attachments: ["srv-a"] },
    ]);
    ctrl.destroy();
  });

  it("Delete discards the settled ids, stops the uploads and removes the row", async () => {
    const { ctrl, opts, chatSends } = setup();
    ctrl.mountChannel(42, "general", "text");
    const a = held("a.pdf");
    onSend("never", [a.item, settledItem("srv-b", "b.pdf")]);
    await flush();
    const cid = rowByContent("never")!.correlationId;

    h.listOpts.value.onDeleteDraft(cid);
    await flush();

    expect(opts.api.discardUpload).toHaveBeenCalledOnce();
    expect(opts.api.discardUpload).toHaveBeenCalledWith("srv-b");
    expect(a.owner.signal.aborted).toBe(true);
    expect(rowByContent("never")).toBeUndefined();
    expect(chatSends()).toEqual([]);
    ctrl.destroy();
  });

  it("destroy() cancels queued uploads and posts nothing", async () => {
    const { ctrl, chatSends } = setup();
    ctrl.mountChannel(42, "general", "text");
    const a = held("a.pdf");
    onSend("bye", [a.item]);
    await flush();

    ctrl.destroy();
    await flush();

    expect(a.owner.signal.aborted).toBe(true);
    expect(chatSends()).toEqual([]);
  });

  it("sends nothing when the account changed before dispatch", async () => {
    let user = 1;
    const { ctrl, chatSends } = setup({ userId: () => user });
    ctrl.mountChannel(42, "general", "text");
    const a = held("a.pdf");
    onSend("mine", [a.item]);
    await flush();

    user = 2;
    a.resolve("srv-a");
    await flush();

    expect(chatSends()).toEqual([]);
    ctrl.destroy();
  });

  it("gives a failed row and a Retry that loads again when the chunk does not load", async () => {
    h.chunkFails.value = true;
    const { ctrl, chatSends } = setup();
    ctrl.mountChannel(42, "general", "text");
    const a = held("a.pdf");
    onSend("keep my text", [a.item]);
    await flush();

    const failed = rowByContent("keep my text")!;
    expect(failed).toMatchObject({ status: "failed", errorCode: "UPLOAD_FAILED" });
    expect(
      h.listOpts.value.renderUploadStrip(failed.correlationId, new AbortController().signal),
    ).toBeNull();
    expect(a.owner.signal.aborted).toBe(false);

    h.chunkFails.value = false;
    h.listOpts.value.onRetry(failed.correlationId);
    await flush();
    expect(rowByContent("keep my text")!.status).toBe("uploading");
    a.resolve("srv-a");
    await flush();

    expect(chatSends()).toEqual([
      { channel_id: 42, content: "keep my text", reply_to: null, attachments: ["srv-a"] },
    ]);
    ctrl.destroy();
  });

  it("fails UPLOAD_FAILED on an upload error, and Retry re-uploads only that file under a new row", async () => {
    const { ctrl, opts, chatSends, reuploads } = setup();
    ctrl.mountChannel(42, "general", "text");
    const a = held("a.pdf");
    const b = held("b.pdf");
    onSend("two", [a.item, b.item]);
    await flush();

    a.resolve("srv-a");
    await flush();
    b.reject();
    await flush();
    const failed = rowByContent("two")!;
    expect(failed).toMatchObject({ status: "failed", errorCode: "UPLOAD_FAILED" });
    // The failed row keeps its chips, with no progress and no Cancel.
    const strip = h.listOpts.value.renderUploadStrip(
      failed.correlationId,
      new AbortController().signal,
    );
    expect(strip.querySelectorAll(".msg-upload-chip")).toHaveLength(2);
    expect(strip.querySelector(".msg-upload-cancel")).toBeNull();
    expect(messagesStore.getState().pendingSends.size).toBe(0);

    h.listOpts.value.onRetry(failed.correlationId);
    await flush();
    expect(opts.api.uploadFile).toHaveBeenCalledOnce();
    expect(reuploads[0]!.file).toBe(b.file);
    const again = rows().filter((m) => m.content === "two");
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ status: "uploading" });
    expect(again[0]!.correlationId).not.toBe(failed.correlationId);
    const live = h.listOpts.value.renderUploadStrip(
      again[0]!.correlationId,
      new AbortController().signal,
    );
    expect(live.querySelector(".msg-upload-cancel")).not.toBeNull();

    reuploads[0]!.resolve("srv-b2");
    await flush();

    expect(chatSends()).toEqual([
      { channel_id: 42, content: "two", reply_to: null, attachments: ["srv-a", "srv-b2"] },
    ]);
    ctrl.destroy();
  });

  it("Cancel on the strip fails the row UPLOAD_CANCELLED with the cancelled copy", async () => {
    const { ctrl, chatSends } = setup();
    ctrl.mountChannel(42, "general", "text");
    const a = held("a.pdf");
    onSend("cancel me", [a.item]);
    await flush();
    const cid = rowByContent("cancel me")!.correlationId!;
    const strip = h.listOpts.value.renderUploadStrip(
      cid,
      new AbortController().signal,
    ) as HTMLElement;

    (strip.querySelector(`[data-testid='msg-upload-cancel-${cid}']`) as HTMLButtonElement).click();
    await flush();

    expect(a.owner.signal.aborted).toBe(true);
    expect(rowByContent("cancel me")).toMatchObject({
      status: "failed",
      errorCode: "UPLOAD_CANCELLED",
    });
    expect(messagingText("send.uploadCancelled")).toBe("Upload cancelled");
    expect(chatSends()).toEqual([]);
    ctrl.destroy();
  });

  it("puts the files of a queued send the server skipped back into its channel", async () => {
    const { ctrl, opts, fire } = setup();
    ctrl.mountChannel(42, "general", "text");
    const a = held("a.pdf");
    onSend("skipped", [a.item]);
    await flush();
    ctrl.mountChannel(43, "random", "text");
    a.resolve("srv-a");
    await flush();
    const sendId = opts.ws.send.mock.results[opts.ws.send.mock.results.length - 1]!.value as string;

    fire(
      "chat_send_ok",
      { message_id: 7, timestamp: "", skipped_attachment_ids: ["srv-a"] },
      sendId,
    );
    expect(h.restoreUnsent).not.toHaveBeenCalled();

    ctrl.mountChannel(42, "general", "text");
    expect(h.restoreDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [expect.objectContaining({ id: "srv-a", filename: "a.pdf", unsent: true })],
      }),
    );
    ctrl.destroy();
  });

  it("puts a file whose id aged out with no file to re-upload back, and still posts the rest", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { ctrl, chatSends } = setup();
    ctrl.mountChannel(42, "general", "text");
    const slow = held("slow.pdf");
    onSend("aged", [settledItem("srv-old", "old.pdf"), slow.item]);
    await vi.waitFor(() => expect(rowByContent("aged")).toBeDefined());

    vi.setSystemTime(Date.now() + ATTACHMENT_TTL_MS + 1000);
    slow.resolve("srv-slow");
    await vi.waitFor(() => expect(chatSends()).toHaveLength(1));

    expect(chatSends()[0]!.attachments).toEqual(["srv-slow"]);
    expect(h.restoreUnsent).toHaveBeenCalledWith(
      [{ id: "srv-old", filename: "old.pdf" }],
      "skipped",
      null,
    );
    ctrl.destroy();
  });
  it("Retry then Delete before the chunk loads posts nothing", async () => {
    h.chunkFails.value = true;
    const { ctrl, chatSends } = setup();
    ctrl.mountChannel(42, "general", "text");
    const a = held("a.pdf");
    onSend("deleted", [a.item]);
    await flush();
    const failedCid = rowByContent("deleted")!.correlationId;

    h.chunkFails.value = false;
    h.listOpts.value.onRetry(failedCid);
    // Still waiting for the chunk: the user presses Delete on the row on screen.
    h.listOpts.value.onDeleteDraft(failedCid);
    a.resolve("srv-a");
    await flush();

    expect(rowByContent("deleted")).toBeUndefined();
    expect(chatSends()).toEqual([]);
    ctrl.destroy();
  });

  it("two quick Retry clicks run the send once", async () => {
    h.chunkFails.value = true;
    const { ctrl, chatSends } = setup();
    ctrl.mountChannel(42, "general", "text");
    const a = held("a.pdf");
    onSend("twice", [a.item]);
    await flush();
    const failedCid = rowByContent("twice")!.correlationId;

    h.chunkFails.value = false;
    h.listOpts.value.onRetry(failedCid);
    h.listOpts.value.onRetry(failedCid);
    a.resolve("srv-a");
    await flush();

    expect(chatSends()).toHaveLength(1);
    expect(rows().filter((m) => m.content === "twice")).toHaveLength(1);
    ctrl.destroy();
  });

  it("holds a queued send until a slow-mode window opened by a later text is over", async () => {
    setChannels([
      {
        id: 42,
        name: "general",
        type: "text",
        category: null,
        position: 0,
        can_send: true,
        slow_mode: 5,
      },
    ] as never);
    setActiveChannel(42);
    setRoles([{ id: 4, name: "member", color: null, permissions: 0 }]);
    channelsStore.flush();
    const { ctrl, chatSends, fire, opts } = setup();

    ctrl.mountChannel(42, "general", "text");
    const a = held("a.pdf");
    onSend("files", [a.item]);
    await flush();

    // A quick text goes out and is accepted: the server's window starts.
    onSend("quick");
    await flush();
    const sendIndex = opts.ws.send.mock.calls.findIndex(
      (c) => (c[0] as { type: string }).type === "chat_send",
    );
    const quickCid = opts.ws.send.mock.results[sendIndex]!.value as string;
    fire("chat_send_ok", { message_id: 5, timestamp: "" }, quickCid);
    vi.useFakeTimers();
    a.resolve("srv-a");
    await vi.advanceTimersByTimeAsync(3000);
    expect(chatSends().map((m) => m.content)).toEqual(["quick"]);

    await vi.advanceTimersByTimeAsync(2500);
    expect(chatSends().map((m) => m.content)).toEqual(["quick", "files"]);
    ctrl.destroy();
  });

  it("stops holding a queued send when slow mode is turned off", async () => {
    setChannels([
      {
        id: 42,
        name: "general",
        type: "text",
        category: null,
        position: 0,
        can_send: true,
        slow_mode: 5,
      },
    ] as never);
    setActiveChannel(42);
    setRoles([{ id: 4, name: "member", color: null, permissions: 0 }]);
    channelsStore.flush();
    const { ctrl, chatSends, fire, opts } = setup();

    ctrl.mountChannel(42, "general", "text");
    const a = held("a.pdf");
    onSend("files", [a.item]);
    await flush();

    // A quick text goes out and is accepted: the server's window starts.
    onSend("quick");
    await flush();
    const sendIndex = opts.ws.send.mock.calls.findIndex(
      (c) => (c[0] as { type: string }).type === "chat_send",
    );
    const quickCid = opts.ws.send.mock.results[sendIndex]!.value as string;
    fire("chat_send_ok", { message_id: 5, timestamp: "" }, quickCid);
    vi.useFakeTimers();
    a.resolve("srv-a");
    await vi.advanceTimersByTimeAsync(3000);
    expect(chatSends().map((m) => m.content)).toEqual(["quick"]);

    setChannels([
      {
        id: 42,
        name: "general",
        type: "text",
        category: null,
        position: 0,
        can_send: true,
        slow_mode: 0,
      },
    ] as never);
    channelsStore.flush();
    await vi.advanceTimersByTimeAsync(300);
    expect(chatSends().map((m) => m.content)).toEqual(["quick", "files"]);
    ctrl.destroy();
  });

  it("does not put files back for a send whose account changed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let user = 1;
    const { ctrl, chatSends } = setup({ userId: () => user });
    ctrl.mountChannel(42, "general", "text");
    const slow = held("slow.pdf");
    onSend("aged", [settledItem("srv-old", "old.pdf"), slow.item]);
    await vi.waitFor(() => expect(rowByContent("aged")).toBeDefined());

    vi.setSystemTime(Date.now() + ATTACHMENT_TTL_MS + 1000);
    user = 2;
    slow.resolve("srv-slow");
    await flush();

    expect(h.restoreUnsent).not.toHaveBeenCalled();
    expect(chatSends()).toEqual([]);
    ctrl.destroy();
  });
});
