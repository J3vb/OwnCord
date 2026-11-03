import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeChannel } from "../../helpers/channelFactory";
import { makeDm } from "../../helpers/dmHarness";
import { openSharePicker, sharePreview } from "../../../src/features/share/SharePicker";
import { channelsStore, type Channel } from "../../../src/stores/channels.store";
import { dmStore, type DmChannel } from "../../../src/stores/dm.store";
import { resetBlocksStore } from "../../../src/stores/blocks.store";
import type { ReceivedShare } from "../../../src/platform/contracts/shareSheet";
import type { NativeFile } from "../../../src/platform/contracts/nativeFiles";

const channel = (id: number, over: Partial<Channel> = {}): Channel =>
  makeChannel({ id, name: `chan-${id}`, position: id, ...over });

function dmChannel(channelId: number): DmChannel {
  const user = { id: 7, username: "user7", avatar: "", status: "online" };
  return makeDm({ channelId, recipient: user, participants: [user] });
}

const file = (name: string): NativeFile => ({
  name,
  size: 3,
  read: async () => new File(["abc"], name),
});

let abort: AbortController;
const q = <T extends HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);
const rows = (): string[] =>
  [...document.querySelectorAll("[data-testid^=share-target-]")].map(
    (r) => r.getAttribute("data-testid") ?? "",
  );

beforeEach(() => {
  abort = new AbortController();
  resetBlocksStore();
  dmStore.setState(() => ({ channels: [dmChannel(50)] }));
  channelsStore.setState((s) => ({
    ...s,
    channels: new Map(
      [
        channel(1, { name: "general" }),
        channel(2, { name: "read-only", canSend: false }),
        channel(3, { name: "voice", type: "voice" }),
        channel(4, { name: "gaming" }),
      ].map((c) => [c.id, c]),
    ),
  }));
});
afterEach(() => {
  abort.abort();
  document.body.replaceChildren();
});

function open(share: ReceivedShare, onPick = vi.fn()): typeof onPick {
  openSharePicker({ share, onPick, signal: abort.signal });
  return onPick;
}

describe("SharePicker", () => {
  it("lists the channels and DMs the viewer can post in", () => {
    open({ files: [file("a.jpg")], text: "" });
    expect(rows()).toEqual(["share-target-1", "share-target-4", "share-target-50"]);
  });

  it("narrows the list by the typed name", () => {
    open({ files: [], text: "a link" });
    const search = q<HTMLInputElement>("[data-testid=share-search]")!;
    search.value = "gam";
    search.dispatchEvent(new Event("input"));
    expect(rows()).toEqual(["share-target-4"]);
  });

  it("closes and hands back the picked target", () => {
    const onPick = open({ files: [file("a.jpg"), file("b.jpg")], text: "" });
    q<HTMLButtonElement>("[data-testid=share-target-4]")!.click();
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]![0]).toMatchObject({ id: 4, name: "gaming", kind: "text" });
    expect(q("[data-testid=share-picker]")).toBeNull();
  });

  it("closes without a pick when its signal aborts (a newer share)", () => {
    const onPick = open({ files: [], text: "x" });
    abort.abort();
    expect(q("[data-testid=share-picker]")).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("says what is being sent", () => {
    expect(sharePreview({ files: [file("a.jpg")], text: "" })).toBe("1 file");
    expect(sharePreview({ files: [file("a"), file("b")], text: " https://example.com " })).toBe(
      "2 files · https://example.com",
    );
    expect(sharePreview({ files: [], text: "x".repeat(130) })).toBe(`${"x".repeat(120)}…`);
  });
});
