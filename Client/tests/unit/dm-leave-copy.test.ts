import { afterEach, describe, expect, it, vi } from "vitest";
import { openLeaveConfirm, type DmMenuConvo } from "../../src/components/dmContextMenu";
import { requestsText } from "../../src/i18n/requests";

describe("leave-group confirmation copy", () => {
  it("on a server without member management, says leaving is permanent", () => {
    const body = requestsText("dm.leaveConfirmBody", { name: "Book Club" });
    expect(body).toBe("You leave Book Club. You won't be able to rejoin this group.");
    expect(body).not.toMatch(/adds you back/i);
  });

  it("on a server with member management, says someone can add you back", () => {
    const body = requestsText("dm.leaveConfirmBodyRejoin", { name: "Book Club" });
    expect(body).toBe(
      "You leave Book Club. You won't be able to rejoin unless someone adds you back.",
    );
  });
});

describe("the leave dialog picks the copy by whether the group reports an owner", () => {
  const convo = (hasOwner: boolean): DmMenuConvo => ({
    channelId: 4,
    userId: 2,
    username: "Book Club",
    isGroup: true,
    hasOwner,
    unread: false,
    muted: false,
    mutedUntil: null,
  });
  afterEach(() => {
    document.querySelectorAll('[data-testid="dm-leave-modal"]').forEach((el) => el.remove());
  });

  it.each([
    [true, "You leave Book Club. You won't be able to rejoin unless someone adds you back."],
    [false, "You leave Book Club. You won't be able to rejoin this group."],
  ])("hasOwner %s", (hasOwner, expected) => {
    const ac = new AbortController();
    const modal = openLeaveConfirm(convo(hasOwner), vi.fn(), ac.signal);
    expect(modal.overlay.querySelector(".modal-danger-text")?.textContent).toBe(expected);
    modal.destroy();
    ac.abort();
  });
});
