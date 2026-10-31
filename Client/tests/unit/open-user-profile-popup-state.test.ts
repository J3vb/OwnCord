import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as profileMocks from "../helpers/profilePopupMocks";

const { createPopupMock } = vi.hoisted(() => ({
  createPopupMock: vi.fn((_opts: unknown) => ({
    mount: vi.fn(),
    destroy: vi.fn(),
    isOpen: () => true,
  })),
}));
vi.mock("@components/UserProfilePopup", () => ({ createUserProfilePopup: createPopupMock }));

// Wraps the real binding so a test can see which card flushed its note.
const { bindings } = vi.hoisted(() => ({ bindings: [] as { destroy: () => void }[] }));
vi.mock("../../src/features/profiles/userNotes", (importOriginal) =>
  profileMocks.noteBindingSpyMock(importOriginal, bindings),
);

import {
  closeUserProfilePopup,
  openUserProfilePopup,
  type OpenUserProfilePopupOptions,
} from "../../src/features/profiles/openUserProfilePopup";
import { setNotesContextSource } from "../../src/features/profiles/userNotes";
import { applyReadyCapabilities, resetServerCapabilities } from "@lib/net/serverCapabilities";
import { setRoles } from "@stores/channels.store";
import { channelsStore } from "@stores/channels.store";
import type {
  ProfileRoleControl,
  ProfileRolesControl,
  UserProfilePopupComponent,
} from "@components/UserProfilePopup";
import { Permission } from "@lib/types";
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

describe("openUserProfilePopup availability and block", () => {
  beforeEach(() => {
    resetBlocksStore();
    setConnectionStatus("connected");
    signInUserOne();
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

interface Props {
  readonly user: Record<string, unknown>;
  readonly note?: { destroy: () => void };
  readonly onNoteFlush?: () => void;
  readonly onMessage?: (id: number) => void;
  readonly onCall?: (id: number) => void;
  readonly onReport?: (id: number) => void;
  readonly onClose: () => void;
  readonly fallbackFocus?: () => HTMLElement | null;
  readonly roleControl?: ProfileRoleControl;
  readonly rolesControl?: ProfileRolesControl;
}

const flushStores = (): void => {
  authStore.flush();
  membersStore.flush();
  channelsStore.flush();
};

import { signInUserOne, useOfflineNotesContext } from "../helpers/profilePopupFixtures";

const popups = (): Props[] => createPopupMock.mock.calls.map((c) => c[0] as Props);
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

async function openFull(over: Partial<OpenUserProfilePopupOptions> = {}): Promise<Props> {
  const before = createPopupMock.mock.calls.length;
  openUserProfilePopup({ userId: 7, anchorX: 1, anchorY: 1, ...over });
  await vi.waitFor(() => expect(createPopupMock.mock.calls.length).toBeGreaterThan(before));
  return createPopupMock.mock.calls[before]![0] as Props;
}

function setMembers7(extra: Record<string, unknown> = {}): void {
  membersStore.setState((p) => ({
    ...p,
    members: new Map([
      [
        7,
        {
          id: 7,
          username: "bob",
          avatar: null,
          role: "member",
          status: "online",
          ...extra,
        } as never,
      ],
      [8, { id: 8, username: "cat", avatar: null, role: "member", status: "online" } as never],
    ]),
  }));
}

describe("openUserProfilePopup card contents and lifetime", () => {
  beforeEach(() => {
    createPopupMock.mockClear();
    bindings.length = 0;
    resetBlocksStore();
    setConnectionStatus("connected");
    signInUserOne();
    setMembers7();
  });

  afterEach(() => {
    closeUserProfilePopup();
    setNotesContextSource(null);
    resetServerCapabilities();
  });

  it("shows when the member joined only for a readable creation time", async () => {
    setMembers7({ createdAt: "2024-03-05T10:00:00Z" });
    const joined = await openFull();
    expect(String(joined.user["joinDate"])).toContain("2024");
    setMembers7({ createdAt: "not a date" });
    expect("joinDate" in (await openFull()).user).toBe(false);
    setMembers7();
    expect("joinDate" in (await openFull()).user).toBe(false);
  });

  it("passes the profile fields through, and null for the ones never set", async () => {
    const bare = (await openFull()).user;
    expect([bare["activity"], bare["listening"], bare["banner"], bare["banner_color"]]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect("about" in bare).toBe(false);
    const activity = { name: "Chess", startedAt: 5 };
    const listening = { title: "Song", artist: "Band" };
    setMembers7({ activity, listening, about: "hi", banner: "/b.png", banner_color: "#123456" });
    const full = (await openFull()).user;
    expect(full["activity"]).toEqual(activity);
    expect(full["listening"]).toEqual(listening);
    expect(full["about"]).toBe("hi");
    expect(full["banner"]).toBe("/b.png");
    expect(full["banner_color"]).toBe("#123456");
  });

  it("wires each action to the caller's handler with this member", async () => {
    const onMessage = vi.fn();
    const onCall = vi.fn();
    const onReport = vi.fn();
    const props = await openFull({ callbacks: { onMessage, onCall, onReport } });
    props.onMessage?.(7);
    props.onCall?.(7);
    props.onReport?.(7);
    expect(onMessage).toHaveBeenCalledExactlyOnceWith(7);
    expect(onCall).toHaveBeenCalledExactlyOnceWith(7);
    expect(onReport).toHaveBeenCalledExactlyOnceWith(7, "bob");
  });

  it("offers no action, reason or focus target the opener did not supply", async () => {
    const bare = await openFull();
    for (const key of [
      "onMessage",
      "onCall",
      "onReport",
      "onToggleBlock",
      "unavailableReason",
      "fallbackFocus",
      "rolesControl",
    ]) {
      expect(key in bare).toBe(false);
    }
    const target = document.createElement("button");
    const props = await openFull({ fallbackFocus: () => target });
    expect(props.fallbackFocus?.()).toBe(target);
  });

  it("withholds the person-to-person actions on the viewer's own card", async () => {
    setMembers7();
    membersStore.setState((p) => ({
      ...p,
      members: new Map([
        ...p.members,
        [1, { id: 1, username: "me", avatar: null, role: "member", status: "online" } as never],
      ]),
    }));
    useOfflineNotesContext();
    const props = await openFull({
      userId: 1,
      callbacks: { onMessage: vi.fn(), onCall: vi.fn(), onReport: vi.fn() },
    });
    for (const key of ["onMessage", "onCall", "onReport", "onToggleBlock", "note"]) {
      expect(key in props).toBe(false);
    }
  });

  it("replaces the open card, destroying the first once the second opens", async () => {
    const first = await openFull({ userId: 7 });
    const firstPopup = createPopupMock.mock.results[0]!.value as UserProfilePopupComponent;
    expect(first.user["id"]).toBe(7);
    await openFull({ userId: 8 });
    expect(firstPopup.destroy).toHaveBeenCalledOnce();
    closeUserProfilePopup();
    const secondPopup = createPopupMock.mock.results[1]!.value as UserProfilePopupComponent;
    expect(secondPopup.destroy).toHaveBeenCalledOnce();
    expect(firstPopup.destroy).toHaveBeenCalledOnce();
  });

  it("drops a card that was closed while it was still loading", async () => {
    openUserProfilePopup({ userId: 7, anchorX: 1, anchorY: 1 });
    closeUserProfilePopup();
    await settle();
    expect(createPopupMock).not.toHaveBeenCalled();
    // And a later card still opens normally.
    await openFull({ userId: 8 });
    expect(popups()).toHaveLength(1);
  });

  it("drops a card whose owner went away while it was loading, flushing its note", async () => {
    useOfflineNotesContext();
    const owner = new AbortController();
    openUserProfilePopup({ userId: 7, anchorX: 1, anchorY: 1, signal: owner.signal });
    owner.abort();
    await settle();
    expect(createPopupMock).not.toHaveBeenCalled();
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.destroy).toHaveBeenCalledOnce();
  });

  it("gives the card its note and flushes it when the card says so", async () => {
    useOfflineNotesContext();
    const props = await openFull();
    expect(props.note).toBe(bindings[0]);
    expect(props.onNoteFlush).toBeTypeOf("function");
    props.onNoteFlush?.();
    expect(bindings[0]!.destroy).toHaveBeenCalledOnce();
  });

  it("leaves a card that closed itself alone when the next one opens", async () => {
    await openFull({ userId: 7 });
    const firstPopup = createPopupMock.mock.results[0]!.value as UserProfilePopupComponent;
    popups()[0]!.onClose();
    await openFull({ userId: 8 });
    expect(firstPopup.destroy).not.toHaveBeenCalled();
  });

  it("keeps the current card when an older card reports that it closed", async () => {
    await openFull({ userId: 7 });
    await openFull({ userId: 8 });
    const secondPopup = createPopupMock.mock.results[1]!.value as UserProfilePopupComponent;
    popups()[0]!.onClose();
    await openFull({ userId: 7 });
    expect(secondPopup.destroy).toHaveBeenCalledOnce();
  });

  it("the returned closer closes its own card but not a newer one", async () => {
    const closeFirst = openUserProfilePopup({ userId: 7, anchorX: 1, anchorY: 1 });
    await vi.waitFor(() => expect(createPopupMock).toHaveBeenCalledTimes(1));
    await openFull({ userId: 8 });
    const secondPopup = createPopupMock.mock.results[1]!.value as UserProfilePopupComponent;
    closeFirst();
    expect(secondPopup.destroy).not.toHaveBeenCalled();
    const closeSecond = openUserProfilePopup({ userId: 8, anchorX: 1, anchorY: 1 });
    await vi.waitFor(() => expect(createPopupMock).toHaveBeenCalledTimes(3));
    const thirdPopup = createPopupMock.mock.results[2]!.value as UserProfilePopupComponent;
    closeSecond();
    expect(thirdPopup.destroy).toHaveBeenCalledOnce();
  });

  it("cancels a card that is still loading through its closer", async () => {
    const close = openUserProfilePopup({ userId: 7, anchorX: 1, anchorY: 1 });
    close();
    await settle();
    expect(createPopupMock).not.toHaveBeenCalled();
  });
});

describe("openUserProfilePopup role controls follow the stores", () => {
  const callbacks = {
    onChangeRole: vi.fn(async () => {}),
    onAddRole: vi.fn(async () => {}),
    onRemoveRole: vi.fn(async () => {}),
  };

  beforeEach(() => {
    createPopupMock.mockClear();
    callbacks.onChangeRole.mockClear();
    callbacks.onAddRole.mockClear();
    callbacks.onRemoveRole.mockClear();
    resetBlocksStore();
    setConnectionStatus("connected");
    setRoles([
      { id: 2, name: "admin", color: null, permissions: Permission.MANAGE_ROLES, position: 80 },
      { id: 3, name: "moderator", color: null, permissions: 0, position: 50 },
      { id: 4, name: "member", color: null, permissions: 0, position: 10 },
    ]);
    authStore.setState((p) => ({
      ...p,
      user: { ...(p.user as object), id: 1, role: "admin", role_ids: [2] } as never,
    }));
    setMembers7({ roleIds: [4] });
    applyReadyCapabilities({ multi_role: true });
    flushStores();
  });

  afterEach(() => {
    closeUserProfilePopup();
    resetServerCapabilities();
  });

  const pickerCallbacks = { onChangeRole: callbacks.onChangeRole };
  const controls: readonly [
    string,
    typeof callbacks | typeof pickerCallbacks,
    (p: Props) => { subscribe: (l: () => void) => () => void },
  ][] = [
    ["picker", pickerCallbacks, (p) => p.roleControl!],
    ["chips", callbacks, (p) => p.rolesControl!],
  ];

  describe.each(controls)("the %s", (_name, given, pick) => {
    async function subscribed(): Promise<{ listener: ReturnType<typeof vi.fn>; stop: () => void }> {
      const props = await openFull({ callbacks: given });
      const listener = vi.fn();
      const stop = pick(props).subscribe(listener);
      return { listener, stop };
    }

    it("re-reads when the member's role changes", async () => {
      const { listener } = await subscribed();
      setMembers7({ role: "moderator", roleIds: [3] });
      flushStores();
      expect(listener).toHaveBeenCalled();
    });

    it("re-reads when the viewer's role changes, or their role list", async () => {
      const { listener } = await subscribed();
      authStore.setState((p) => ({ ...p, user: { ...p.user!, role: "moderator" } }));
      flushStores();
      expect(listener).toHaveBeenCalledTimes(1);
      authStore.setState((p) => ({ ...p, user: { ...p.user!, role_ids: [12] } }));
      flushStores();
      expect(listener).toHaveBeenCalledTimes(2);
      authStore.setState((p) => ({ ...p, user: { ...p.user!, role_ids: [1, 2] } }));
      flushStores();
      expect(listener).toHaveBeenCalledTimes(3);
    });

    it("re-reads when the server's role list changes", async () => {
      const { listener } = await subscribed();
      setRoles([{ id: 9, name: "new", color: null, permissions: 0, position: 1 }]);
      flushStores();
      expect(listener).toHaveBeenCalled();
    });

    it("stays quiet when the viewer's role data is the same under another spelling", async () => {
      const { listener } = await subscribed();
      authStore.setState((p) => ({ ...p, user: { ...p.user!, role_ids: undefined as never } }));
      flushStores();
      listener.mockClear();
      authStore.setState((p) => ({ ...p, user: { ...p.user!, role_ids: [] } }));
      flushStores();
      expect(listener).not.toHaveBeenCalled();
      authStore.setState((p) => ({ ...p, user: null }));
      flushStores();
      listener.mockClear();
      authStore.setState((p) => ({ ...p, user: { id: 5, role: "" } as never }));
      flushStores();
      expect(listener).not.toHaveBeenCalled();
    });

    it("stops listening once the card unsubscribes", async () => {
      const { listener, stop } = await subscribed();
      stop();
      setMembers7({ role: "moderator", roleIds: [3] });
      authStore.setState((p) => ({ ...p, user: { ...p.user!, role: "moderator" } }));
      setRoles([{ id: 9, name: "new", color: null, permissions: 0, position: 1 }]);
      flushStores();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  it("chips re-read when the held role ids change, or the single role of an older server", async () => {
    const props = await openFull({ callbacks });
    const listener = vi.fn();
    props.rolesControl!.subscribe(listener);
    setMembers7({ roleIds: [4, 3] });
    flushStores();
    expect(listener).toHaveBeenCalledTimes(1);

    setMembers7({ roleIds: undefined, role: "member" });
    flushStores();
    listener.mockClear();
    setMembers7({ roleIds: undefined, role: "moderator" });
    flushStores();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("adds and removes a role for the member under their current handle", async () => {
    const props = await openFull({ callbacks });
    await props.rolesControl!.add(3);
    expect(callbacks.onAddRole).toHaveBeenCalledExactlyOnceWith(7, "bob", 3);
    await props.rolesControl!.remove(4);
    expect(callbacks.onRemoveRole).toHaveBeenCalledExactlyOnceWith(7, "bob", 4);
  });

  it("changes the single role under the member's current handle", async () => {
    resetServerCapabilities();
    const props = await openFull({ callbacks });
    expect(props.rolesControl).toBeUndefined();
    await props.roleControl!.change("moderator");
    expect(callbacks.onChangeRole).toHaveBeenCalledExactlyOnceWith(7, "bob", "moderator");
  });
});
