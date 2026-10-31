import { vi } from "vitest";
import { createChannelSidebar } from "../../src/components/ChannelSidebar";
import { dmStore } from "../../src/stores/dm.store";
import { uiStore } from "../../src/stores/ui.store";
import { voiceStore } from "../../src/stores/voice.store";
import { resetMembersState } from "./storeResets";
import { resetChannelsState, signInAs } from "./storeSeeds";

/** Empty channel, DM, member, collapse and voice state with a signed-in plain member (id 2). */
export function resetSidebarStoresAsMember(): void {
  resetChannelsState();
  dmStore.setState(() => ({ channels: [] }));
  resetMembersState();
  uiStore.setState((prev) => ({ ...prev, collapsedCategories: new Set() }));
  voiceStore.setState((prev) => ({ ...prev, voiceStates: new Map() }));
  signInAs({ id: 2, username: "Member", avatar: null, role: "member" });
}

export function createPlainChannelSidebar(): ReturnType<typeof createChannelSidebar> {
  return createChannelSidebar({ onVoiceJoin: vi.fn(), onOpenCall: vi.fn() });
}
