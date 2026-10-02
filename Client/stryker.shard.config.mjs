// @ts-check
import base from "./stryker.config.mjs";

// One explicit file list per shard. Explicit lists (not globs) are what makes
// the union check in scripts/check-mutation-shards.mjs exact: the union of
// every shard must equal the base config's configured surface, so no file can
// silently drop out of the nightly baseline. Mutant totals measured 2026-09-20
// are in the trailing comments; they are size hints, not assertions.
export const shards = {
  livekit: [
    "src/lib/livekitDiagnostics.ts",
    "src/lib/livekitE2EE.ts",
    "src/lib/livekitReconnect.ts",
    "src/lib/livekitSession.ts",
    "src/lib/livekitUrlResolver.ts",
    "src/lib/roomEventHandlers.ts",
    "src/lib/screenShare.ts",
    "src/features/voice/sessionState.ts",
    "src/features/voice/joinOrchestration.ts",
    "src/features/voice/roomLifecycle.ts",
    "src/features/voice/mediaControl.ts",
    "src/features/voice/remoteTracks.ts",
    "src/features/voice/e2eeIdentity.ts",
    "src/features/voice/e2eeEpoch.ts",
    "src/features/voice/e2eePeerState.ts",
    "src/features/voice/e2eeWorker.ts",
    "src/features/voice/e2eeOffer.ts",
    "src/features/voice/native/platform.ts",
    "src/features/voice/native/counters.ts",
    "src/features/voice/native/nativeRoom.ts",
    "src/features/voice/native/devices.ts",
    "src/features/voice/native/videoRenderer.ts",
    "src/features/voice/native/cameraUplink.ts",
    "src/features/voice/native/screenPicker.ts",
    "src/features/voice/native/screenPickerSlot.ts",
    "src/features/voice/native/screenTrack.ts",
    "src/features/voice/releaseRoom.ts",
  ], // 2901 mutants (before the D6 additions)
  "audio-media": [
    "src/lib/audioPipeline.ts",
    "src/lib/micProcessor.ts",
    "src/lib/audioElements.ts",
    "src/lib/noise-suppression.ts",
    "src/lib/deviceManager.ts",
    "src/lib/ptt.ts",
    "src/lib/voiceTokenManager.ts",
    "src/lib/streamPreview.ts",
    "src/lib/media-visibility.ts",
  ], // 1954 mutants
  "transport-auth": [
    "src/lib/ws.ts",
    "src/lib/api.ts",
    "src/lib/dispatcher.ts",
    "src/lib/identity.ts",
    "src/lib/e2eeCrypto.ts",
    "src/lib/credentials.ts",
    "src/lib/httpProxy.ts",
    "src/lib/cert-reconnect.ts",
    "src/lib/connectionDiagnostics.ts",
    "src/lib/connectionStats.ts",
    "src/lib/legacyKeyMigration.ts",
    "src/lib/logout.ts",
    "src/lib/permissions.ts",
    "src/lib/hostValidation.ts",
    "src/lib/rate-limiter.ts",
    "src/lib/sessionScope.ts",
    "src/lib/session-notice.ts",
    "src/lib/pendingMessages.ts",
    "src/features/connection/dispatchContext.ts",
    "src/features/connection/wsHandlers.ts",
    "src/features/direct-messages/wsHandlers.ts",
    "src/features/channels/wsHandlers.ts",
    "src/features/messaging/wsHandlers.ts",
    "src/features/messaging/reactionUsers.ts",
    "src/features/voice/wsHandlers.ts",
  ], // 3103 mutants
  "lib-rest": [
    "src/lib/a11y.ts",
    "src/lib/admin-panel.ts",
    "src/lib/appearance.ts",
    "src/lib/autoIdle.ts",
    "src/lib/avatar.ts",
    "src/components/message-list/avatar.ts",
    "src/lib/call-ring.ts",
    "src/features/direct-messages/callAlerts.ts",
    "src/lib/channel-mutes.ts",
    "src/lib/channel-navigation.ts",
    "src/lib/color-contrast.ts",
    "src/lib/constants.ts",
    "src/lib/context-menu.ts",
    "src/lib/deep-link.ts",
    "src/lib/disposable.ts",
    "src/lib/dom.ts",
    "src/lib/formatting.ts",
    "src/lib/gifProvider.ts",
    "src/lib/icons.ts",
    "src/lib/last-channel.ts",
    "src/lib/logger.ts",
    "src/lib/logPersistence.ts",
    "src/lib/markdown.ts",
    "src/lib/mentions.ts",
    "src/lib/message-navigation.ts",
    "src/lib/modalFactory.ts",
    "src/lib/notificationLevel.ts",
    "src/lib/notificationSound.ts",
    "src/lib/notifications.ts",
    "src/features/unread-badge/unreadBadge.ts",
    "src/lib/os-motion.ts",
    "src/lib/preferences.ts",
    "src/lib/presence.ts",
    "src/lib/profiles.ts",
    "src/lib/protocolTypes.ts",
    "src/lib/read-state.ts",
    "src/lib/reconcile.ts",
    "src/lib/safe-render.ts",
    "src/lib/store.ts",
    "src/lib/supportBundle.ts",
    "src/lib/themes.ts",
    "src/lib/toast.ts",
    "src/lib/updater.ts",
    "src/lib/userStatus.ts",
    "src/lib/voiceJoinTrace.ts",
    "src/lib/voiceShortcuts.ts",
    "src/lib/window-state.ts",
  ], // 2511 mutants (before the D6 additions)
  stores: [
    "src/stores/auth.store.ts",
    "src/stores/blocks.store.ts",
    "src/stores/channels.store.ts",
    "src/stores/dm.store.ts",
    "src/stores/emoji.store.ts",
    "src/stores/members.store.ts",
    "src/stores/messages.store.ts",
    "src/stores/ui.store.ts",
    "src/stores/voice.store.ts",
    "src/features/messaging/messageModel.ts",
    "src/features/messaging/echoReconcile.ts",
    "src/features/messaging/liveMessages.ts",
    "src/features/messaging/historyWindows.ts",
    "src/features/messaging/readingAnchor.ts",
    "src/features/messaging/messageEdits.ts",
    "src/features/messaging/reactionState.ts",
    "src/features/messaging/emojiCatalog.ts",
  ], // 1918 mutants
  // D6 of the check-reliability pain-points report: the safety, moderation,
  // message-request, content-consent, navigation and reports feature modules
  // were never assigned to a shard, so the nightly union check failed and the
  // mutation baseline never ran. A sixth shard keeps them out of the already
  // large shards above (the longest measured shard was ~50 min of the 90-min
  // ceiling), and every list stays explicit so the union check remains exact.
  "safety-moderation": [
    "src/features/content-consent/concealed.ts",
    "src/features/content-consent/external.ts",
    "src/features/content-consent/externalDialog.ts",
    "src/features/content-consent/nsfw.ts",
    "src/features/message-requests/Inbox.ts",
    "src/features/message-requests/api.ts",
    "src/features/message-requests/decisions.ts",
    "src/features/message-requests/store.ts",
    "src/features/message-requests/sync.ts",
    "src/features/message-requests/view.ts",
    "src/features/message-requests/wsHandlers.ts",
    "src/features/moderation/ActionForms.ts",
    "src/features/moderation/AppealDetail.ts",
    "src/features/moderation/AppealQueue.ts",
    "src/features/moderation/Evidence.ts",
    "src/features/moderation/History.ts",
    "src/features/moderation/Queue.ts",
    "src/features/moderation/Workflow.ts",
    "src/features/moderation/api.ts",
    "src/features/moderation/store.ts",
    "src/features/moderation/view.ts",
    "src/features/moderation/wsHandlers.ts",
    "src/features/navigation/contentView.ts",
    "src/features/navigation/destinations.ts",
    "src/features/reports/myReports.ts",
    "src/features/reports/openers.ts",
    "src/features/reports/reportDialog.ts",
    "src/features/reports/safetyPane.ts",
    "src/features/safety/Appeals.ts",
    "src/features/safety/Notices.ts",
    "src/features/safety/SafetyTab.ts",
    "src/features/safety/store.ts",
    "src/features/safety/wsHandlers.ts",
    "src/features/settings/status.ts",
  ], // size hint only
};

const shard = process.env.STRYKER_SHARD;
if (!shard) {
  throw new Error("STRYKER_SHARD is not set; expected one of: " + Object.keys(shards).join(", "));
}
if (!Object.prototype.hasOwnProperty.call(shards, shard)) {
  throw new Error(
    `Unknown STRYKER_SHARD "${shard}"; expected one of: ` + Object.keys(shards).join(", "),
  );
}

// Base imported so OC_ALLOW_UNPINNED_TZ survives: Stryker's vitest runner forces
// pool "threads", and the TZ-pinned blocks abort without that opt-out.
//
// Report-only: no `break`, so a score drop never fails the shard. The flip to a
// `break` threshold is gated on the error population being triaged and ~5
// consecutive nightly runs establishing the spread (see the plan, Task 5).
export default {
  ...base,
  mutate: shards[shard],
  // Per-shard report paths: parallel shard jobs (and a local serial run) each
  // keep their own report, so the workflow can upload one artifact per shard.
  htmlReporter: {
    fileName: `reports/mutation/${shard}/index.html`,
  },
  jsonReporter: {
    fileName: `reports/mutation/${shard}/mutation.json`,
  },
  thresholds: {
    high: base.thresholds.high,
    low: base.thresholds.low,
  },
};
