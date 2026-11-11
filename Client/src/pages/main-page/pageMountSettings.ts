/**
 * Main page mount step for the settings overlay and the quick switcher. The
 * overlay itself is built by features/settings; the page supplies what only
 * it owns.
 */
import { createAccountSettingsOverlay } from "../../features/settings/mountSettings";
import { uiStore } from "@stores/ui.store";
import { createQuickSwitcherManager } from "./OverlayManagers";
import { createSidebarVoiceCallbacks } from "./VoiceCallbacks";
import type { PageState, PageApi, MountScope } from "./pageState";

export function mountSettings(st: PageState, pg: PageApi, ms: MountScope): void {
  ms.settingsOverlay = createAccountSettingsOverlay({
    api: st.api,
    cacheScope: st.cacheScope,
    fallbackFocus: ms.focusReachable,
    getRetentionNotice: st.options.getRetentionNotice,
    applyPresence: (status) => pg.applyPresence(status),
  });

  ms.settingsOverlay.mount(st.root!);

  st.children.push(ms.settingsOverlay);

  // Quick switcher (Ctrl+K)
  // Don't fire while the settings panel is on top of it — same guard as
  // attachGlobalKeybinds below, reading the same source of truth.
  ms.qsManager = createQuickSwitcherManager(
    () => st.root,
    () => uiStore.getState().settingsOpen,
    // A voice row in the switcher joins voice (matching the sidebar row): a
    // pick joins, as a click on the row does. The call view's own chat
    // reaches the voice channel through navigateToChannel (callChat).
    (channelId: number) => createSidebarVoiceCallbacks(st.ws).onVoiceJoin(channelId),
    () => ms.sidebar.rememberChannel(),
    () => ms.sidebar.forgetChannel(),
  );

  st.unsubscribers.push(ms.qsManager.attach());
}
