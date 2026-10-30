import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchImage = vi.hoisted(() => vi.fn<(url: string) => Promise<string | null>>());
const showStill = vi.hoisted(() => vi.fn());

vi.mock("@components/message-list/attachments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@components/message-list/attachments")>();
  return { ...actual, fetchImageAsObjectUrl: fetchImage };
});
vi.mock("../../src/features/messaging/emojiStill", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/features/messaging/emojiStill")>();
  return { ...actual, showStillFrame: showStill };
});

import { renderMessage } from "@components/message-list/renderers";
import { messageActionGates } from "@components/message-list/messageActions";
import { stickerReplyPreview } from "@components/message-list/sticker";
import type { Message } from "@stores/messages.store";
import {
  OTHER,
  ME,
  makeMessage,
  makeOpts,
  resetGateStores,
  setChannel,
  signInAs,
} from "../helpers/message-actions-fixtures";

const LIVE = { id: 3, name: "Wave", url: "/api/v1/stickers/3/image" };
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

function render(
  msg: Message,
  all: readonly Message[] = [msg],
): { el: HTMLElement; ac: AbortController } {
  const ac = new AbortController();
  return { el: renderMessage(msg, false, all, makeOpts(), ac.signal), ac };
}

describe("sticker messages", () => {
  beforeEach(() => {
    resetGateStores();
    signInAs("member");
    setChannel();
    fetchImage.mockReset();
    fetchImage.mockResolvedValue("blob:sticker-3");
    showStill.mockReset();
    document.documentElement.classList.remove("reduced-motion");
  });
  afterEach(() => {
    resetGateStores();
    document.documentElement.classList.remove("reduced-motion");
  });

  it("shows the image alone, with no text body", async () => {
    const { el } = render(makeMessage({ content: "[Sticker: Wave]", sticker: LIVE }));
    const img = el.querySelector<HTMLImageElement>(".msg-sticker-img")!;
    expect(img).not.toBeNull();
    expect(img.alt).toBe("Sticker: Wave");
    expect(el.querySelector(".msg-text")).toBeNull();
    expect(el.textContent).not.toContain("[Sticker: Wave]");
    await flush();
    expect(img.src).toBe("blob:sticker-3");
    expect(fetchImage).toHaveBeenCalledTimes(1);
  });

  it("a deleted sticker (id null) is a grey 'Deleted sticker' box, with no fetch", () => {
    const { el } = render(
      makeMessage({ content: "[Sticker: Wave]", sticker: { id: null, name: "Wave", url: null } }),
    );
    const box = el.querySelector('[data-testid="sticker-deleted"]')!;
    expect(box.textContent).toBe("Deleted sticker: Wave");
    expect(el.querySelector("img.msg-sticker-img")).toBeNull();
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it("an image the server no longer has (404) becomes the deleted box", async () => {
    fetchImage.mockResolvedValue(null);
    const { el } = render(makeMessage({ content: "[Sticker: Wave]", sticker: LIVE }));
    await flush();
    expect(el.querySelector("img.msg-sticker-img")).toBeNull();
    expect(el.querySelector('[data-testid="sticker-deleted"]')?.textContent).toBe(
      "Deleted sticker: Wave",
    );
  });

  it("plays at once when motion is not reduced", async () => {
    render(makeMessage({ sticker: LIVE }));
    await flush();
    expect(showStill).not.toHaveBeenCalled();
  });

  it("under reduced motion shows a still frame and plays only on hover or focus", async () => {
    document.documentElement.classList.add("reduced-motion");
    const { el } = render(makeMessage({ sticker: LIVE }));
    await flush();
    const host = el.querySelector<HTMLElement>(".msg-sticker")!;
    const img = el.querySelector<HTMLImageElement>(".msg-sticker-img")!;
    expect(showStill).toHaveBeenCalledWith(img, "blob:sticker-3");
    expect(img.getAttribute("src")).toBeNull();
    expect(host.tabIndex).toBe(0);

    host.dispatchEvent(new Event("mouseenter"));
    expect(img.src).toBe("blob:sticker-3");
    showStill.mockClear();
    host.dispatchEvent(new Event("mouseleave"));
    expect(showStill).toHaveBeenCalledWith(img, "blob:sticker-3");

    host.dispatchEvent(new Event("focusin"));
    expect(img.src).toBe("blob:sticker-3");
  });

  it("an aborted render never touches the image", async () => {
    const ac = new AbortController();
    const el = renderMessage(makeMessage({ sticker: LIVE }), false, [], makeOpts(), ac.signal);
    ac.abort();
    await flush();
    expect(el.querySelector<HTMLImageElement>(".msg-sticker-img")!.getAttribute("src")).toBeNull();
  });

  it("keeps reactions below the sticker", () => {
    const { el } = render(
      makeMessage({ sticker: LIVE, reactions: [{ emoji: "👍", count: 1, me: false }] }),
    );
    expect(el.querySelector(".msg-sticker")).not.toBeNull();
    expect(el.querySelector(".msg-reactions, .reaction")).not.toBeNull();
  });

  it("a failed sticker send says the sticker no longer exists", () => {
    const { el } = render(
      makeMessage({
        id: 0,
        status: "failed",
        correlationId: "c1",
        errorCode: "STICKER_NOT_FOUND",
        content: "[Sticker: Wave]",
      }),
    );
    expect(el.textContent).toContain("That sticker no longer exists");
  });

  describe("reply preview", () => {
    it("names the sticker when the parent is in the list", () => {
      const parent = makeMessage({ id: 5, content: "[Sticker: Wave]", sticker: LIVE });
      const reply = makeMessage({ id: 6, replyTo: 5, content: "nice" });
      const { el } = render(reply, [parent, reply]);
      expect(el.querySelector(".rr-text")?.textContent).toBe("Sticker: Wave");
    });

    it("names the sticker from the server snippet when the parent is outside the window", () => {
      const reply = makeMessage({
        id: 6,
        replyTo: 5,
        content: "nice",
        referencedMessage: {
          id: 5,
          user: { id: OTHER, username: "alice", avatar: null },
          content: "[Sticker: Party Blob]",
          deleted: false,
          has_attachments: false,
        },
      });
      const { el } = render(reply, [reply]);
      expect(el.querySelector(".rr-text")?.textContent).toBe("Sticker: Party Blob");
    });

    it("leaves ordinary text alone", () => {
      expect(stickerReplyPreview("hello [Sticker: x] there")).toBeNull();
      expect(stickerReplyPreview("[Sticker: Wave]")).toBe("Sticker: Wave");
    });
  });

  describe("actions", () => {
    const own = (extra: Partial<Message>): Message =>
      makeMessage({ user: { id: ME, username: "me", avatar: null }, ...extra });

    it("hides Edit and Forward for a sticker message, keeping Delete and Reply-side actions", () => {
      const opts = makeOpts({ onForwardClick: vi.fn() });
      const plain = messageActionGates(own({}), opts);
      expect(plain.edit.shown).toBe(true);
      expect(plain.forward.shown).toBe(true);
      const sticker = messageActionGates(own({ sticker: LIVE }), opts);
      expect(sticker.edit.shown).toBe(false);
      expect(sticker.forward.shown).toBe(false);
      expect(sticker.delete.shown).toBe(true);
    });

    it("hides them for a deleted sticker too", () => {
      const g = messageActionGates(
        own({ sticker: { id: null, name: "Wave", url: null } }),
        makeOpts({ onForwardClick: vi.fn() }),
      );
      expect(g.edit.shown).toBe(false);
      expect(g.forward.shown).toBe(false);
    });
  });
});
