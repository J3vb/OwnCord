import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const reportListScroll = vi.hoisted(() => vi.fn());

vi.mock("../../../src/features/profiles/avatar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/profiles/avatar")>()),
  reportListScroll,
}));

const { createMemberList } = await import("../../../src/features/members/MemberList");
const { resetStore, makeMember, setTestMembers, defaultOpts } =
  await import("../../helpers/memberListHarness");

describe("MemberList flying scroll report", () => {
  let scroller: HTMLDivElement;
  let list: ReturnType<typeof createMemberList>;

  beforeEach(async () => {
    resetStore();
    reportListScroll.mockReset();
    scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    Object.defineProperty(scroller, "clientHeight", { value: 800, configurable: true });
    document.body.appendChild(scroller);
    setTestMembers(
      Array.from({ length: 300 }, (_, i) => makeMember({ id: i + 1, username: `u${i}` })),
    );
    list = createMemberList(defaultOpts());
    list.mount(scroller);
    // The list finds its scroll box in its first frame.
    await vi.waitFor(() => {
      scroller.dispatchEvent(new Event("scroll"));
      expect(reportListScroll).toHaveBeenCalled();
    });
    reportListScroll.mockClear();
  });

  afterEach(() => {
    list.destroy?.();
    scroller.remove();
  });

  it("reports each scroll with the distance moved and the view height", () => {
    scroller.scrollTop = 6000;
    scroller.dispatchEvent(new Event("scroll"));

    expect(reportListScroll).toHaveBeenCalledTimes(1);
    const [distance, elapsed, viewport] = reportListScroll.mock.calls[0] as [
      number,
      number,
      number,
    ];
    expect(distance).toBe(6000);
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(viewport).toBe(800);
  });

  it("stops reporting once the list is destroyed", () => {
    list.destroy?.();
    scroller.scrollTop = 100;
    scroller.dispatchEvent(new Event("scroll"));
    expect(reportListScroll).not.toHaveBeenCalled();
  });
});
