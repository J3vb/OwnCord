/**
 * Opening a profile card while another is still loading: only the newest one
 * is mounted, and a card that is dropped on the way still flushes its note.
 * The real popup module is used here (loaded up front) because two imports of
 * a mocked module in flight at once never settle under the test runner.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as profileMocks from "../helpers/profilePopupMocks";
import "@components/UserProfilePopup";

const { bindings } = vi.hoisted(() => ({ bindings: [] as { destroy: () => void }[] }));
vi.mock("../../src/features/profiles/userNotes", (importOriginal) =>
  profileMocks.noteBindingSpyMock(importOriginal, bindings),
);

import {
  closeUserProfilePopup,
  openUserProfilePopup,
} from "../../src/features/profiles/openUserProfilePopup";
import { setNotesContextSource } from "../../src/features/profiles/userNotes";
import { membersStore } from "@stores/members.store";

import { signInUserOne, useOfflineNotesContext } from "../helpers/profilePopupFixtures";

const popups = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-testid="user-profile-popup"]'));
const names = (): string[] =>
  popups().map((p) => p.querySelector(".upp-username")?.textContent ?? "");
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

describe("profile card opened while another is loading", () => {
  beforeEach(() => {
    bindings.length = 0;
    signInUserOne();
    membersStore.setState((p) => ({
      ...p,
      members: new Map([
        [7, { id: 7, username: "bob", avatar: null, role: "member", status: "online" } as never],
        [8, { id: 8, username: "cat", avatar: null, role: "member", status: "online" } as never],
      ]),
    }));
    useOfflineNotesContext();
  });

  afterEach(() => {
    closeUserProfilePopup();
    setNotesContextSource(null);
    document.body.replaceChildren();
  });

  // Edge case: the person moves on to another card while the first is still loading.
  it("mounts only the newest card when a second opens before the first has loaded", async () => {
    openUserProfilePopup({ userId: 7, anchorX: 1, anchorY: 1 });
    openUserProfilePopup({ userId: 8, anchorX: 1, anchorY: 1 });
    await vi.waitFor(() => expect(popups()).toHaveLength(1));
    await settle();
    expect(names()).toEqual(["cat"]);
  });

  it("flushes the note of the card that a newer one replaced while it loaded", async () => {
    openUserProfilePopup({ userId: 7, anchorX: 1, anchorY: 1 });
    openUserProfilePopup({ userId: 8, anchorX: 1, anchorY: 1 });
    await vi.waitFor(() => expect(popups()).toHaveLength(1));
    await settle();
    expect(bindings).toHaveLength(2);
    expect(bindings[0]!.destroy).toHaveBeenCalledOnce();
    expect(bindings[1]!.destroy).not.toHaveBeenCalled();
  });

  it("keeps a newer card open when the older card's closer is called", async () => {
    const closeFirst = openUserProfilePopup({ userId: 7, anchorX: 1, anchorY: 1 });
    openUserProfilePopup({ userId: 8, anchorX: 1, anchorY: 1 });
    await vi.waitFor(() => expect(popups()).toHaveLength(1));
    closeFirst();
    expect(names()).toEqual(["cat"]);
  });
});
