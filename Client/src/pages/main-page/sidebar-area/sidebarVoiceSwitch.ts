/**
 * Sidebar build step: the voice widget, the quick switcher and the server-
 * switch confirm.
 */
import { createElement } from "@lib/dom";
import { Disposable } from "@lib/disposable";
import { createLazyScreen } from "@components/lazyScreen";
import { createQuickSwitchOverlay, type QuickSwitchProfile } from "@components/QuickSwitchOverlay";
import { createVoiceWidgetCallbacks } from "../VoiceCallbacks";
import { selectDmConversation } from "../SidebarDmHelpers";
import { uiStore } from "@stores/ui.store";
import { addServer, switchToServer } from "../../../features/server-rail/switchServer";
import { shouldConfirmServerSwitch } from "../../../features/server-rail/switchConfirmPref";
import { dmStore } from "@stores/dm.store";
import { voiceStore } from "@stores/voice.store";
import { createProfileManager, createTauriBackend } from "@lib/presence/profiles";
import { log } from "./sidebarShared";
import type { SidebarScope } from "./sidebarScope";

export function mountVoiceAndSwitcher(sc: SidebarScope): void {
  // ---------------------------------------------------------------------------
  // Voice widget (always visible)
  // ---------------------------------------------------------------------------

  sc.voiceWidgetSlot = createElement("div", {});

  ({
    onDisconnect: sc.onDisconnect,
    onCameraToggle: sc.onCameraToggle,
    onScreenshareToggle: sc.onScreenshareToggle,
  } = createVoiceWidgetCallbacks(sc.ws, sc.limiters));

  /** Open the call in `channelId`: its DM, or a guild voice channel's call view. */
  sc.openCall = function openCall(channelId: number): void {
    const dm = dmStore.getState().channels.find((c) => c.channelId === channelId);
    if (dm !== undefined) {
      selectDmConversation(dm, sc.dmDeps);
      return;
    }
    // A guild voice channel: back to the server view, then its call, the
    // same as clicking the joined channel in the sidebar.
    if (uiStore.getState().sidebarMode === "channels") {
      sc.opts.onOpenCall?.();
      return;
    }
    sc.returnToChannel();
    // After the channel switch's store notification, which shows that
    // channel's chat and would close a call view opened before it.
    queueMicrotask(() => sc.opts.onOpenCall?.());
  };

  sc.voiceWidgetOptions = {
    onDisconnect: sc.onDisconnect,
    onCameraToggle: sc.onCameraToggle,
    onScreenshareToggle: sc.onScreenshareToggle,
    onOpenCall: sc.openCall,
  };

  sc.sidebarWrapper.appendChild(sc.voiceWidgetSlot);

  // The widget subscribes to the store when it mounts and renders the current
  // state, so a late mount shows a session that is already under way. It stays
  // mounted once loaded: it hides itself when the user is not in voice.
  // One loader per sidebar; the browser's module cache shares the code itself.
  sc.voiceWidgetScreen = createLazyScreen("voice-widget", () => import("@components/VoiceWidget"));

  sc.voiceWidgetRequested = false;

  // Not in `children`: the page copies that list at build, before this loads.
  sc.voiceWidget = null;

  sc.loadVoiceWidget = function loadVoiceWidget(): void {
    if (sc.voiceWidgetRequested || sc.tornDown) return;
    sc.voiceWidgetRequested = true;
    void sc.voiceWidgetScreen
      .load(() => !sc.tornDown)
      .then((mod) => {
        if (mod === null) {
          // Failed (toasted once by the loader): the next voice change retries.
          sc.voiceWidgetRequested = false;
          return;
        }
        if (sc.tornDown) return;
        sc.voiceWidget = mod.createVoiceWidget(sc.voiceWidgetOptions);
        sc.voiceWidget.mount(sc.voiceWidgetSlot);
        return;
      });
  };

  sc.unsubscribers.push(
    voiceStore.subscribeSelector(
      (state) => state.currentChannelId,
      (channelId) => {
        // A channel switch retries a failed load too.
        if (channelId !== null) sc.loadVoiceWidget();
      },
    ),
  );

  // autoJoin can set the channel before this sidebar is built.
  if (voiceStore.getState().currentChannelId !== null) sc.loadVoiceWidget();

  // ---------------------------------------------------------------------------
  // Quick-switch overlay
  // ---------------------------------------------------------------------------

  sc.openQuickSwitch = function openQuickSwitch(): void {
    if (sc.quickSwitchInstance !== null || sc.openingQuickSwitch) return;
    sc.openingQuickSwitch = true;

    const currentHost = sc.api.getConfig().host ?? "";

    // Load profiles asynchronously, then show overlay
    void (async () => {
      try {
        let profiles: readonly QuickSwitchProfile[];

        try {
          if (sc.profileManager === null) {
            sc.profileManager = createProfileManager(createTauriBackend());
          }
          await sc.profileManager.loadProfiles();
          profiles = sc.profileManager.getAll().map((p) => ({
            name: p.name,
            host: p.host,
          }));
        } catch (err) {
          log.warn("Failed to load profiles for quick-switch", err);
          profiles = [];
        }

        // Ensure we haven't been cleaned up while awaiting
        if (sc.tornDown) return;

        sc.quickSwitchInstance = createQuickSwitchOverlay({
          profiles,
          currentHost,
          onSwitch: (host, name) => {
            sc.closeQuickSwitch();
            sc.requestServerSwitch(host, name !== "" ? name : host);
          },
          onAddServer: () => {
            sc.closeQuickSwitch();
            addServer();
          },
          onClose: sc.closeQuickSwitch,
        });
        sc.quickSwitchInstance.mount(document.body);
      } finally {
        sc.openingQuickSwitch = false;
      }
    })();
  };

  // The question loads on demand; this owner closes it with the page.
  sc.switchConfirmOwner = new Disposable();

  sc.confirmingSwitch = false;

  sc.requestServerSwitch = function requestServerSwitch(host: string, name: string): void {
    if (!shouldConfirmServerSwitch()) {
      switchToServer(host);
      return;
    }
    if (sc.confirmingSwitch) return;
    sc.confirmingSwitch = true;
    void import("../../../features/server-rail/switchConfirmDialog")
      .then(({ openServerSwitchConfirm }) => {
        if (sc.tornDown) {
          sc.confirmingSwitch = false;
          return;
        }
        openServerSwitchConfirm({
          name,
          onConfirm: () => switchToServer(host),
          onClose: () => {
            sc.confirmingSwitch = false;
          },
          signal: sc.switchConfirmOwner.signal,
        });
        return;
      })
      .catch((err: unknown) => {
        sc.confirmingSwitch = false;
        // Better a switch without the question than a button that does nothing.
        log.warn("Server switch confirm failed to load", err);
        if (!sc.tornDown) switchToServer(host);
      });
  };

  sc.closeQuickSwitch = function closeQuickSwitch(): void {
    if (sc.quickSwitchInstance !== null) {
      sc.quickSwitchInstance.destroy?.();
      sc.quickSwitchInstance = null;
    }
  };
}
