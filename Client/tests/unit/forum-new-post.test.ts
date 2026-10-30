import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ThreadInfo } from "@lib/types";
import { openNewPostDialog, postErrorText } from "../../src/features/forums/NewPostDialog";
import { resetChannelsStore } from "@stores/channels.store";
import { resetThreadsStore } from "@stores/threads.store";
import { setConnectionStatus } from "@stores/ui.store";
import { isForwardRequest } from "../../src/features/messaging/forwardRequests";
import type { ApiClient } from "@lib/api";
import { initToast, teardownToast } from "@lib/ui/toast";
import type { ToastContainer } from "@components/Toast";
import type { WsClient } from "@lib/ws";
import { createMockWsClient } from "../helpers/mock-ws";
import { FORUM, makePost, seedForum } from "../helpers/forum-fixtures";

let ac: AbortController;
let ws: ReturnType<typeof createMockWsClient>;
let uploadFile: ReturnType<typeof vi.fn>;
let discardUpload: ReturnType<typeof vi.fn>;
let onCreated: Mock<(post: ThreadInfo) => void>;

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const sent = () =>
  (
    ws.getSentMessages() as unknown as {
      type: string;
      id: string;
      payload: Record<string, unknown>;
    }[]
  ).filter((m) => m.type === "forum_post_create");
const byId = <T extends HTMLElement>(testId: string): T =>
  document.querySelector<T>(`[data-testid="${testId}"]`) as T;

function open(): void {
  openNewPostDialog({
    ws: ws as unknown as WsClient,
    api: { uploadFile, discardUpload, getConfig: () => ({ host: "h" }) } as unknown as ApiClient,
    channelId: FORUM,
    signal: ac.signal,
    onCreated,
  });
}
function fill(title: string, message: string): void {
  byId<HTMLInputElement>("forum-post-title").value = title;
  byId<HTMLTextAreaElement>("forum-post-message").value = message;
}
function submit(): void {
  byId<HTMLFormElement>("forum-post-title").form!.dispatchEvent(
    new Event("submit", { cancelable: true, bubbles: true }),
  );
}
const error = (): string => byId("forum-post-error").textContent ?? "";

beforeEach(() => {
  ac = new AbortController();
  ws = createMockWsClient();
  uploadFile = vi.fn();
  discardUpload = vi.fn(async () => {});
  onCreated = vi.fn();
  resetChannelsStore();
  resetThreadsStore();
  setConnectionStatus("connected");
  seedForum();
});
afterEach(() => {
  ac.abort();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("New Post dialog", () => {
  it("shows the guidelines, a title counter and the tags, and sends the post", () => {
    open();
    expect(byId("forum-dialog-guidelines").textContent).toContain("Be kind.");
    fill("Dark mode", "Please add a dark theme.");
    byId<HTMLInputElement>("forum-post-title").dispatchEvent(new Event("input"));
    expect(byId("forum-post-count").textContent).toBe("9/100");
    byId<HTMLButtonElement>("forum-post-tag-3").click();
    byId<HTMLButtonElement>("forum-post-tag-1").click();
    submit();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.payload).toMatchObject({
      channel_id: FORUM,
      name: "Dark mode",
      content: "Please add a dark theme.",
      attachments: [],
      tag_ids: [1, 3],
    });
    expect(String(sent()[0]!.payload["client_message_id"])).toMatch(/^\d+:[0-9a-f-]{36}$/);
    expect(byId<HTMLButtonElement>("forum-post-submit").disabled).toBe(true);
    // The generic error toast is told to leave this request's refusal to the dialog.
    expect(isForwardRequest(sent()[0]!.id)).toBe(true);
  });

  it("requires a title, a message or file, and (when the forum asks) a tag", () => {
    seedForum({}, { require_tag: true });
    open();
    expect(byId("forum-post-tags-hint").textContent).toBe("Required: pick at least one");
    expect(document.querySelector(".forum-required")).not.toBeNull();
    fill("   ", "hello");
    submit();
    expect(error()).toBe("Give your post a title");
    fill("Title", "hello");
    submit();
    expect(error()).toBe("Pick at least one tag");
    byId<HTMLButtonElement>("forum-post-tag-2").click();
    fill("Title", "  ");
    submit();
    expect(error()).toBe("Write a message or attach a file");
    expect(sent()).toHaveLength(0);
    fill("Title", "hello");
    submit();
    expect(byId("forum-post-error").hidden).toBe(true);
    expect(sent()[0]!.payload["tag_ids"]).toEqual([2]);
  });

  it("clears a validation error once the field it names is fixed", () => {
    seedForum({}, { require_tag: true });
    open();
    fill("Title", "hello");
    submit();
    expect(byId("forum-post-error").hidden).toBe(false);
    byId<HTMLButtonElement>("forum-post-tag-2").click();
    expect(byId("forum-post-error").hidden).toBe(true);

    fill("", "hello");
    submit();
    expect(error()).toBe("Give your post a title");
    // Editing another field leaves the title error up.
    byId<HTMLTextAreaElement>("forum-post-message").dispatchEvent(new Event("input"));
    expect(byId("forum-post-error").hidden).toBe(false);
    byId<HTMLInputElement>("forum-post-title").dispatchEvent(new Event("input"));
    expect(byId("forum-post-error").hidden).toBe(true);
  });

  it("marks the tags optional when the forum does not require one, and caps them at five", () => {
    seedForum(
      {},
      {
        tags: Array.from({ length: 7 }, (_, i) => ({ id: i + 1, name: `t${i + 1}`, position: i })),
      },
    );
    open();
    expect(byId("forum-post-tags-hint").textContent).toBe("Optional: pick up to 5");
    expect(document.querySelector(".forum-required")).toBeNull();
    for (let i = 1; i <= 5; i++) byId<HTMLButtonElement>(`forum-post-tag-${i}`).click();
    expect(byId<HTMLButtonElement>("forum-post-tag-6").disabled).toBe(true);
    expect(byId<HTMLButtonElement>("forum-post-tag-1").disabled).toBe(false);
  });

  it("keeps the client_message_id across a retry of the same post, and mints a new one when the post changes", () => {
    vi.useFakeTimers();
    open();
    fill("Dark mode", "Please.");
    submit();
    const first = sent()[0]!.payload["client_message_id"];
    // No ack: the dialog says so and lets the user post again.
    vi.advanceTimersByTime(20_000);
    expect(error()).toBe(postErrorText("UNCONFIRMED"));
    expect(byId<HTMLButtonElement>("forum-post-submit").disabled).toBe(false);
    submit();
    expect(sent()).toHaveLength(2);
    expect(sent()[1]!.payload["client_message_id"]).toBe(first);
    expect(sent()[1]!.id).not.toBe(sent()[0]!.id);
    // A refusal keeps the id too: the same content is the same logical post.
    ws.simulateMessage("error", { code: "SLOW_MODE", message: "x" }, sent()[1]!.id);
    submit();
    expect(sent()[2]!.payload["client_message_id"]).toBe(first);
    ws.simulateMessage("error", { code: "SLOW_MODE", message: "x" }, sent()[2]!.id);
    // Editing the post makes it a different one.
    fill("Dark mode", "Please, with sugar.");
    submit();
    expect(sent()[3]!.payload["client_message_id"]).not.toBe(first);
  });

  it("opens the post and closes on the ack", () => {
    open();
    fill("Dark mode", "Please.");
    submit();
    const post = makePost(77);
    ws.simulateMessage(
      "forum_post_create_ok",
      {
        thread: post,
        message_id: 5,
        client_message_id: sent()[0]!.payload["client_message_id"] as string,
      },
      sent()[0]!.id,
    );
    expect(onCreated).toHaveBeenCalledWith(post);
    expect(byId("forum-post-dialog")).toBeNull();
  });

  it("finishes on a late ack of the first attempt after a retry was sent", () => {
    vi.useFakeTimers();
    open();
    fill("Dark mode", "Please.");
    submit();
    const first = sent()[0]!;
    vi.advanceTimersByTime(20_000);
    submit();
    // The first request's ack finally arrives (the second is still in flight).
    ws.simulateMessage(
      "forum_post_create_ok",
      {
        thread: makePost(77),
        message_id: 5,
        client_message_id: first.payload["client_message_id"] as string,
      },
      first.id,
    );
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(byId("forum-post-dialog")).toBeNull();
    // And the answer to the retry, deduplicated, does nothing more.
    ws.simulateMessage(
      "forum_post_create_ok",
      {
        thread: makePost(77),
        message_id: 5,
        deduplicated: true,
        client_message_id: first.payload["client_message_id"] as string,
      },
      sent()[1]!.id,
    );
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("shows a server refusal and keeps what was typed", () => {
    open();
    fill("Dark mode", "Please.");
    submit();
    ws.simulateMessage("error", { code: "FORBIDDEN", message: "x" }, sent()[0]!.id);
    expect(error()).toBe("You can't post in this forum");
    expect(byId<HTMLInputElement>("forum-post-title").value).toBe("Dark mode");
    expect(byId<HTMLTextAreaElement>("forum-post-message").value).toBe("Please.");
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("keeps the post and says so when offline, without sending", () => {
    setConnectionStatus("disconnected");
    open();
    fill("Dark mode", "Please.");
    submit();
    expect(sent()).toHaveLength(0);
    expect(error()).toBe(postErrorText("OFFLINE"));
  });

  it("is not closed by a click outside, which would lose the draft", () => {
    open();
    byId<HTMLElement>("forum-post-dialog").click();
    expect(byId("forum-post-dialog")).not.toBeNull();
  });
});

describe("New Post attachments", () => {
  const pick = async (...names: string[]): Promise<void> => {
    const input = byId<HTMLInputElement>("forum-post-file");
    Object.defineProperty(input, "files", {
      configurable: true,
      value: names.map((n) => new File(["x"], n)),
    });
    input.dispatchEvent(new Event("change"));
    await flush();
  };

  it("uploads through the composer's route and sends the ids, a file alone being enough", async () => {
    uploadFile.mockResolvedValue({ id: "up-1", url: "/f/1", filename: "a.png" });
    open();
    fill("Screenshot", "");
    await pick("a.png");
    expect(uploadFile).toHaveBeenCalledTimes(1);
    submit();
    expect(sent()[0]!.payload).toMatchObject({ content: "", attachments: ["up-1"] });
  });

  it("waits for a running upload, and a changed attachment list is a different post", async () => {
    let finish: (v: { id: string; url: string; filename: string }) => void = () => {};
    uploadFile.mockImplementation(() => new Promise((r) => (finish = r)));
    open();
    fill("Screenshot", "see");
    await pick("a.png");
    submit();
    expect(error()).toBe("Wait for the uploads to finish");
    expect(sent()).toHaveLength(0);
    finish({ id: "up-1", url: "/f/1", filename: "a.png" });
    await flush();
    submit();
    expect(sent()[0]!.payload["attachments"]).toEqual(["up-1"]);
  });

  it("releases an upload that is removed, and every upload when the dialog is cancelled", async () => {
    uploadFile
      .mockResolvedValueOnce({ id: "up-1", url: "/f/1", filename: "a.png" })
      .mockResolvedValueOnce({ id: "up-2", url: "/f/2", filename: "b.png" });
    open();
    await pick("a.png", "b.png");
    document
      .querySelectorAll<HTMLButtonElement>('[data-testid="forum-post-remove-file"]')[0]!
      .click();
    expect(discardUpload).toHaveBeenCalledWith("up-1");
    byId<HTMLButtonElement>("forum-post-cancel").click();
    expect(discardUpload).toHaveBeenCalledWith("up-2");
  });

  it("does not release the uploads of a post that was made", async () => {
    uploadFile.mockResolvedValue({ id: "up-1", url: "/f/1", filename: "a.png" });
    open();
    fill("Screenshot", "see");
    await pick("a.png");
    submit();
    ws.simulateMessage(
      "forum_post_create_ok",
      {
        thread: makePost(5),
        message_id: 1,
        client_message_id: sent()[0]!.payload["client_message_id"] as string,
      },
      sent()[0]!.id,
    );
    expect(discardUpload).not.toHaveBeenCalled();
  });

  it("hides the attach button when the server has uploads off", async () => {
    const { authStore } = await import("@stores/auth.store");
    authStore.setState((s) => ({
      ...s,
      uploadPolicy: { max_upload_bytes: 0 } as never,
    }));
    open();
    expect(byId<HTMLButtonElement>("forum-post-attach").hidden).toBe(true);
    authStore.setState((s) => ({ ...s, uploadPolicy: null }));
  });

  it("counts a late ack for an earlier attempt after the post was edited", () => {
    vi.useFakeTimers();
    open();
    fill("Dark mode", "Please.");
    submit();
    const first = sent()[0]!;
    vi.advanceTimersByTime(20_000);
    fill("Dark mode", "Please, with sugar.");
    submit();
    expect(sent()[1]!.payload["client_message_id"]).not.toBe(first.payload["client_message_id"]);
    ws.simulateMessage(
      "forum_post_create_ok",
      {
        thread: makePost(78),
        message_id: 6,
        client_message_id: first.payload["client_message_id"] as string,
      },
      "someone-else",
    );
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="forum-post-dialog"]')).toBeNull();
  });

  it("keeps the uploads when cancelled after an unconfirmed attempt, and drops them otherwise", async () => {
    vi.useFakeTimers();
    uploadFile.mockResolvedValue({ id: "up-1" });
    open();
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", {
      value: [new File(["x"], "a.png", { type: "image/png" })],
      configurable: true,
    });
    input.dispatchEvent(new Event("change"));
    await vi.advanceTimersByTimeAsync(0);
    fill("Dark mode", "");
    submit();
    expect(sent()[0]!.payload["attachments"]).toEqual(["up-1"]);
    vi.advanceTimersByTime(20_000);
    byId("forum-post-cancel").click();
    expect(discardUpload).not.toHaveBeenCalled();

    // A cancel with no attempt in doubt still releases them.
    open();
    const input2 = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input2, "files", {
      value: [new File(["x"], "b.png", { type: "image/png" })],
      configurable: true,
    });
    uploadFile.mockResolvedValue({ id: "up-2" });
    input2.dispatchEvent(new Event("change"));
    await vi.advanceTimersByTimeAsync(0);
    byId("forum-post-cancel").click();
    expect(discardUpload).toHaveBeenCalledWith("up-2");
  });

  it("tells the user when the server skipped some attachments", () => {
    const show = vi.fn();
    initToast({ show } as unknown as ToastContainer);
    open();
    fill("Dark mode", "Please.");
    submit();
    ws.simulateMessage(
      "forum_post_create_ok",
      {
        thread: makePost(79),
        message_id: 7,
        client_message_id: sent()[0]!.payload["client_message_id"] as string,
        skipped_attachment_ids: ["a", "b"],
      },
      sent()[0]!.id,
    );
    expect(show).toHaveBeenCalledWith(
      "Posted, but 2 attachments couldn't be added",
      "info",
      undefined,
    );
    teardownToast();
  });

  it("marks the title invalid while its error shows and focuses the first tag on a tag error", () => {
    seedForum({}, { require_tag: true });
    open();
    fill("", "hello");
    submit();
    expect(byId("forum-post-title").getAttribute("aria-invalid")).toBe("true");
    fill("Title", "hello");
    byId<HTMLInputElement>("forum-post-title").dispatchEvent(new Event("input"));
    expect(byId("forum-post-title").hasAttribute("aria-invalid")).toBe(false);
    submit();
    expect(document.activeElement).toBe(byId("forum-post-tag-1"));
  });
});
