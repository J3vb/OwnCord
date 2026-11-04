import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReceivedShare, ShareSheet } from "../../../src/platform/contracts/shareSheet";

const picker = vi.hoisted(() => ({
  opened: [] as {
    share: ReceivedShare;
    signal: AbortSignal;
    onPick: (t: { id: number }) => void;
  }[],
}));
const jump = vi.hoisted(() => vi.fn());
const send = vi.hoisted(() => vi.fn());

vi.mock("../../../src/features/share/SharePicker", () => ({
  openSharePicker: (opts: (typeof picker.opened)[number]) => picker.opened.push(opts),
}));
vi.mock("@lib/nav/messageNavigation", () => ({ jumpToMessage: jump }));
vi.mock("../../../src/features/share/shareInbox", () => ({ sendShareTo: send }));

const { startShareIn } = await import("../../../src/features/share/shareIn");

function fakeSheet(): {
  sheet: ShareSheet;
  deliver: (s: ReceivedShare) => void;
  stopped: () => boolean;
} {
  let handler: ((s: ReceivedShare) => void) | null = null;
  let stopped = false;
  return {
    sheet: {
      available: true,
      shareFile: async () => undefined,
      shareText: async () => undefined,
      onReceived(h) {
        handler = h;
        return () => {
          stopped = true;
        };
      },
    },
    deliver: (s) => handler?.(s),
    stopped: () => stopped,
  };
}

const flush = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
};

afterEach(() => {
  picker.opened = [];
  jump.mockClear();
  send.mockClear();
});

describe("startShareIn", () => {
  it("opens the sheet and sends the share to the picked chat", async () => {
    const { sheet, deliver } = fakeSheet();
    const stop = startShareIn(sheet);
    const share = { files: [], text: "hi" };
    deliver(share);
    await flush();
    expect(picker.opened).toHaveLength(1);
    picker.opened[0]!.onPick({ id: 12 });
    expect(send).toHaveBeenCalledWith(12, share);
    expect(jump).toHaveBeenCalledWith(12);
    stop();
  });

  it("closes the open sheet when a second share arrives", async () => {
    const { sheet, deliver } = fakeSheet();
    const stop = startShareIn(sheet);
    deliver({ files: [], text: "first" });
    await flush();
    deliver({ files: [], text: "second" });
    await flush();
    expect(picker.opened.map((o) => [o.share.text, o.signal.aborted])).toEqual([
      ["first", true],
      ["second", false],
    ]);
    stop();
  });

  it("unsubscribes and closes the sheet when the page goes", async () => {
    const { sheet, deliver, stopped } = fakeSheet();
    const stop = startShareIn(sheet);
    deliver({ files: [], text: "x" });
    await flush();
    stop();
    expect(stopped()).toBe(true);
    expect(picker.opened[0]!.signal.aborted).toBe(true);
  });
});
