/**
 * Two-line voice users (tree branch 11): under the name, what the person plays
 * or listens to. Runs on the real `ChannelSidebar` in tree mode, and checks
 * that Classic's row is the DOM it always was.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mocks from "../../helpers/channelSidebarMocks";
import { createChannelSidebar } from "../../../src/features/channels/ChannelSidebar";
import { handleGameActivityPolicy } from "../../../src/features/channels/wsGameActivity";
import { applyGameActivityPolicy } from "../../../src/lib/net/serverCapabilities";
import { channelsStore, setChannels } from "../../../src/stores/channels.store";
import {
  applyReadyActivities,
  applyReadyListening,
  membersStore,
  setMembers,
} from "../../../src/stores/members.store";
import { uiStore } from "../../../src/stores/ui.store";
import { voiceStore } from "../../../src/stores/voice.store";
import type { ReadyChannel, ReadyMember } from "../../../src/lib/types";
import { addVoiceUser, resetStores } from "../../helpers/channelSidebarHarness";

vi.mock("../../../src/features/voice/livekitSession", () => mocks.voiceLivekitSessionMock());
vi.mock("@lib/ui/toast", () => mocks.uiToastMock());
vi.mock("@lib/net/e2eeCrypto", (importOriginal) => mocks.netE2eeCryptoMock(importOriginal));
vi.mock("../../../src/features/messaging/content/attachments", (importOriginal) =>
  mocks.listAttachmentsMock(importOriginal),
);
vi.mock("../../../src/features/profiles/openUserProfilePopup", () =>
  mocks.profilesOpenUserProfilePopupMock(),
);

const VOICE = 7;
const LOUNGE: ReadyChannel = {
  id: VOICE,
  name: "lounge",
  type: "voice",
  category: "Voice",
  category_id: 5,
  position: 0,
};
const member = (id: number, username: string): ReadyMember => ({
  id,
  username,
  avatar: null,
  role: "member",
  status: "online",
});
const SONG = { title: "Says", artist: "Nils", player: "Spotify", started_at: 100, duration_ms: 0 };

let container: HTMLDivElement;
let sidebar: ReturnType<typeof createChannelSidebar> | null = null;

function mount(tree: boolean): void {
  setChannels([LOUNGE]);
  sidebar = createChannelSidebar({ tree, onVoiceJoin: vi.fn(), onOpenCall: vi.fn() });
  sidebar.mount(container);
}
const flush = (): void => {
  channelsStore.flush();
  voiceStore.flush();
  uiStore.flush();
  membersStore.flush();
};
const userRow = (id: number): HTMLElement =>
  container.querySelector<HTMLElement>(`.voice-user-item[data-voice-uid="${id}"]`)!;
const line = (id: number): string | null =>
  container.querySelector(`[data-testid="voice-activity-${id}"]`)?.textContent ?? null;

/** Rin plays a game, Marco listens to music, Kade does neither. */
function seedRoom(): void {
  setMembers([member(1, "kade"), member(2, "rin"), member(3, "marco")]);
  applyReadyActivities([{ user_id: 2, name: "Hades II", started_at: 100 }]);
  applyReadyListening([{ user_id: 3, ...SONG }]);
  addVoiceUser(VOICE, 1, "kade");
  addVoiceUser(VOICE, 2, "rin");
  addVoiceUser(VOICE, 3, "marco");
  flush();
}

beforeEach(() => {
  localStorage.clear();
  resetStores();
  applyGameActivityPolicy(true);
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  sidebar?.destroy?.();
  sidebar = null;
  container.remove();
});

describe("voice second line", () => {
  it("draws a game or music line under the name, an icon first, and none for a quiet user", () => {
    mount(true);
    seedRoom();
    expect(line(2)).toBe("Playing Hades II");
    // The full text stays readable when the line is cut short.
    expect(
      container
        .querySelector('[data-testid="voice-activity-2"] .vu-activity-text')
        ?.getAttribute("title"),
    ).toBe("Playing Hades II");
    expect(line(3)).toBe("Listening to Spotify");
    expect(line(1)).toBeNull();
    const text = userRow(2).querySelector(":scope > .vu-text")!;
    expect(Array.from(text.children).map((c) => c.className)).toEqual(["vu-name", "vu-activity"]);
    const icon = text.querySelector(".vu-activity > svg")!;
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(icon.getAttribute("width")).toBe("12");
    // A person with no line keeps today's DOM: the name is the row's own child.
    expect(userRow(1).querySelector(":scope > .vu-name")).not.toBeNull();
    expect(userRow(1).querySelector(".vu-text")).toBeNull();
  });

  it("Classic draws no second line", () => {
    mount(false);
    seedRoom();
    expect(container.querySelector(".vu-activity, .vu-text")).toBeNull();
    expect(userRow(2).querySelector(":scope > .vu-name")?.textContent).toBe("rin");
  });

  it("a game starting or stopping rebuilds that one row and keeps the list node", () => {
    mount(true);
    seedRoom();
    const list = container.querySelector(".voice-users-list");
    const kade = userRow(1);
    const rin = userRow(2);
    applyReadyActivities([
      { user_id: 2, name: "Hades II", started_at: 100 },
      { user_id: 1, name: "Celeste", started_at: 200 },
    ]);
    flush();
    expect(container.querySelector(".voice-users-list")).toBe(list);
    expect(line(1)).toBe("Playing Celeste");
    expect(userRow(1)).not.toBe(kade);
    expect(userRow(2)).toBe(rin);
  });

  it("a speaking flip leaves the row, with its second line, in place", () => {
    mount(true);
    seedRoom();
    const rin = userRow(2);
    addVoiceUser(VOICE, 2, "rin", { speaking: true });
    flush();
    expect(userRow(2)).toBe(rin);
    expect(line(2)).toBe("Playing Hades II");
  });

  it("an admin switching game activity off mid-call clears every game, rebuilding each row once and keeping the list and focus", () => {
    mount(true);
    seedRoom();
    const list = container.querySelector(".voice-users-list")!;
    userRow(2).focus();
    expect(document.activeElement).toBe(userRow(2));
    const added: string[] = [];
    const watch = new MutationObserver(() => undefined);
    watch.observe(list, { childList: true });

    handleGameActivityPolicy({ enabled: false });
    flush();
    for (const r of watch.takeRecords()) {
      for (const n of r.addedNodes) {
        if (n instanceof HTMLElement) added.push(n.dataset.voiceUid ?? "");
      }
    }
    watch.disconnect();

    expect(line(2)).toBeNull();
    expect(line(3)).toBeNull();
    // Rin and Marco lost a line and rebuilt once each; Kade had none and stays.
    expect(added.toSorted()).toEqual(["2", "3"]);
    expect(container.querySelector(".voice-users-list")).toBe(list);
    expect(document.activeElement).toBe(userRow(2));
  });
});
