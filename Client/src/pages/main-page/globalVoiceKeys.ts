// Mute and deafen while the app is unfocused: the native host polls the keys
// (Windows and X11 Linux) and the tray emits the same event; both run the same
// toggles as the in-app shortcuts, in a call or not.
import { desktop } from "../../platform/desktop";
import { loadGlobalShortcutVks } from "@lib/voice/voiceShortcuts";
import {
  anyTriggerBound,
  clearPortalBound,
  globalKeysErrorCode,
  portalBoundBefore,
} from "@lib/ui/globalKeys";
import { loadPref } from "@lib/prefs/preferences";
import type { PageState } from "./pageState";
import type { VoiceWidgetCallbacks } from "./VoiceCallbacks";

/** Whether the native voice-shortcut poller runs. App-wide, not per page: the
 *  poller outlives a logout or server switch, so a remount keeps standing down. */
let globalPollerActive = false;

/** The in-app handler stands down while this is true, so a press is never toggled twice. */
export function isGlobalPollerActive(): boolean {
  return globalPollerActive;
}

export function startGlobalVoiceKeys(
  st: PageState,
  actions: Pick<VoiceWidgetCallbacks, "onMuteToggle" | "onDeafenToggle">,
): void {
  st.unsubscribers.push(
    desktop.globalShortcuts.onShortcut((action) => {
      if (action === "mute") actions.onMuteToggle();
      else actions.onDeafenToggle();
    }),
  );
  // Once the poller runs it also sees the keys while the window is focused,
  // so the in-app handler stands down to avoid a double toggle. The flag is
  // set before start() so a press during startup is missed, never doubled.
  // On a Wayland session the desktop's shortcut service is the "poller": it
  // is live only once both keys are bound, so the flag follows the host's
  // status changes too (a bind, the user editing the keys, a portal restart).
  // start() runs whether or not the host says it is supported: the host
  // decides whether anything can observe keys, and on Wayland it arms the
  // portal so a press from a key the compositor itself was told to deliver
  // (Hyprland: the portal names no keys, so it never reads as bound) gets
  // through. Only the in-app stand-down follows `supported`.
  // Answers can arrive out of order (a status change during startup), so
  // only the latest query may set the flag.
  let refreshSeq = 0;
  const refreshGlobalKeys = (): void => {
    const seq = ++refreshSeq;
    void desktop.globalShortcuts
      .supported()
      .then(async (supported) => {
        if (seq !== refreshSeq || st.tornDown) return;
        globalPollerActive = supported;
        await desktop.globalShortcuts.start();
      })
      .catch(() => {
        // Not a Tauri host, or the command was refused: the tray and the in-app
        // shortcuts still work; the global key path simply is not live.
        if (seq === refreshSeq && !st.tornDown) globalPollerActive = false;
      });
  };
  refreshGlobalKeys();
  st.unsubscribers.push(desktop.globalShortcuts.onStatusChange(refreshGlobalKeys));
  // An earlier successful portal bind is restored with the saved keys; a
  // desktop that remembers the approval answers without a dialog. Nothing
  // is asked when the desktop already holds a trigger, and a dialog the
  // user cancels forgets the earlier bind, so the next start is quiet.
  void desktop.globalShortcuts
    .status()
    .then(async (status) => {
      if (st.tornDown || status.backend !== "portal" || !portalBoundBefore()) return;
      if (anyTriggerBound(status)) return;
      const keys = loadGlobalShortcutVks();
      try {
        await desktop.globalShortcuts.bindPortal({
          pttVk: loadPref<number>("pttVk", 0),
          muteVk: keys.mute,
          deafenVk: keys.deafen,
        });
      } catch (err) {
        if (globalKeysErrorCode(err) === "bind_cancelled") clearPortalBound();
        return;
      }
      if (!st.tornDown) refreshGlobalKeys();
    })
    .catch(() => {
      // The host could not answer: the keys stay as they were.
    });
  // Push the persisted rebind onto the running poller at startup, so a
  // choice made in Settings survives a restart (the native default is
  // Ctrl+Shift+M / Ctrl+Shift+D).
  const globalKeys = loadGlobalShortcutVks();
  void desktop.globalShortcuts
    .setKeys({ muteVk: globalKeys.mute, deafenVk: globalKeys.deafen })
    .catch(() => {
      // Not a Tauri host, or the command was refused: keep the native default.
    });
}
