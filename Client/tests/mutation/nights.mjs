// @ts-check
// GitHub's runners differ in speed from job to job: the same shard's dry run
// took 4:56 on one night and 7:42 on the next, and its mutation phase grew by
// the same ~1.5x. The 31 matrix jobs (fixed by main's workflow) cannot hold the
// whole surface with that much spread, so each shard tests half its files per
// night and the other half the night after. Halves are balanced by measured
// minutes. SECOND_NIGHT names the files of the second half; a file not named
// runs on the first night. SPLIT_BY_LINE files are too slow for one night, so
// their first half of lines runs on the first night and the rest on the second.
// OC_MUTATION_NIGHT=first|second|both picks by hand; otherwise the workflow
// run number decides (odd first, even second), and a local run does both.
export const SECOND_NIGHT = new Set([
  "src/features/blocks/blockActions.ts",
  "src/features/channels/categoryActions.ts",
  "src/features/channels/channelMoves.ts",
  "src/features/channels/channelRow.view.ts",
  "src/features/connection/dispatchContext.ts",
  "src/features/content-consent/external.ts",
  "src/features/content-consent/externalDialog.ts",
  "src/features/content-consent/nsfw.ts",
  "src/features/custom-themes/customTheme.ts",
  "src/features/developer-mode/developerTools.ts",
  "src/features/direct-messages/groupMembers.ts",
  "src/features/direct-messages/wsHandlers.ts",
  "src/features/forums/NewPostDialog.ts",
  "src/features/members/gameActivityLine.ts",
  "src/features/members/listeningCard.ts",
  "src/features/members/memberLayout.ts",
  "src/features/members/memberModel.ts",
  "src/features/members/memberPanel.ts",
  "src/features/message-requests/decisions.ts",
  "src/features/messaging/composerButtons.ts",
  "src/features/messaging/echoReconcile.ts",
  "src/features/messaging/fileDropGuard.ts",
  "src/features/messaging/forwardSend.ts",
  "src/features/messaging/inlineEditLoader.ts",
  "src/features/messaging/liveMessages.ts",
  "src/features/messaging/messageLimits.ts",
  "src/features/messaging/pollRequests.ts",
  "src/features/messaging/pollSend.ts",
  "src/features/messaging/reactionState.ts",
  "src/features/messaging/sendQueue.ts",
  "src/features/messaging/shortcodes.ts",
  "src/features/messaging/slashCommands.ts",
  "src/features/messaging/textPreview.ts",
  "src/features/messaging/wsHandlers.ts",
  "src/features/moderation/AppealDetail.ts",
  "src/features/moderation/BanDialog.ts",
  "src/features/moderation/api.ts",
  "src/features/moderation/roleAssignment.ts",
  "src/features/moderation/wsHandlers.ts",
  "src/features/navigation/contentView.ts",
  "src/features/profiles/avatar.ts",
  "src/features/reports/myReports.ts",
  "src/features/reports/openers.ts",
  "src/features/reports/reportDialog.ts",
  "src/features/reports/safetyPane.ts",
  "src/features/safety/BlockedUsers.ts",
  "src/features/safety/DmPrivacy.ts",
  "src/features/safety/Notices.ts",
  "src/features/safety/SafetyTab.ts",
  "src/features/safety/store.ts",
  "src/features/server-rail/joinInvite.ts",
  "src/features/server-rail/switchConfirmDialog.ts",
  "src/features/server-rail/switchConfirmPref.ts",
  "src/features/server-rail/switchServer.ts",
  "src/features/settings/logoutConfirm.ts",
  "src/features/settings/status.ts",
  "src/features/threads/threadCommands.ts",
  "src/features/threads/threadNavigation.ts",
  "src/features/updates/UpdateCheckRow.ts",
  "src/features/updates/availableUpdate.ts",
  "src/features/updates/updateChecker.ts",
  "src/features/uploads/myUploadsTab.ts",
  "src/features/voice-messages/player.ts",
  "src/features/voice-messages/recorder.ts",
  "src/features/voice-messages/wav.ts",
  "src/features/voice/cameraFlip.ts",
  "src/features/voice/cameraMenu.ts",
  "src/features/voice/decodeCaps.ts",
  "src/features/voice/dragMove.ts",
  "src/features/voice/e2eeEpoch.ts",
  "src/features/voice/e2eeIdentity.ts",
  "src/features/voice/e2eeOffer.ts",
  "src/features/voice/e2eePeerState.ts",
  "src/features/voice/e2eeWorker.ts",
  "src/features/voice/joinBackoff.ts",
  "src/features/voice/localVoiceRestore.ts",
  "src/features/voice/mediaControl.ts",
  "src/features/voice/mediaEncryption.ts",
  "src/features/voice/miniPlayer.ts",
  "src/features/voice/native/counters.ts",
  "src/features/voice/native/devices.ts",
  "src/features/voice/native/nativeLocalVideo.ts",
  "src/features/voice/native/platform.ts",
  "src/features/voice/native/screenPicker.ts",
  "src/features/voice/native/screenPickerSlot.ts",
  "src/features/voice/native/screenTrack.ts",
  "src/features/voice/native/videoCodecs.ts",
  "src/features/voice/native/videoRenderer.ts",
  "src/features/voice/peerVerification.ts",
  "src/features/voice/releaseRoom.ts",
  "src/features/voice/remoteTracks.ts",
  "src/features/voice/sessionState.ts",
  "src/features/voice/shareSenderStats.ts",
  "src/features/voice/talkButton.ts",
  "src/features/voice/uiSounds.ts",
  "src/features/voice/videoCodec.ts",
  "src/features/whats-new/appVersion.ts",
  "src/features/whats-new/changelog.ts",
  "src/features/whats-new/changelogSource.ts",
  "src/features/whats-new/seenVersion.ts",
  "src/features/whats-new/whatsNewPrompt.ts",
  "src/features/zoom/zoom.ts",
  "src/features/zoom/zoomKeys.ts",
  "src/lib/adminPanel.ts",
  "src/lib/apiAccount.ts",
  "src/lib/apiChannels.ts",
  "src/lib/apiShared.ts",
  "src/lib/constants.ts",
  "src/lib/dispatcher.ts",
  "src/lib/dmUnread.ts",
  "src/lib/dom.ts",
  "src/lib/hostPlatform.ts",
  "src/lib/icons.ts",
  "src/lib/logPersistence.ts",
  "src/lib/media/gifPager.ts",
  "src/lib/nav/channelNavigation.ts",
  "src/lib/nav/inviteNavigation.ts",
  "src/lib/net/certReconnect.ts",
  "src/lib/net/connectionDiagnostics.ts",
  "src/lib/net/hostValidation.ts",
  "src/lib/net/identityPins.ts",
  "src/lib/net/rateLimiter.ts",
  "src/lib/net/reconcile.ts",
  "src/lib/notifications.ts",
  "src/lib/pendingMessages.ts",
  "src/lib/permissions.ts",
  "src/lib/prefs/appearance.ts",
  "src/lib/prefs/gameActivityPrefs.ts",
  "src/lib/prefs/hideMutedChannels.ts",
  "src/lib/prefs/keybindLabels.ts",
  "src/lib/prefs/keybinds.ts",
  "src/lib/prefs/mediaVisibility.ts",
  "src/lib/prefs/musicActivityPrefs.ts",
  "src/lib/prefs/notificationLevel.ts",
  "src/lib/prefs/savedDrafts.ts",
  "src/lib/prefs/serverRailLayout.ts",
  "src/lib/prefs/themes.ts",
  "src/lib/presence/autoIdle.ts",
  "src/lib/presence/gameActivity.ts",
  "src/lib/presence/gameActivityBridge.ts",
  "src/lib/presence/presence.ts",
  "src/lib/presence/profiles.ts",
  "src/lib/presence/roleLookup.ts",
  "src/lib/presence/userStatus.ts",
  "src/lib/protocolTypes.ts",
  "src/lib/readState.ts",
  "src/lib/supportBundle.ts",
  "src/lib/text/colorContrast.ts",
  "src/lib/text/discordTimestamp.ts",
  "src/lib/text/ime.ts",
  "src/lib/text/messageKind.ts",
  "src/lib/text/pickedMentions.ts",
  "src/lib/text/statusChoices.ts",
  "src/lib/ui/avatar.ts",
  "src/lib/ui/backHistory.ts",
  "src/lib/ui/bottomSheet.ts",
  "src/lib/ui/dialogOpen.ts",
  "src/lib/ui/globalKeys.ts",
  "src/lib/ui/imageHeader.ts",
  "src/lib/ui/inputMode.ts",
  "src/lib/ui/modalFactory.ts",
  "src/lib/ui/osMotion.ts",
  "src/lib/ui/select.ts",
  "src/lib/ui/statusIndicator.ts",
  "src/lib/ui/swipe.ts",
  "src/lib/ui/zoomPan.ts",
  "src/lib/voice/appAudioShare.ts",
  "src/lib/voice/appAudioTrack.ts",
  "src/lib/voice/audioPipeline.ts",
  "src/lib/voice/callRing.ts",
  "src/lib/voice/connectionStats.ts",
  "src/lib/voice/h264Profile.ts",
  "src/lib/voice/livekitReconnect.ts",
  "src/lib/voice/livekitSession.ts",
  "src/lib/voice/micProcessor.ts",
  "src/lib/voice/shareDiagnostics.ts",
  "src/lib/voice/shareFlags.ts",
  "src/lib/voice/shareFps.ts",
  "src/lib/voice/videoPresets.ts",
  "src/lib/voice/videoSurface.ts",
  "src/lib/voice/voiceDeafened.ts",
  "src/lib/voice/voiceShortcuts.ts",
  "src/lib/voice/watchRequest.ts",
  "src/lib/wsConfig.ts",
  "src/stores/auth.store.ts",
  "src/stores/blocks.store.ts",
  "src/stores/dm.store.ts",
  "src/stores/emoji.store.ts",
  "src/stores/gifFavorites.store.ts",
  "src/stores/messages.store.ts",
  "src/stores/stickers.store.ts",
  "src/stores/threads.store.ts",
  "src/stores/threadsLoader.ts",
  "src/stores/ui.store.ts",
]);

export const SPLIT_BY_LINE = new Set(["src/lib/text/markdown.ts"]);

export function nightFromEnv(env) {
  const forced = env.OC_MUTATION_NIGHT;
  if (forced === "first" || forced === "second" || forced === "both") return forced;
  if (forced !== undefined)
    throw new Error(`OC_MUTATION_NIGHT must be first, second or both, got "${forced}"`);
  const run = Number.parseInt(env.GITHUB_RUN_NUMBER ?? "", 10);
  if (Number.isNaN(run)) return "both";
  return run % 2 === 1 ? "first" : "second";
}

// The second half starts at the top-level statement nearest the middle, so no
// mutated node straddles the cut (Stryker only mutates nodes wholly inside a
// range, and a node across the cut would fall in neither half).
const TOP_LEVEL_START = /^(?:export|function|async|const|let|class)\b/;

export function splitLine(text) {
  const lines = text.split("\n");
  const mid = Math.floor(lines.length / 2);
  for (let d = 0; d < lines.length; d++) {
    for (const i of [mid - d, mid + d]) {
      if (i > 0 && i < lines.length && TOP_LEVEL_START.test(lines[i])) {
        return { cut: i + 1, lines: lines.length };
      }
    }
  }
  throw new Error("no top-level statement to split at");
}

export function filesForNight(files, night, readText) {
  if (night === "both") return files;
  const out = [];
  for (const file of files) {
    if (SPLIT_BY_LINE.has(file)) {
      const { cut, lines } = splitLine(readText(file));
      out.push(night === "first" ? `${file}:1-${cut - 1}` : `${file}:${cut}-${lines}`);
    } else if (SECOND_NIGHT.has(file) === (night === "second")) {
      out.push(file);
    }
  }
  return out;
}
