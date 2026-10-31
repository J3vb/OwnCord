import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchImageAsObjectUrl = vi.hoisted(() => vi.fn());

vi.mock("../../src/features/messaging/content/attachments", () => ({
  fetchImageAsObjectUrl,
  recoverEvictedImage: () => {},
  isSafeUrl: (url: string) => url.startsWith("https://") || url.startsWith("http://"),
  resolveServerUrl: (url: string) => (url.startsWith("http") ? url : `https://server.test${url}`),
}));

import { useDmSidebarHost } from "../helpers/dmSidebarHost";
import { buildGroupAvatarStack } from "../../src/components/DmSidebar";
import type { DmConversation } from "../../src/components/DmSidebar";
import {
  cropGroupIcon,
  removeGroupIcon,
  uploadGroupIcon,
} from "../../src/features/direct-messages/groupIcon";
import { ApiClientError, type ApiClient } from "../../src/lib/api";
import { buildDmConversations } from "../../src/pages/main-page/SidebarDmHelpers";
import { dmStore, type DmChannel } from "../../src/stores/dm.store";

const faces = [
  { id: 2, username: "bob", avatar: null },
  { id: 3, username: "cat", avatar: null },
];

const convo = (over: Partial<DmConversation> = {}): DmConversation => ({
  channelId: 7,
  userId: 2,
  username: "Crew",
  avatar: null,
  status: "online",
  lastMessage: "",
  timestamp: "",
  unread: false,
  isGroup: true,
  participants: faces,
  ...over,
});

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => fetchImageAsObjectUrl.mockReset());

async function mountStackWithIcon() {
  const host = document.createElement("div");
  const stack = buildGroupAvatarStack(7, faces, "Crew", "#111", undefined, "/api/v1/files/9");
  host.appendChild(stack);
  document.body.appendChild(host);
  await flush();
  return { host, stack };
}

describe("group icon — avatar stack", () => {
  it("shows the icon instead of the faces once it loads", async () => {
    fetchImageAsObjectUrl.mockResolvedValue("blob:icon");
    const { host, stack } = await mountStackWithIcon();
    expect(fetchImageAsObjectUrl).toHaveBeenCalledWith("https://server.test/api/v1/files/9");
    expect(stack.querySelector("img.dm-avatar-icon-img")?.getAttribute("src")).toBe("blob:icon");
    expect(stack.querySelectorAll(".dm-avatar-face")).toHaveLength(0);
    host.remove();
  });

  it("falls back to the faces when the icon cannot be fetched", async () => {
    fetchImageAsObjectUrl.mockResolvedValue(null);
    const { host, stack } = await mountStackWithIcon();
    expect(stack.querySelector("img")).toBeNull();
    expect(stack.querySelectorAll(".dm-avatar-face")).toHaveLength(2);
    host.remove();
  });

  it("falls back to the faces when the picture fails to decode", async () => {
    fetchImageAsObjectUrl.mockResolvedValue("blob:bad");
    const { host, stack } = await mountStackWithIcon();
    stack.querySelector("img")!.dispatchEvent(new Event("error"));
    expect(stack.querySelector("img")).toBeNull();
    expect(stack.querySelectorAll(".dm-avatar-face")).toHaveLength(2);
    host.remove();
  });

  it("draws the faces at once, without a fetch, when the icon is empty or absent", () => {
    for (const icon of ["", null]) {
      const stack = buildGroupAvatarStack(7, faces, "Crew", "#111", undefined, icon);
      expect(stack.querySelectorAll(".dm-avatar-face")).toHaveLength(2);
    }
    expect(fetchImageAsObjectUrl).not.toHaveBeenCalled();
  });
});

describe("group icon — DM list row and menu", () => {
  let container: HTMLDivElement;
  const mount = useDmSidebarHost((c) => {
    container = c;
  });

  function openMenu(): void {
    (container.querySelector(".dm-item") as HTMLElement).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }),
    );
  }

  it("the row shows the icon, and a changed icon redraws the row", async () => {
    fetchImageAsObjectUrl.mockResolvedValue("blob:one");
    const sidebar = mount([convo({ icon: "/api/v1/files/1" })]);
    await flush();
    expect(container.querySelector("img.dm-avatar-icon-img")).not.toBeNull();
    expect(container.querySelectorAll(".dm-avatar-face")).toHaveLength(0);

    sidebar.update([convo()]);
    expect(container.querySelector("img.dm-avatar-icon-img")).toBeNull();
    expect(container.querySelectorAll(".dm-avatar-face")).toHaveLength(2);
    sidebar.destroy?.();
  });

  it("offers Change only with an owner, and Remove only with an icon too", () => {
    const onChangeGroupIcon = vi.fn();
    const onRemoveGroupIcon = vi.fn();
    const actions = { onChangeGroupIcon, onRemoveGroupIcon, onToggleMute: vi.fn() };

    let sidebar = mount([convo({ hasOwner: true })], actions);
    openMenu();
    expect(document.querySelector('[data-testid="dm-change-icon-7"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="dm-remove-icon-7"]')).toBeNull();
    (document.querySelector('[data-testid="dm-change-icon-7"]') as HTMLElement).click();
    expect(onChangeGroupIcon).toHaveBeenCalledWith(7);
    sidebar.destroy?.();
    document.querySelectorAll(".context-menu").forEach((el) => el.remove());

    fetchImageAsObjectUrl.mockResolvedValue(null);
    sidebar = mount([convo({ hasOwner: true, icon: "/api/v1/files/1" })], actions);
    openMenu();
    (document.querySelector('[data-testid="dm-remove-icon-7"]') as HTMLElement).click();
    expect(onRemoveGroupIcon).toHaveBeenCalledWith(7);
    sidebar.destroy?.();
    document.querySelectorAll(".context-menu").forEach((el) => el.remove());

    // A server without owners (pre 3B-10), and a 1:1, get neither.
    for (const c of [
      convo({ icon: "/api/v1/files/1" }),
      convo({ isGroup: false, hasOwner: true }),
    ]) {
      container.replaceChildren();
      sidebar = mount([c], actions);
      openMenu();
      expect(document.querySelector('[data-testid="dm-change-icon-7"]')).toBeNull();
      expect(document.querySelector('[data-testid="dm-remove-icon-7"]')).toBeNull();
      sidebar.destroy?.();
      document.querySelectorAll(".context-menu").forEach((el) => el.remove());
    }
  });
});

describe("group icon — conversation builder", () => {
  it("carries the icon onto the row, and omits an empty one", () => {
    const user = { id: 2, username: "bob", avatar: "", status: "online", displayName: "" };
    const dm = (icon: string | undefined): DmChannel => ({
      channelId: 7,
      recipient: user,
      participants: [user],
      name: "Crew",
      isGroup: true,
      ownerId: 1,
      ...(icon !== undefined && { icon }),
      lastMessageId: null,
      lastMessage: "",
      lastMessageAt: "",
      unreadCount: 0,
      mentionCount: 0,
    });
    dmStore.setState(() => ({ channels: [dm("/api/v1/files/1")] }));
    expect(buildDmConversations(null)[0]?.icon).toBe("/api/v1/files/1");
    dmStore.setState(() => ({ channels: [dm("")] }));
    expect(buildDmConversations(null)[0]?.icon).toBeUndefined();
    dmStore.setState(() => ({ channels: [] }));
  });
});

describe("group icon — crop", () => {
  const realBitmap = globalThis.createImageBitmap;
  let drawImage: ReturnType<typeof vi.fn>;
  let toBlob: ReturnType<typeof vi.spyOn>;

  function stubCanvas(blobs: Array<Blob | null>): void {
    drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    toBlob = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb) => {
      cb(blobs.shift() ?? null);
    });
  }
  function bitmap(width: number, height: number): void {
    globalThis.createImageBitmap = vi.fn(async () => ({
      width,
      height,
      close: vi.fn(),
    })) as unknown as typeof createImageBitmap;
  }
  afterEach(() => {
    globalThis.createImageBitmap = realBitmap;
    vi.restoreAllMocks();
  });

  const png = (): File => new File(["x"], "pic.png", { type: "image/png" });

  it("centre-crops a wide image to a square and caps it at 512", async () => {
    bitmap(2000, 1000);
    stubCanvas([new Blob(["p"], { type: "image/png" })]);
    const out = await cropGroupIcon(png());
    expect(out.ok).toBe(true);
    // Source square of 1000 starting at x=500, drawn at 512x512.
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 500, 0, 1000, 1000, 0, 0, 512, 512);
    if (out.ok) expect(out.file.type).toBe("image/png");
  });

  it("keeps a small image at its own size", async () => {
    bitmap(100, 100);
    stubCanvas([new Blob(["p"], { type: "image/png" })]);
    await cropGroupIcon(png());
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 100, 100, 0, 0, 100, 100);
  });

  it("re-encodes as WebP when the PNG is over 1 MiB, and refuses if that is too big too", async () => {
    bitmap(800, 800);
    const big = new Blob([new Uint8Array(1024 * 1024 + 1)], { type: "image/png" });
    stubCanvas([big, new Blob(["w"], { type: "image/webp" })]);
    const ok = await cropGroupIcon(png());
    expect(ok.ok && ok.file.type).toBe("image/webp");

    const bigWebp = new Blob([new Uint8Array(1024 * 1024 + 1)], { type: "image/webp" });
    const bigJpeg = new Blob([new Uint8Array(1024 * 1024 + 1)], { type: "image/jpeg" });
    stubCanvas([big, bigWebp, bigJpeg]);
    const bad = await cropGroupIcon(png());
    expect(bad).toEqual({ ok: false, error: "Avatar must be at most 1024 KB." });
    expect(toBlob).toHaveBeenCalled();
  });

  it("tries JPEG after WebP, and types the file from what the browser returned", async () => {
    bitmap(800, 800);
    const big = new Blob([new Uint8Array(1024 * 1024 + 1)], { type: "image/png" });
    // WebKit cannot encode WebP and hands back a PNG again.
    stubCanvas([big, big, new Blob(["j"], { type: "image/jpeg" })]);
    const jpeg = await cropGroupIcon(png());
    expect(jpeg.ok && [jpeg.file.type, jpeg.file.name]).toEqual(["image/jpeg", "group-icon.jpg"]);

    stubCanvas([big, new Blob(["w"], { type: "image/png" })]);
    const png2 = await cropGroupIcon(png());
    expect(png2.ok && [png2.file.type, png2.file.name]).toEqual(["image/png", "group-icon.png"]);
  });

  it("rejects a wrong type, an undecodable image and a failed encode with the avatar texts", async () => {
    expect(await cropGroupIcon(new File(["x"], "a.gif", { type: "image/gif" }))).toEqual({
      ok: false,
      error: "Avatar must be a PNG, JPEG or WebP image.",
    });

    globalThis.createImageBitmap = vi.fn(async () => {
      throw new Error("bad");
    }) as unknown as typeof createImageBitmap;
    expect(await cropGroupIcon(png())).toEqual({
      ok: false,
      error: "That file could not be read as an image.",
    });

    bitmap(50, 50);
    stubCanvas([null]);
    expect(await cropGroupIcon(png())).toEqual({
      ok: false,
      error: "That file could not be read as an image.",
    });
  });
});

describe("group icon — upload and remove", () => {
  const apiWith = (over: Partial<ApiClient>): ApiClient => over as ApiClient;
  const realBitmap = globalThis.createImageBitmap;
  afterEach(() => {
    globalThis.createImageBitmap = realBitmap;
    vi.restoreAllMocks();
  });

  function readyCanvas(): void {
    globalThis.createImageBitmap = vi.fn(async () => ({
      width: 64,
      height: 64,
      close: vi.fn(),
    })) as unknown as typeof createImageBitmap;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb) =>
      cb(new Blob(["p"], { type: "image/png" })),
    );
  }

  it("uploads the cropped file and treats 200 and 204 alike as success", async () => {
    readyCanvas();
    for (const answer of [{ channel_id: 7 }, undefined]) {
      const uploadGroupDmIcon = vi.fn().mockResolvedValue(answer);
      const err = await uploadGroupIcon(
        apiWith({ uploadGroupDmIcon }),
        7,
        new File(["x"], "pic.jpg", { type: "image/jpeg" }),
      );
      expect(err).toBeNull();
      const sent = uploadGroupDmIcon.mock.calls[0]![1] as File;
      expect(uploadGroupDmIcon.mock.calls[0]![0]).toBe(7);
      expect(sent.name).toBe("group-icon.png");
      expect(sent.type).toBe("image/png");
    }
  });

  it("does not call the API for an unreadable file", async () => {
    const uploadGroupDmIcon = vi.fn();
    const err = await uploadGroupIcon(
      apiWith({ uploadGroupDmIcon }),
      7,
      new File(["x"], "a.txt", { type: "text/plain" }),
    );
    expect(err).toBe("Avatar must be a PNG, JPEG or WebP image.");
    expect(uploadGroupDmIcon).not.toHaveBeenCalled();
  });

  it("turns server failures into text instead of throwing", async () => {
    readyCanvas();
    const fail = (status: number, code: string) =>
      uploadGroupIcon(
        apiWith({
          uploadGroupDmIcon: vi.fn().mockRejectedValue(new ApiClientError(status, code, "raw")),
        }),
        7,
        new File(["x"], "pic.png", { type: "image/png" }),
      );
    expect(await fail(429, "RATE_LIMITED")).toBe("Too many requests. Try again later.");
    expect(await fail(400, "INVALID_INPUT")).toBe("That file could not be read as an image.");
    expect(await fail(403, "TIMED_OUT")).toBe(
      "You're timed out and can't change this group right now",
    );
    // A 403 is not "owner only": the icon is open to every member.
    expect(await fail(403, "FORBIDDEN")).toBe("Something went wrong. Try again.");
    expect(await fail(500, "X")).toBe("Something went wrong. Try again.");
  });

  it("removes via DELETE and reports a failure as text", async () => {
    const removeGroupDmIcon = vi.fn().mockResolvedValue(undefined);
    expect(await removeGroupIcon(apiWith({ removeGroupDmIcon }), 7)).toBeNull();
    expect(removeGroupDmIcon).toHaveBeenCalledWith(7);
    removeGroupDmIcon.mockRejectedValue(new Error("offline"));
    expect(await removeGroupIcon(apiWith({ removeGroupDmIcon }), 7)).toBe(
      "Something went wrong. Try again.",
    );
  });
});
