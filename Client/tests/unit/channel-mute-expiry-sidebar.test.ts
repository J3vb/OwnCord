import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@lib/voice/livekitSession", () => ({ rePinPeerIdentity: vi.fn() }));
vi.mock("@lib/net/e2eeCrypto", () => ({
  importIdentityPublicKey: vi.fn(),
  computeKeyFingerprint: vi.fn(),
}));

import { createChannelSidebar } from "../../src/components/ChannelSidebar";
import { setChannels } from "../../src/stores/channels.store";
import { dmStore } from "../../src/stores/dm.store";
import { uiStore } from "../../src/stores/ui.store";
import { voiceStore } from "../../src/stores/voice.store";
import { invalidateMuteCache, muteChannel, setChannelMutesHost } from "@lib/prefs/channelMutes";
import { startMuteExpiryWatch } from "@lib/prefs/channelMuteExpiry";
import { resetMembersState } from "../helpers/storeResets";
import { signInAs, resetChannelsState } from "../helpers/storeSeeds";

describe("timed mute expiry redraws the sidebar", () => {
  let container: HTMLDivElement;
  let sidebar: ReturnType<typeof createChannelSidebar>;
  let stop: (() => void) | null = null;

  beforeEach(() => {
    localStorage.clear();
    setChannelMutesHost(null);
    invalidateMuteCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 17, 12, 0, 0));
    resetChannelsState();
    dmStore.setState(() => ({ channels: [] }));
    resetMembersState();
    uiStore.setState((prev) => ({ ...prev, collapsedCategories: new Set() }));
    voiceStore.setState((prev) => ({ ...prev, voiceStates: new Map() }));
    signInAs({ id: 2, username: "Member", avatar: null, role: "member" });
    container = document.createElement("div");
    document.body.appendChild(container);
    sidebar = createChannelSidebar({ onVoiceJoin: vi.fn(), onOpenCall: vi.fn() });
  });

  afterEach(() => {
    stop?.();
    stop = null;
    sidebar.destroy?.();
    container.remove();
    vi.useRealTimers();
  });

  it("the row loses its muted look when the timer ends the mute", () => {
    setChannels([
      { id: 1, name: "general", type: "text", category: "Text", position: 0, unread_count: 0 },
    ]);
    muteChannel(1, 900_000);
    sidebar.mount(container);
    stop = startMuteExpiryWatch();
    const row = (): HTMLElement => container.querySelector('[data-channel-id="1"]') as HTMLElement;
    expect(row().classList.contains("muted")).toBe(true);

    vi.advanceTimersByTime(15 * 60_000 + 1);
    expect(row().classList.contains("muted")).toBe(false);
  });
});
