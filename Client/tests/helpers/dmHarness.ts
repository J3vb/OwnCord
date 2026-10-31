import { addDmChannel, dmStore } from "../../src/stores/dm.store";
import type { DmChannel, DmUser } from "../../src/stores/dm.store";
import { uiStore, type UiState } from "../../src/stores/ui.store";

export function resetUiState(overrides: Partial<UiState> = {}): void {
  uiStore.setState(() => ({
    sidebarCollapsed: false,
    memberListVisible: true,
    settingsOpen: false,
    activeModal: null,
    theme: "dark" as const,
    connectionStatus: "disconnected" as const,
    connectionDialFailed: false,
    transientError: null,
    sessionReplaced: false,
    persistentError: null,
    updateRequiredHost: null,
    collapsedCategories: new Set<string>(),
    sidebarMode: "channels" as const,
    activeDmUserId: null,
    activeView: null,
    settingsTab: null,
    ...overrides,
  }));
}

export function resetDmAndUiState(): void {
  dmStore.setState(() => ({ channels: [] }));
  resetUiState();
}

export function dmRecipient(
  id: number,
  username: string,
  status: DmUser["status"] = "online",
): DmUser {
  return { id, username, avatar: "", status };
}

export function makeDm(overrides: Partial<DmChannel> = {}): DmChannel {
  return {
    channelId: 100,
    recipient: dmRecipient(10, "Alice"),
    participants: [],
    name: "",
    isGroup: false,
    lastMessageId: null,
    lastMessage: "",
    lastMessageAt: "",
    unreadCount: 0,
    mentionCount: 0,
    ...overrides,
  };
}

/** Adds `count` one-to-one DMs: channel 100+i with recipient User{i} (id 10+i). */
export function seedUserDms(count: number): void {
  for (let i = 0; i < count; i++) {
    addDmChannel(makeDm({ channelId: 100 + i, recipient: dmRecipient(10 + i, `User${i}`) }));
  }
}

export function openContextMenuOn(target: Element | null | undefined): void {
  target?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }));
}
