/**
 * Mark Server as Read lives in the server name menu and on Shift+Esc, not as
 * an icon in the unified sidebar header.
 *
 * The header icon used to appear only while a server channel was unread. With
 * a long server name that fourth icon wrapped the header's action row onto a
 * second line, so the whole channel list jumped down as a message arrived and
 * back up as it was read, and a click aimed at one channel landed on the next.
 * The header must not change with read state.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useMountContainer } from "../helpers/mountContainer";
import * as mocks from "../helpers/sidebarAreaMocks";
import {
  lightSidebarAreaOpts,
  readStateChannels,
  resetSidebarStoresAsMember,
} from "../helpers/sidebarAreaOpts";

vi.mock("@lib/voice/livekitSession", () => mocks.rePinSessionMock());
vi.mock("@lib/net/e2eeCrypto", () => mocks.e2eeCryptoMock());
vi.mock("@lib/presence/profiles", () => mocks.presenceProfilesMock());
vi.mock("@components/UserBar", () => mocks.userBarMock());
vi.mock("@components/VoiceWidget", () => mocks.voiceWidgetMock());
vi.mock("@components/MemberList", () => mocks.memberListMock());
vi.mock("@components/QuickSwitchOverlay", () => mocks.quickSwitchOverlayMock());
vi.mock("../../src/pages/main-page/OverlayManagers", () => mocks.inviteManagerMock());

import { createSidebarArea } from "../../src/pages/main-page/SidebarArea";
import { setChannels, setRoles, channelsStore } from "../../src/stores/channels.store";
import { Permission, type ReadyChannel } from "../../src/lib/types";

const CHANNELS = readStateChannels().slice(0, 2);
const READ_ONLY = [CHANNELS[1]!];

/** The header's controls as the user meets them: what is drawn and shown. */
function headerShape(root: HTMLElement): string[] {
  const header = root.querySelector<HTMLElement>(".unified-sidebar-header");
  expect(header).not.toBeNull();
  return [...header!.querySelectorAll<HTMLElement>("button, [data-testid]")]
    .filter((el) => el.style.display !== "none" && el.style.visibility !== "hidden")
    .map((el) => el.getAttribute("data-testid") ?? el.className);
}

describe("SidebarArea — the header does not follow read state", () => {
  let container: HTMLDivElement;
  let area: ReturnType<typeof createSidebarArea>;

  useMountContainer(
    (c) => {
      container = c;
    },
    () => {
      for (const unsub of area.unsubscribers) unsub();
    },
  );

  beforeEach(() => {
    resetSidebarStoresAsMember();
    // Invite and Audit Log shown, as for a server owner: the row that wrapped.
    setRoles([
      {
        id: 2,
        name: "Member",
        color: null,
        permissions: Permission.MANAGE_INVITES | Permission.VIEW_AUDIT_LOG,
      },
    ]);
    channelsStore.flush();
  });

  function mount(channels: ReadyChannel[]): void {
    setChannels(channels);
    area = createSidebarArea(lightSidebarAreaOpts("example.com"));
    container.appendChild(area.sidebarWrapper);
  }

  it("has no Mark Server as Read control in the header", () => {
    mount(CHANNELS);

    expect(area.sidebarWrapper.querySelector('[data-testid="mark-all-read"]')).toBeNull();
    expect(
      area.sidebarWrapper.querySelector(
        '.unified-sidebar-header [aria-label="Mark Server as Read"]',
      ),
    ).toBeNull();
  });

  it("keeps the same header controls when a channel goes unread and is read again", async () => {
    mount(READ_ONLY);
    const before = headerShape(area.sidebarWrapper);

    setChannels(CHANNELS);
    await vi.waitFor(() => {
      expect(channelsStore.getState().channels.get(1)?.unreadCount).toBeGreaterThan(0);
    });
    await Promise.resolve();
    expect(headerShape(area.sidebarWrapper)).toEqual(before);

    setChannels(READ_ONLY);
    await Promise.resolve();
    await Promise.resolve();
    expect(headerShape(area.sidebarWrapper)).toEqual(before);
  });
});
