import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openDmContextMenu,
  type DmMenuConvo,
} from "../../src/features/direct-messages/dmContextMenu";
import { setDeveloperMode } from "../helpers/message-actions-fixtures";

const convo = (overrides: Partial<DmMenuConvo> = {}): DmMenuConvo => ({
  channelId: 100,
  userId: 9,
  username: "Bob",
  isGroup: false,
  unread: false,
  muted: false,
  mutedUntil: null,
  ...overrides,
});

function openMenu(c: DmMenuConvo, actions = { onCloseDm: vi.fn() }): AbortController {
  const ac = new AbortController();
  openDmContextMenu({ convo: c, actions, confirmLeave: vi.fn(), x: 0, y: 0, signal: ac.signal });
  return ac;
}

const item = (testId: string): HTMLElement | null =>
  document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

describe("the DM row context menu", () => {
  afterEach(() => {
    setDeveloperMode(false);
    document.querySelectorAll(".context-menu").forEach((m) => m.remove());
  });

  it("opens nothing when no action applies", () => {
    const ac = new AbortController();
    openDmContextMenu({
      convo: convo(),
      actions: {},
      confirmLeave: vi.fn(),
      x: 0,
      y: 0,
      signal: ac.signal,
    });
    expect(document.body.querySelector(".context-menu")).toBeNull();
    ac.abort();
  });

  it("offers Copy User ID for a 1:1 DM only in Developer Mode", () => {
    openMenu(convo());
    expect(item("dm-copy-id-100")).toBeNull();
    document.querySelectorAll(".context-menu").forEach((m) => m.remove());

    setDeveloperMode(true);
    const ac = openMenu(convo());
    expect(item("dm-copy-id-100")?.textContent).toBe("Copy User ID");
    ac.abort();
  });

  it("never offers Copy User ID for a group, even in Developer Mode", () => {
    setDeveloperMode(true);
    const ac = openMenu(convo({ isGroup: true }));
    expect(item("dm-close-100")).not.toBeNull();
    expect(item("dm-copy-id-100")).toBeNull();
    ac.abort();
  });
});
