// @ts-check
import base from "./stryker.config.mjs";

// One explicit file list per shard. Explicit lists (not globs) are what makes
// the union check in scripts/check-mutation-shards.mjs exact: the union of
// every shard must equal the base config's configured surface, so no file can
// silently drop out of the nightly baseline.
//
// Sizing (WP 3E-4): the 90-minute job ceiling is fixed, and Stryker ran at about
// 1500-1800 mutants per hour per shard on nightly run 38705905978 (2026-10-15),
// so each shard holds at most ~1300 mutants (~50-60 min). The per-shard figures
// below are estimates, not measurements: the mutant count measured for each
// former shard (livekit 6557, audio-media 1969, transport-auth 4742, stores 2932,
// safety-moderation 5615, lib-rest ~7034) was spread over its files by
// non-comment source lines, and files are balanced across the parts by that
// weight. Re-measure from a nightly report and rebalance if a part nears 90 min.
export const shards = {
  "livekit-1": [
    "src/features/voice/e2eeIdentity.ts",
    "src/features/voice/e2eeEpoch.ts",
    "src/features/voice/native/platform.ts",
    "src/features/voice/native/nativeRoom.ts",
    "src/features/voice/native/videoRenderer.ts",
    "src/features/voice/releaseRoom.ts",
    "src/features/voice/mediaLostNotice.ts",
    "src/features/voice/native/videoCodecs.ts",
  ], // ~1093 mutants (estimated) + videoCodecs.ts (new)
  "livekit-2": [
    "src/lib/livekitSession.ts",
    "src/features/voice/remoteTracks.ts",
    "src/features/voice/peerDecode.ts",
    "src/features/voice/native/nativeCameraTrack.ts",
    "src/features/voice/native/screenAudioTrack.ts",
    "src/features/voice/native/screenPickerSlot.ts",
    "src/features/voice/native/screenTrack.ts",
    "src/features/voice/miniPlayer.ts",
  ], // ~1091 mutants (estimated) + screenAudioTrack.ts (new)
  "livekit-3": [
    "src/lib/livekitUrlResolver.ts",
    "src/lib/screenShare.ts",
    "src/features/voice/joinRequest.ts",
    "src/features/voice/cameraMenu.ts",
    "src/features/voice/autoPlayCameras.ts",
    "src/features/voice/e2eePeerState.ts",
    "src/features/voice/native/screenPicker.ts",
    "src/features/voice/popout.ts",
  ], // ~1094 mutants (estimated)
  "livekit-4": [
    "src/lib/livekitDiagnostics.ts",
    "src/lib/livekitE2EE.ts",
    "src/features/voice/sessionState.ts",
    "src/features/voice/joinBackoff.ts",
    "src/features/voice/joinBackoffText.ts",
    "src/features/voice/dragMove.ts",
    "src/features/voice/videoCodec.ts",
    "src/features/voice/e2eeOffer.ts",
  ], // ~1091 mutants (estimated)
  "livekit-5": [
    "src/lib/roomEventHandlers.ts",
    "src/features/voice/roomLifecycle.ts",
    "src/features/voice/screenshareChange.ts",
    "src/features/voice/shareGate.ts",
    "src/features/voice/mediaEncryption.ts",
    "src/features/voice/decodeCaps.ts",
    "src/features/voice/peerVerification.ts",
    "src/features/voice/uiSounds.ts",
    "src/features/voice/moveHint.ts",
  ], // ~1094 mutants (estimated)
  "livekit-6": [
    "src/lib/livekitReconnect.ts",
    "src/features/voice/joinOrchestration.ts",
    "src/features/voice/cameraSwitch.ts",
    "src/features/voice/mediaControl.ts",
    "src/features/voice/codecSwitch.ts",
    "src/features/voice/shareSenderStats.ts",
    "src/features/voice/e2eeWorker.ts",
    "src/features/voice/native/counters.ts",
    "src/features/voice/native/devices.ts",
    "src/features/voice/native/micProbe.ts",
  ], // ~1094 mutants (estimated)
  "audio-media-1": [
    "src/lib/micProcessor.ts",
    "src/lib/audioElements.ts",
    "src/lib/inputMode.ts",
    "src/lib/noiseFloor.ts",
    "src/lib/media-visibility.ts",
  ], // ~987 mutants (estimated)
  "audio-media-2": ["src/lib/audioPipeline.ts"], // ~513 mutants (estimated); 664 lines
  "audio-media-3": [
    "src/lib/noise-suppression.ts",
    "src/lib/deviceManager.ts",
    "src/lib/ptt.ts",
    "src/lib/voiceTokenManager.ts",
  ], // ~536 mutants (estimated); 692 lines. Split from audio-media-2, which hit the 90-minute job limit at 1003/1049 mutants.
  "transport-auth-1": ["src/lib/api.ts", "src/lib/permissions.ts", "src/lib/hostValidation.ts"], // ~1182 mutants (estimated)
  "transport-auth-2": [
    "src/lib/ws.ts",
    "src/lib/rate-limiter.ts",
    "src/lib/pendingMessages.ts",
    "src/features/connection/dispatchContext.ts",
    "src/features/connection/wsHandlers.ts",
    "src/features/messaging/reactionUsers.ts",
  ], // ~1196 mutants (estimated)
  "transport-auth-3": [
    "src/lib/identity.ts",
    "src/lib/credentials.ts",
    "src/lib/httpProxy.ts",
    "src/lib/cert-reconnect.ts",
    "src/lib/connectionDiagnostics.ts",
    "src/lib/connectionStats.ts",
    "src/lib/logout.ts",
    "src/features/direct-messages/wsHandlers.ts",
    "src/features/voice/wsHandlers.ts",
  ], // ~1182 mutants (estimated)
  "transport-auth-4": [
    "src/lib/dispatcher.ts",
    "src/lib/e2eeCrypto.ts",
    "src/lib/legacyKeyMigration.ts",
    "src/lib/sessionScope.ts",
    "src/lib/session-notice.ts",
    "src/features/channels/wsHandlers.ts",
    "src/features/messaging/wsHandlers.ts",
  ], // ~1182 mutants (estimated)
  "lib-rest-1": [
    "src/components/message-list/avatar.ts",
    "src/lib/channel-mutes.ts",
    "src/lib/channel-mute-expiry.ts",
    "src/lib/gifProvider.ts",
    "src/features/updates/UpdateCheckRow.ts",
  ], // timed out at 90 min on run 38926807609 while it still held icons.ts
  "lib-rest-7": [
    "src/lib/markdown.ts",
    "src/features/updates/availableUpdate.ts",
    "src/features/whats-new/appVersion.ts",
    "src/features/whats-new/seenVersion.ts",
    "src/lib/userStatus.ts",
    "src/lib/hide-muted-channels.ts",
    "src/lib/statusTimer.ts",
    "src/lib/statusChoices.ts",
  ],
  "lib-rest-2": [
    "src/lib/autoIdle.ts",
    "src/lib/channel-navigation.ts",
    "src/lib/formatting.ts",
    "src/lib/last-channel.ts",
    "src/lib/preferences.ts",
    "src/lib/profiles.ts",
    "src/lib/reconcile.ts",
    "src/lib/timeFormat.ts",
    "src/features/whats-new/WhatsNewDialog.ts",
    "src/features/whats-new/whatsNewPrompt.ts",
    "src/lib/voiceDeafened.ts",
  ], // ~1172 mutants (estimated)
  "lib-rest-3": [
    "src/lib/call-ring.ts",
    "src/features/direct-messages/callAlerts.ts",
    "src/features/direct-messages/keptCallDms.ts",
    "src/features/direct-messages/groupMembers.ts",
    "src/lib/messageKind.ts",
    "src/lib/context-menu.ts",
    "src/features/developer-mode/developerTools.ts",
    "src/lib/dialogOpen.ts",
    "src/lib/keybindCatalog.ts",
    "src/lib/disposable.ts",
    "src/features/messaging/discordTimestamp.ts",
    "src/lib/os-motion.ts",
    "src/lib/protocolTypes.ts",
    "src/lib/savedDrafts.ts",
    "src/lib/supportBundle.ts",
  ], // ~1171 mutants (estimated)
  "lib-rest-4": [
    "src/lib/appearance.ts",
    "src/lib/color-contrast.ts",
    "src/lib/constants.ts",
    "src/lib/deep-link.ts",
    "src/lib/hostNormalize.ts",
    "src/lib/invite-navigation.ts",
    "src/lib/message-navigation.ts",
    "src/lib/modalFactory.ts",
    "src/lib/notificationSound.ts",
    "src/lib/serverCapabilities.ts",
    "src/lib/store.ts",
    "src/features/updates/updateChecker.ts",
    "src/features/whats-new/changelogSource.ts",
    "src/lib/window-state.ts",
  ], // ~1173 mutants (estimated)
  "lib-rest-5": [
    "src/lib/avatar.ts",
    "src/lib/dom.ts",
    "src/features/messaging/fileDropGuard.ts",
    "src/features/messaging/shortcodes.ts",
    "src/features/messaging/slashCommands.ts",
    "src/lib/logger.ts",
    "src/lib/logPersistence.ts",
  ], // 1249 measured with lib-rest-8 on run 38902717516, timed out at 96%
  "lib-rest-8": [
    "src/lib/mentions.ts",
    "src/lib/presence.ts",
    "src/lib/read-state.ts",
    "src/lib/themes.ts",
    "src/lib/toast.ts",
    "src/lib/trustedDomains.ts",
  ],
  "lib-rest-6": [
    "src/lib/a11y.ts",
    "src/lib/admin-panel.ts",
    "src/lib/notificationLevel.ts",
    "src/lib/notifications.ts",
    "src/lib/soundPrefs.ts",
    "src/features/unread-badge/unreadBadge.ts",
    "src/lib/safe-render.ts",
    "src/features/whats-new/changelog.ts",
    "src/lib/updater.ts",
    "src/lib/voiceJoinTrace.ts",
    "src/lib/voiceShortcuts.ts",
    "src/lib/keybinds.ts",
    "src/lib/keybindLabels.ts",
    "src/lib/globalKeys.ts",
  ], // ~1171 mutants (estimated)
  // icons.ts is a table of Lucide SVG path strings at module level. Every
  // mutant there is static, so each one re-runs the whole suite; on runs
  // 38902717516 and 38926807609 they used most of lib-rest-1's 90 minutes.
  // This shard skips static mutants (see ignoreStaticShards below).
  "lib-rest-9": ["src/lib/icons.ts"],
  "stores-1": [
    "src/stores/auth.store.ts",
    "src/stores/emoji.store.ts",
    "src/stores/members.store.ts",
    "src/features/messaging/readingAnchor.ts",
    "src/features/messaging/emojiCatalog.ts",
    "src/features/messaging/attachmentTtl.ts",
    "src/features/messaging/sendQueue-loader.ts",
    "src/features/messaging/sendQueue.ts",
  ], // timed out at 90 min on run 38957398478 while it still held voice.store.ts
  "stores-4": ["src/stores/voice.store.ts"],
  "stores-2": [
    "src/stores/blocks.store.ts",
    "src/stores/channels.store.ts",
    "src/stores/gifFavorites.store.ts",
    "src/stores/messages.store.ts",
    "src/stores/ui.store.ts",
    "src/features/messaging/messageEdits.ts",
  ], // ~974 mutants (estimated)
  "stores-3": [
    "src/stores/dm.store.ts",
    "src/features/messaging/messageModel.ts",
    "src/features/messaging/echoReconcile.ts",
    "src/features/messaging/markdownMarkers.ts",
    "src/features/messaging/messageLimits.ts",
    "src/features/messaging/inlineEdit.ts",
    "src/features/messaging/inlineEditLoader.ts",
    "src/features/messaging/liveMessages.ts",
    "src/features/messaging/historyWindows.ts",
    "src/features/messaging/reactionState.ts",
    "src/features/messaging/activeComposer.ts",
  ], // ~974 mutants (estimated)
  "safety-moderation-1": [
    "src/features/content-consent/nsfw.ts",
    "src/features/moderation/Queue.ts",
    "src/features/navigation/destinations.ts",
    "src/features/reports/safetyPane.ts",
    "src/features/safety/SafetyTab.ts",
    "src/features/settings/status.ts",
  ], // ~1122 mutants (estimated)
  "safety-moderation-2": [
    "src/features/content-consent/externalDialog.ts",
    "src/features/message-requests/view.ts",
    "src/features/moderation/AppealQueue.ts",
    "src/features/moderation/store.ts",
    "src/features/moderation/timeoutPresets.ts",
    "src/features/safety/Notices.ts",
    "src/features/safety/store.ts",
    "src/features/zoom/zoom.ts",
  ], // ~1122 mutants (estimated)
  "safety-moderation-3": [
    "src/features/content-consent/external.ts",
    "src/features/message-requests/sync.ts",
    "src/features/moderation/History.ts",
    "src/features/moderation/wsHandlers.ts",
    "src/features/navigation/contentView.ts",
    "src/features/reports/reportDialog.ts",
    "src/features/safety/Appeals.ts",
    "src/features/safety/wsHandlers.ts",
    "src/features/zoom/index.ts",
  ], // ~1125 mutants (estimated)
  "safety-moderation-4": [
    "src/features/content-consent/concealed.ts",
    "src/features/message-requests/Inbox.ts",
    "src/features/message-requests/decisions.ts",
    "src/features/message-requests/store.ts",
    "src/features/moderation/ActionForms.ts",
    "src/features/moderation/view.ts",
    "src/features/reports/myReports.ts",
    "src/features/reports/openers.ts",
  ], // ~1123 mutants (estimated)
  "safety-moderation-5": [
    "src/features/blocks/blockActions.ts",
    "src/features/safety/BlockedUsers.ts",
    "src/features/message-requests/api.ts",
    "src/features/message-requests/wsHandlers.ts",
    "src/features/moderation/AppealDetail.ts",
    "src/features/moderation/BanDialog.ts",
    "src/features/moderation/Evidence.ts",
    "src/features/moderation/Workflow.ts",
    "src/features/moderation/roleAssignment.ts",
    "src/features/moderation/api.ts",
    "src/features/messaging/emojiStill.ts",
    "src/features/profiles/openUserProfilePopup.ts",
    "src/features/settings/logoutConfirm.ts",
    "src/features/zoom/zoomKeys.ts",
  ], // ~1122 mutants (estimated)
};

// The six pre-split names stay accepted until a release carries the new matrix
// to main: the schedule runs main's copy of the workflow against dev.
const legacyNames = [
  "livekit",
  "audio-media",
  "transport-auth",
  "lib-rest",
  "stores",
  "safety-moderation",
];
export const legacy = Object.fromEntries(
  legacyNames.map((name) => [
    name,
    Object.entries(shards)
      .filter(([key]) => key.startsWith(`${name}-`))
      .flatMap(([, files]) => files),
  ]),
);

const shard = process.env.STRYKER_SHARD;
if (!shard) {
  throw new Error("STRYKER_SHARD is not set; expected one of: " + Object.keys(shards).join(", "));
}
if (!Object.hasOwn(shards, shard) && !Object.hasOwn(legacy, shard)) {
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
// Shards whose files are mostly module-level data: static mutants there cost a
// full-suite run each and test nothing a unit test could assert on.
const ignoreStaticShards = new Set(["lib-rest-9"]);

export default {
  ...base,
  mutate: shards[shard] ?? legacy[shard],
  ...(ignoreStaticShards.has(shard) ? { ignoreStatic: true } : {}),
  // The base list has no "json", so jsonReporter.fileName alone writes nothing.
  reporters: [...base.reporters, "json"],
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
