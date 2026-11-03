// @ts-check
import { readFileSync } from "node:fs";
import base from "../../stryker.config.mjs";
import { filesForNight, nightFromEnv } from "./nights.mjs";

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
//
// Rebalanced by time, not count, after run 39926630674 (2026-10-23): three
// shards hit 90 min and the growth since 3E-4 left others near 2-3k mutants.
// Shards differ in speed (livekit ~16 mutants/min, transport-auth ~28), so each
// file's cost is its instrumented mutant count times its current shard's
// measured minutes per mutant. That cost moves with the file: a fast shard is
// fast because of its own files, so a file moved there keeps its old speed.
// Rebalanced that way on 2026-11-02 from run 41369336231: only shards over
// 76 min gave files away, only shards under 60 min took them, and each sits
// near 70 min including the dry run, which leaves room for the ~10 min that
// the same shard varies from night to night.
// The matrix names come from main's workflow, so only file lists move here.
export const shards = {
  "livekit-1": [
    "src/lib/hostPlatform.ts",
    "src/features/voice/native/nativeRoom.ts",
    "src/features/voice/native/nativeLocalVideo.ts",
    "src/features/voice/releaseRoom.ts",
    "src/features/voice/native/videoCodecs.ts",
  ],
  "livekit-2": [
    "src/lib/voice/livekitSession.ts",
    "src/features/voice/voiceSession.ts",
    "src/features/voice/localVoiceRestore.ts",
    "src/features/voice/remoteTracks.ts",
    "src/features/voice/native/screenPickerSlot.ts",
    "src/lib/prefs/serverRailLayout.ts",
    "src/features/voice-messages/mime.ts",
  ],
  "livekit-3": [
    "src/lib/voice/livekitUrlResolver.ts",
    "src/lib/voice/screenShare.ts",
    "src/lib/voice/videoPresets.ts",
    "src/lib/voice/appAudioTrack.ts",
    "src/features/voice/joinRequest.ts",
    "src/lib/voice/watchRequest.ts",
    "src/features/voice/backgroundCall.ts",
    "src/features/voice/talkSlot.ts",
    "src/features/voice/cameraMenu.ts",
    "src/features/voice/autoPlayCameras.ts",
    "src/lib/voice/h264Profile.ts",
    "src/lib/voice/shareFps.ts",
    "src/lib/voice/videoSurface.ts",
    "src/lib/voice/audioPipeline.ts",
    "src/lib/net/sessionScope.ts",
  ],
  "livekit-4": [
    "src/lib/voice/livekitE2EE.ts",
    "src/features/voice/sessionState.ts",
    "src/features/voice/dragMove.ts",
    "src/features/voice/videoCodec.ts",
    "src/features/voice/e2eeOffer.ts",
  ],
  "livekit-5": [
    "src/features/voice/roomLifecycle.ts",
    "src/features/voice/screenshareChange.ts",
    "src/features/voice/shareGate.ts",
    "src/features/voice/mediaEncryption.ts",
    "src/features/voice/decodeCaps.ts",
    "src/features/voice/peerVerification.ts",
    "src/features/voice/uiSounds.ts",
    "src/features/voice/moveHint.ts",
    "src/features/voice/leaveOwed.ts",
    "src/features/voice/native/screenPicker.ts",
    "src/features/voice/peerDecode.ts",
    "src/features/voice/joinBackoff.ts",
    "src/features/voice/joinBackoffText.ts",
    "src/features/voice/talkButton.ts",
    "src/features/messaging/inlineEdit.ts",
  ],
  "livekit-6": [
    "src/lib/voice/livekitReconnect.ts",
    "src/features/voice/joinOrchestration.ts",
    "src/features/voice/cameraSwitch.ts",
    "src/features/voice/codecSwitch.ts",
    "src/features/voice/shareSenderStats.ts",
    "src/lib/voice/shareDiagnostics.ts",
    "src/lib/voice/shareFlags.ts",
    "src/features/voice/e2eeWorker.ts",
    "src/features/voice/native/counters.ts",
    "src/features/voice/native/devices.ts",
    "src/features/voice/native/micProbe.ts",
    "src/features/voice/mediaLostNotice.ts",
    "src/features/voice/native/screenTrack.ts",
    "src/features/voice/native/nativeCameraTrack.ts",
    "src/features/voice/native/screenAudioTrack.ts",
  ],
  "audio-media-1": [
    "src/lib/voice/micProcessor.ts",
    "src/lib/voice/audioElements.ts",
    "src/lib/ui/inputMode.ts",
    "src/lib/voice/noiseFloor.ts",
    "src/lib/voice/gateScale.ts",
    "src/lib/prefs/mediaVisibility.ts",
    "src/features/voice-messages/recorder.ts",
    "src/lib/voice/deviceManager.ts",
    "src/features/voice-messages/waveform.ts",
  ],
  "audio-media-2": [
    "src/lib/ui/virtualRange.ts",
    "src/features/members/memberModel.ts",
    "src/features/members/memberRow.view.ts",
    "src/lib/ui/statusIndicator.ts",
    "src/features/members/gameActivityLine.ts",
    "src/features/members/listeningLine.ts",
    "src/features/members/listeningCard.ts",
    "src/features/voice/miniPlayer.ts",
    "src/lib/voice/noiseSuppression.ts",
    "src/features/voice-messages/voiceComposer.ts",
    "src/features/voice-messages/player.ts",
    "src/lib/media/notificationSound.ts",
  ],
  "audio-media-3": [
    "src/lib/media/publicAssets.ts",
    "src/lib/ui/touchInput.ts",
    "src/lib/ui/bottomSheet.ts",
    "src/lib/ui/backHistory.ts",
    "src/lib/ui/swipe.ts",
    "src/lib/ui/zoomPan.ts",
    "src/lib/ui/savedNotice.ts",
    "src/lib/voice/ptt.ts",
    "src/lib/voice/voiceTokenManager.ts",
    "src/features/channels/voiceRow.view.ts",
    "src/features/channels/voiceRowModel.ts",
    "src/features/channels/channelMoves.ts",
    "src/features/menus/menuSheet.ts",
    "src/features/voice-messages/wav.ts",
    "src/features/voice-messages/linuxMic.ts",
    "src/features/voice/cameraFlip.ts",
    "src/features/profiles/banner.ts",
    "src/features/blocks/blockActions.ts",
  ],
  "transport-auth-1": [
    "src/lib/api.ts",
    "src/lib/apiAccount.ts",
    "src/lib/apiAdmin.ts",
    "src/lib/apiChannels.ts",
    "src/lib/apiDms.ts",
    "src/lib/permissions.ts",
    "src/lib/net/hostValidation.ts",
    "src/features/voice/e2eeEpoch.ts",
    "src/features/voice/e2eeIdentity.ts",
    "src/lib/net/serverCapabilities.ts",
    "src/lib/net/hostNormalize.ts",
    "src/lib/nav/deepLink.ts",
    "src/lib/prefs/musicActivityPrefs.ts",
    "src/lib/net/trustedDomains.ts",
    "src/features/safety/SafetyTab.ts",
    "src/features/profiles/openUserProfilePopup.ts",
  ],
  "transport-auth-2": [
    "src/lib/ws.ts",
    "src/lib/wsConfig.ts",
    "src/lib/net/rateLimiter.ts",
    "src/features/connection/dispatchContext.ts",
    "src/features/voice/callChatResize.ts",
    "src/features/voice/native/platform.ts",
    "src/lib/pendingMessages.ts",
    "src/features/safety/wsHandlers.ts",
    "src/features/message-requests/sync.ts",
    "src/features/moderation/wsHandlers.ts",
    "src/lib/apiShared.ts",
    "src/lib/prefs/gameActivityPrefs.ts",
    "src/lib/net/sessionNotice.ts",
  ],
  "transport-auth-3": [
    "src/lib/net/identity.ts",
    "src/lib/net/identityPins.ts",
    "src/lib/net/credentials.ts",
    "src/lib/net/httpProxy.ts",
    "src/lib/net/certReconnect.ts",
    "src/lib/net/connectionDiagnostics.ts",
    "src/lib/voice/connectionStats.ts",
    "src/features/connection/logout.ts",
    "src/features/direct-messages/wsHandlers.ts",
    "src/lib/voice/roomEventHandlers.ts",
    "src/lib/net/e2eeCrypto.ts",
    "src/lib/net/legacyKeyMigration.ts",
  ],
  "transport-auth-4": [
    "src/lib/dispatcher.ts",
    "src/lib/net/sessionRegistry.ts",
    "src/features/channels/wsHandlers.ts",
    "src/features/messaging/wsHandlers.ts",
  ],
  "lib-rest-1": [
    "src/features/profiles/avatar.ts",
    "src/lib/prefs/channelMutes.ts",
    "src/lib/media/gifPager.ts",
    "src/features/channels/channelRow.view.ts",
    "src/features/channels/channelRowModel.ts",
    "src/features/custom-themes/customThemeSection.ts",
    "src/features/messaging/textPreview.ts",
  ],
  "lib-rest-7": [
    "src/lib/text/markdown.ts",
    "src/features/updates/availableUpdate.ts",
    "src/features/whats-new/appVersion.ts",
    "src/features/whats-new/seenVersion.ts",
    "src/lib/prefs/hideMutedChannels.ts",
    "src/lib/text/statusChoices.ts",
    "src/lib/text/ime.ts",
  ],
  "lib-rest-2": [
    "src/lib/presence/autoIdle.ts",
    "src/lib/nav/channelNavigation.ts",
    "src/lib/text/formatting.ts",
    "src/lib/prefs/lastChannel.ts",
    "src/lib/presence/profiles.ts",
    "src/lib/net/reconcile.ts",
    "src/lib/ui/select.ts",
    "src/lib/text/timeFormat.ts",
    "src/features/whats-new/WhatsNewDialog.ts",
    "src/features/whats-new/whatsNewPrompt.ts",
    "src/lib/voice/voiceDeafened.ts",
    "src/lib/text/nameLimits.ts",
    "src/lib/voice/voiceJoinTrace.ts",
  ],
  "lib-rest-3": [
    "src/lib/voice/callRing.ts",
    "src/features/direct-messages/callAlerts.ts",
    "src/features/direct-messages/keptCallDms.ts",
    "src/features/direct-messages/groupExitWatch.ts",
    "src/features/direct-messages/groupMembers.ts",
    "src/features/direct-messages/groupIcon.ts",
    "src/lib/text/messageKind.ts",
    "src/lib/ui/contextMenu.ts",
    "src/features/developer-mode/developerTools.ts",
    "src/lib/ui/dialogOpen.ts",
    "src/lib/prefs/keybindCatalog.ts",
    "src/lib/disposable.ts",
    "src/lib/text/discordTimestamp.ts",
    "src/lib/ui/osMotion.ts",
    "src/lib/protocolTypes.ts",
    "src/lib/prefs/savedDrafts.ts",
    "src/lib/supportBundle.ts",
    "src/features/updates/UpdateCheckRow.ts",
    "src/lib/voice/voiceShortcuts.ts",
  ],
  "lib-rest-4": [
    "src/lib/prefs/appearance.ts",
    "src/lib/text/colorContrast.ts",
    "src/lib/constants.ts",
    "src/features/custom-themes/customTheme.ts",
    "src/lib/nav/inviteNavigation.ts",
    "src/lib/nav/messageNavigation.ts",
    "src/features/dialogs/confirmModal.ts",
    "src/lib/ui/modalFactory.ts",
    "src/lib/ui/imageCrop.ts",
    "src/lib/store.ts",
    "src/features/updates/updateChecker.ts",
    "src/features/whats-new/changelogSource.ts",
    "src/lib/prefs/windowState.ts",
    "src/features/voice/wsHandlers.ts",
    "src/lib/presence/userStatus.ts",
  ],
  "lib-rest-5": [
    "src/lib/ui/avatar.ts",
    "src/lib/ui/animatedStill.ts",
    "src/lib/dom.ts",
    "src/features/messaging/fileDropGuard.ts",
    "src/features/messaging/shortcodes.ts",
    "src/features/messaging/spoilerAttachment.ts",
    "src/features/messaging/importedAuthor.ts",
    "src/features/messaging/forwardTargets.ts",
    "src/features/messaging/forwardSend.ts",
    "src/features/messaging/forwardRequests.ts",
    "src/features/messaging/attachSheet.ts",
    "src/features/messaging/composerPlaceholder.ts",
    "src/lib/pollState.ts",
    "src/features/messaging/pollModel.ts",
    "src/features/messaging/pollSend.ts",
    "src/features/messaging/pollRequests.ts",
    "src/features/messaging/threadFrames.ts",
    "src/features/messaging/threadResume.ts",
    "src/features/threads/threadCommands.ts",
    "src/features/threads/threadNavigation.ts",
    "src/features/messaging/slashCommands.ts",
    "src/lib/logger.ts",
    "src/lib/logPersistence.ts",
  ],
  "lib-rest-8": [
    "src/lib/text/mentions.ts",
    "src/lib/text/pickedMentions.ts",
    "src/lib/presence/roleLookup.ts",
    "src/lib/presence/presence.ts",
    "src/lib/presence/gameActivity.ts",
    "src/lib/presence/gameActivityBridge.ts",
    "src/lib/presence/musicActivity.ts",
    "src/lib/readState.ts",
    "src/lib/prefs/themes.ts",
    "src/lib/ui/toast.ts",
    "src/features/voice/popout.ts",
    "src/lib/prefs/notificationLevel.ts",
    "src/lib/prefs/preferences.ts",
    "src/features/messaging/historyWindows.ts",
    "src/features/members/memberPanel.ts",
  ],
  "lib-rest-6": [
    "src/lib/ui/a11y.ts",
    "src/lib/ui/clipboard.ts",
    "src/lib/adminPanel.ts",
    "src/lib/notifications.ts",
    "src/lib/prefs/soundPrefs.ts",
    "src/features/unread-badge/unreadBadge.ts",
    "src/features/unread-badge/clearOnRead.ts",
    "src/features/unread-badge/permissionAsk.ts",
    "src/lib/text/safeRender.ts",
    "src/features/whats-new/changelog.ts",
    "src/lib/net/updater.ts",
    "src/lib/prefs/keybinds.ts",
    "src/lib/prefs/keybindLabels.ts",
    "src/lib/ui/globalKeys.ts",
    "src/features/connection/wsHandlers.ts",
    "src/lib/presence/statusTimer.ts",
    "src/features/messaging/reactionUsers.ts",
  ],
  // icons.ts is a table of Lucide SVG path strings at module level. Every
  // mutant there is static, so each one re-runs the whole suite; on runs
  // 38902717516 and 38926807609 they used most of lib-rest-1's 90 minutes.
  "lib-rest-9": [
    "src/lib/icons.ts",
    "src/lib/dmUnread.ts",
    "src/features/server-rail/joinInvite.ts",
    "src/features/server-rail/switchServer.ts",
    "src/features/server-rail/switchConfirmPref.ts",
    "src/features/server-rail/switchConfirmDialog.ts",
    "src/features/forums/forumModel.ts",
    "src/features/threads/threadAgo.ts",
    "src/features/forums/view.ts",
    "src/features/forums/ForumView.ts",
    "src/lib/ui/imageHeader.ts",
    "src/lib/prefs/channelMuteExpiry.ts",
    "src/lib/media/gifProvider.ts",
    "src/features/forums/NewPostDialog.ts",
  ],
  "stores-1": [
    "src/stores/auth.store.ts",
    "src/stores/emoji.store.ts",
    "src/stores/members.store.ts",
    "src/features/messaging/readingAnchor.ts",
    "src/features/messaging/emojiCatalog.ts",
    "src/features/messaging/attachmentTtl.ts",
    "src/features/messaging/sendQueueLoader.ts",
    "src/features/messaging/sendQueue.ts",
    "src/features/voice/e2eePeerState.ts",
    "src/lib/voice/appAudioShare.ts",
    "src/features/profiles/userNotes.ts",
    "src/stores/threadsLoader.ts",
    "src/stores/followedThreads.store.ts",
  ],
  "stores-4": ["src/stores/voice.store.ts", "src/features/voice/mediaControl.ts"],
  "stores-2": [
    "src/stores/blocks.store.ts",
    "src/stores/channels.store.ts",
    "src/stores/gifFavorites.store.ts",
    "src/stores/stickers.store.ts",
    "src/stores/messages.store.ts",
    "src/stores/ui.store.ts",
  ],
  "stores-3": [
    "src/stores/dm.store.ts",
    "src/features/messaging/messageModel.ts",
    "src/features/messaging/echoReconcile.ts",
    "src/features/messaging/messageLimits.ts",
    "src/features/messaging/inlineEditLoader.ts",
    "src/features/messaging/liveMessages.ts",
    "src/features/messaging/reactionState.ts",
    "src/features/messaging/activeComposer.ts",
    "src/features/channels/categoryActions.ts",
    "src/features/channels/collapsedMigration.ts",
    "src/features/panes/paneResize.ts",
    "src/features/message-requests/store.ts",
    "src/features/reports/openers.ts",
    "src/features/moderation/view.ts",
    "src/features/forums/ForumSettingsSection.ts",
    "src/features/messaging/messageEdits.ts",
    "src/features/messaging/markdownMarkers.ts",
  ],
  "safety-moderation-1": ["src/features/moderation/Queue.ts", "src/stores/threads.store.ts"],
  "safety-moderation-2": [
    "src/features/content-consent/externalDialog.ts",
    "src/features/message-requests/view.ts",
    "src/features/moderation/AppealQueue.ts",
    "src/features/moderation/store.ts",
    "src/features/moderation/timeoutPresets.ts",
    "src/features/safety/Notices.ts",
    "src/features/safety/store.ts",
    "src/features/zoom/zoom.ts",
    "src/features/safety/BlockedUsers.ts",
    "src/features/forums/forumSettingsModel.ts",
    "src/features/voice/incomingCallScreen.ts",
    "src/features/voice/passwordPrompt.ts",
    "src/features/voice/phoneFullscreen.ts",
    "src/features/settings/status.ts",
    "src/features/reports/safetyPane.ts",
    "src/features/content-consent/nsfw.ts",
    "src/features/navigation/destinations.ts",
  ],
  "safety-moderation-3": [
    "src/features/content-consent/external.ts",
    "src/features/moderation/History.ts",
    "src/features/navigation/contentView.ts",
    "src/features/reports/reportDialog.ts",
    "src/features/safety/Appeals.ts",
    "src/features/zoom/index.ts",
    "src/features/voice/native/videoRenderer.ts",
  ],
  "safety-moderation-4": [
    "src/features/content-consent/concealed.ts",
    "src/features/message-requests/Inbox.ts",
    "src/features/message-requests/decisions.ts",
    "src/features/reports/myReports.ts",
    "src/features/moderation/AppealDetail.ts",
    "src/lib/voice/livekitDiagnostics.ts",
  ],
  "safety-moderation-5": [
    "src/features/uploads/myUploadsTab.ts",
    "src/features/safety/DmPrivacy.ts",
    "src/features/message-requests/api.ts",
    "src/features/message-requests/wsHandlers.ts",
    "src/features/moderation/BanDialog.ts",
    "src/features/moderation/NicknameDialog.ts",
    "src/features/moderation/Evidence.ts",
    "src/features/moderation/Workflow.ts",
    "src/features/moderation/roleAssignment.ts",
    "src/features/members/memberLayout.ts",
    "src/features/moderation/api.ts",
    "src/features/messaging/emojiStill.ts",
    "src/features/messaging/composerButtons.ts",
    "src/features/settings/logoutConfirm.ts",
    "src/features/zoom/zoomKeys.ts",
    "src/features/moderation/ActionForms.ts",
  ],
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
// Every shard skips static mutants (code that runs at module load, so each one
// re-runs the whole suite). On run 40297762092 they were 3-11% of a shard's
// mutants but Stryker estimated 83-97% of its test time, and eight shards hit
// 90 min. Skipped mutants report as Ignored and leave the score's denominator.

const clientDir = new URL("../../", import.meta.url);
const readText = (file) => readFileSync(new URL(file, clientDir), "utf8");
const night = nightFromEnv(process.env);
const selected = filesForNight(shards[shard] ?? legacy[shard], night, readText);
if (selected.length === 0) throw new Error(`shard "${shard}" has no files on the ${night} night`);
if (night !== "both") console.log(`shard ${shard}: ${night} night, ${selected.length} file(s)`);

export default {
  ...base,
  mutate: selected,
  ignoreStatic: true,
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
