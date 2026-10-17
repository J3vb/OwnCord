import { describe, it, expect, vi, beforeEach } from "vitest";

const { createPopupMock } = vi.hoisted(() => ({
  createPopupMock: vi.fn((_opts: unknown) => ({
    mount: vi.fn(),
    destroy: vi.fn(),
    isOpen: () => true,
  })),
}));
vi.mock("@components/UserProfilePopup", () => ({ createUserProfilePopup: createPopupMock }));

import { openUserProfilePopup } from "../../src/features/profiles/openUserProfilePopup";
import { resetBlocksStore, setUserBlockedByMe, setUserBlockedByThem } from "@stores/blocks.store";
import { authStore } from "@stores/auth.store";
import { membersStore } from "@stores/members.store";
import { setConnectionStatus } from "@stores/ui.store";

interface Passed {
  readonly unavailableReason?: string;
  readonly blocked?: boolean;
  readonly onToggleBlock?: (id: number, block: boolean) => void;
}

async function open(
  callbacks: Parameters<typeof openUserProfilePopup>[0]["callbacks"],
): Promise<Passed> {
  createPopupMock.mockClear();
  openUserProfilePopup({ userId: 7, anchorX: 1, anchorY: 1, ...(callbacks ? { callbacks } : {}) });
  await vi.waitFor(() => expect(createPopupMock).toHaveBeenCalled());
  return createPopupMock.mock.calls[0]![0] as Passed;
}

describe("openUserProfilePopup availability and block (WP 3B-2)", () => {
  beforeEach(() => {
    resetBlocksStore();
    setConnectionStatus("connected");
    authStore.setState((p) => ({ ...p, user: { ...(p.user as object), id: 1 } as never }));
    membersStore.setState((p) => ({
      ...p,
      members: new Map([
        [7, { id: 7, username: "bob", avatar: null, role: "member", status: "online" }],
      ]),
    }));
  });

  it("passes no reason when connected and not blocked", async () => {
    const p = await open({ onMessage: vi.fn(), onToggleBlock: vi.fn() });
    expect(p.unavailableReason).toBeUndefined();
    expect(p.blocked).toBe(false);
  });

  it("says why when disconnected", async () => {
    setConnectionStatus("reconnecting");
    expect((await open({ onMessage: vi.fn() })).unavailableReason).toMatch(/not connected/i);
  });

  it("says why when blocked either way", async () => {
    setUserBlockedByMe(7, true);
    const mine = await open({ onMessage: vi.fn(), onToggleBlock: vi.fn() });
    expect(mine.unavailableReason).toMatch(/blocked/i);
    expect(mine.blocked).toBe(true);
    resetBlocksStore();
    setUserBlockedByThem(7, true);
    const theirs = await open({ onMessage: vi.fn(), onToggleBlock: vi.fn() });
    expect(theirs.unavailableReason).toMatch(/blocked/i);
    expect(theirs.blocked).toBe(false);
  });

  it("wires Block through the caller's handler, and withholds it for yourself", async () => {
    const onToggleBlock = vi.fn();
    const p = await open({ onToggleBlock });
    p.onToggleBlock?.(7, true);
    expect(onToggleBlock).toHaveBeenCalledExactlyOnceWith(7, "bob", true);

    membersStore.setState((prev) => ({
      ...prev,
      members: new Map([
        [1, { id: 1, username: "me", avatar: null, role: "member", status: "online" }],
      ]),
    }));
    createPopupMock.mockClear();
    openUserProfilePopup({ userId: 1, anchorX: 1, anchorY: 1, callbacks: { onToggleBlock } });
    await vi.waitFor(() => expect(createPopupMock).toHaveBeenCalled());
    expect((createPopupMock.mock.calls[0]![0] as Passed).onToggleBlock).toBeUndefined();
  });
});
