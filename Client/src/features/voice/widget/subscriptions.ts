/** The store subscriptions that redraw the voice widget. */
import { voiceStore } from "@stores/voice.store";
import { channelsStore } from "@stores/channels.store";
import { dmStore } from "@stores/dm.store";
import { uiStore } from "@stores/ui.store";
import { shareBlockReason } from "../shareGate";

/** Redraw on every change the widget shows; returns the unsubscribers. */
export function subscribeVoiceWidget(render: () => void): Array<() => void> {
  const unsubs: Array<() => void> = [];
  unsubs.push(
    voiceStore.subscribeSelector(
      (s) => ({
        channelId: s.currentChannelId,
        serverMuted: s.localServerMuted,
        serverDeafened: s.localServerDeafened,
        camera: s.localCamera,
        screenshare: s.localScreenshare,
        music: s.localMusic === true,
        shareRev: s.localShareRev,
        listenOnly: s.listenOnly,
        voiceStatus: s.voiceStatus,
        encryptionDegraded: s.encryptionDegraded === true,
        phoneCallHold: s.phoneCallHold === true,
        shareBlock: shareBlockReason(s),
      }),
      render,
      (a, b) =>
        a.channelId === b.channelId &&
        a.serverMuted === b.serverMuted &&
        a.serverDeafened === b.serverDeafened &&
        a.camera === b.camera &&
        a.screenshare === b.screenshare &&
        a.music === b.music &&
        a.shareRev === b.shareRev &&
        a.listenOnly === b.listenOnly &&
        a.voiceStatus === b.voiceStatus &&
        a.encryptionDegraded === b.encryptionDegraded &&
        a.phoneCallHold === b.phoneCallHold &&
        a.shareBlock === b.shareBlock,
    ),
  );
  // Freeze controls reactively when the WS socket drops (§3 connection status).
  unsubs.push(uiStore.subscribeSelector((s) => s.connectionStatus, render));
  unsubs.push(channelsStore.subscribeSelector((s) => s.channels, render));
  // render() reads the DM call's header name from dmStore, but nothing above
  // fires when it changes — a DM rename/nickname update only touches dmStore,
  // so the header went stale for the whole call.
  unsubs.push(dmStore.subscribeSelector((s) => s.channels, render));
  return unsubs;
}
