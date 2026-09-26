import { defineCatalog } from "./format";

/**
 * Settings copy (B9-3 Accessibility tab; B9-20 extends it): tab labels,
 * Appearance, Notifications, Text & Images, Voice & Audio, Keybinds,
 * Advanced, Logs and the connection-diagnostics panel. Loads with the lazily
 * loaded settings overlay, so none of it is in the startup chunk.
 */
export const settingsText = defineCatalog("settings", {
  "tabs.safety": "Safety",
  "tabs.account": "Account",
  "tabs.appearance": "Appearance",
  "tabs.notifications": "Notifications",
  "tabs.textImages": "Text & Images",
  "tabs.accessibility": "Accessibility",
  "tabs.voice": "Voice & Audio",
  "tabs.keybinds": "Keybinds",
  "tabs.advanced": "Advanced",
  "tabs.logs": "Logs",

  "common.unknown": "Unknown",
  "common.save": "Save",
  "common.cancel": "Cancel",

  "shell.title": "Settings",
  "shell.sections": "Settings sections",
  "shell.userSettings": "User Settings",
  "shell.appSettings": "App Settings",
  "shell.editProfile": "Edit Profile",
  "shell.logOut": "Log Out",
  "shell.esc": "ESC",

  "accessibility.reducedMotion.label": "Reduce Motion",
  "accessibility.reducedMotion.desc": "Disable animations and transitions",
  "accessibility.highContrast.label": "High Contrast",
  "accessibility.highContrast.desc": "Increase contrast for better readability",
  "accessibility.roleColors.label": "Role Colors",
  "accessibility.roleColors.desc": "Show colored usernames based on role in chat",
  "accessibility.syncOsMotion.label": "Sync with OS",
  "accessibility.syncOsMotion.desc":
    "Automatically enable reduced motion based on your OS accessibility settings",
  "accessibility.largeFont.label": "Large Font",
  "accessibility.largeFont.desc": "Use larger text throughout the app for better readability",

  "appearance.theme": "Theme",
  "appearance.fontSize": "Font Size",
  "appearance.fontSize.value": "{size}px",
  "appearance.compactMode": "Compact Mode",
  "appearance.accentColor": "Accent Color",
  "appearance.accentAria": "Custom accent color (hex)",
  "appearance.accentNote":
    "Custom colours may reduce readability; text and focus indicators fall back to a readable colour when needed, and High Contrast restores tested colours.",

  "notifications.desktop.label": "Desktop Notifications",
  "notifications.desktop.desc": "Show desktop notifications for messages",
  "notifications.permission.label": "System Notification Permission",
  "notifications.permission.granted":
    "Your system allows OwnCord to show notifications. The toggles below choose which ones.",
  "notifications.permission.denied":
    "Your system has blocked notifications from OwnCord, so the toggles below cannot deliver them. Allow notifications to change this.",
  "notifications.permission.allow": "Allow notifications",
  "notifications.permission.unknown":
    "OwnCord can't read your system notification setting. If notifications don't appear, check your system notification settings.",
  "notifications.permission.unavailable":
    "This build has no system notifier, so it cannot show desktop notifications or ask for permission.",
  "notifications.flash.label": "Flash Taskbar",
  "notifications.flash.desc": "Flash taskbar on new messages",
  "notifications.suppress.label": "Suppress @everyone",
  "notifications.suppress.desc": "Mute @everyone and @here — messages that name you still notify",
  "notifications.sounds.label": "Notification Sounds",
  "notifications.sounds.desc": "Play sounds for notifications",
  "notifications.muted.title": "Muted Channels",
  "notifications.muted.desc":
    "Muted channels never notify you, but messages that mention you still do.",
  "notifications.muted.empty": "Nothing is muted.",
  "notifications.muted.unmute": "Unmute",
  "notifications.channelFallback": "Channel {id}",

  "images.linkPreview.label": "Link Preview",
  "images.linkPreview.desc": "Show website previews for links shared in chat",
  "images.embeds.label": "Show Embeds",
  "images.embeds.desc": "Display rich embeds in chat messages",
  "images.inline.label": "Inline Attachment Preview",
  "images.inline.desc": "Automatically display images, videos, and GIFs inline",
  "images.animateGifs.label": "Animate GIFs",
  "images.animateGifs.desc":
    "Play GIF animations automatically. When disabled, GIFs show as static images",

  "keybinds.pushToTalk": "Push to Talk",
  "keybinds.clickToSet": "Click to set keybind",
  "keybinds.pttAria": "Push to Talk keybind — click to capture",
  "keybinds.notSet": "Not set",
  "keybinds.clear": "Clear",
  "keybinds.pressKey": "Press a supported key...",
  "keybinds.pttHint":
    "PTT works globally and does not hijack the key. Capture supports function keys, navigation keys, and Mouse 4/5.",
  "keybinds.navigation": "Navigation",
  "keybinds.communication": "Communication",
  "keybinds.messages": "Messages",
  "keybinds.voiceHint": "Voice shortcuts apply while you are connected to a voice channel.",
  "keybinds.formatHint":
    "Formatting shortcuts wrap the selected text while the message box has focus; Ctrl + U uploads a file everywhere else.",
  "keybinds.action.quickSwitcher": "Quick Switcher",
  "keybinds.action.searchMessages": "Search Messages",
  "keybinds.action.closeOverlay": "Close Overlay / Cancel",
  "keybinds.action.toggleMute": "Toggle Mute",
  "keybinds.action.toggleDeafen": "Toggle Deafen",
  "keybinds.action.toggleCamera": "Toggle Camera",
  "keybinds.action.uploadFile": "Upload File",
  "keybinds.action.editLastMessage": "Edit Last Message",
  "keybinds.action.bold": "Bold",
  "keybinds.action.italic": "Italic",
  "keybinds.action.underline": "Underline",
  "keybinds.key.ctrlK": "Ctrl + K",
  "keybinds.key.ctrlF": "Ctrl + F",
  "keybinds.key.escape": "Escape",
  "keybinds.key.ctrlM": "Ctrl + M",
  "keybinds.key.ctrlD": "Ctrl + D",
  "keybinds.key.ctrlShiftV": "Ctrl + Shift + V",
  "keybinds.key.ctrlU": "Ctrl + U",
  "keybinds.key.arrowUp": "Arrow Up",
  "keybinds.key.ctrlB": "Ctrl + B",
  "keybinds.key.ctrlI": "Ctrl + I",

  "advanced.developerMode.label": "Developer Mode",
  "advanced.developerMode.desc": "Show message IDs, user IDs, and channel IDs on context menus",
  "advanced.debug": "Debug",
  "advanced.devtools.label": "Open DevTools",
  "advanced.devtools.desc": "Open the browser developer tools for debugging",
  "advanced.devtools.button": "Open DevTools",
  "advanced.storageCache": "Storage & Cache",
  "advanced.clearImages.label": "Clear Image Cache",
  "advanced.clearImages.desc":
    "Remove cached images and link previews. They will be re-downloaded as needed.",
  "advanced.clearLogs.label": "Clear Log Files",
  "advanced.clearLogs.desc": "Remove persisted client log files from disk.",
  "advanced.clearAll.label": "Clear All Cache & Restart",
  "advanced.clearAll.desc":
    "Remove all cached data (images, logs, WebView storage) and restart the app. Server profiles and credentials are preserved.",
  "advanced.button.clear": "Clear",
  "advanced.button.clearing": "Clearing...",
  "advanced.button.cleared": "Cleared!",
  "advanced.button.failed": "Failed",
  "advanced.button.clearRestart": "Clear & Restart",
  "advanced.button.confirmAgain": "Are you sure? Click again",
  "advanced.launchOnLogin.label": "Launch on Login",
  "advanced.launchOnLogin.desc": "Start OwnCord automatically when you sign in to your computer",

  "diagnostics.title": "Test my connection and voice",
  "diagnostics.description":
    "Checks this client's connection. To check incoming voice or video, join a call with someone speaking or sharing video before starting. The test does not join a call or send microphone audio.",
  "diagnostics.micCheck": " Include a brief microphone permission check",
  "diagnostics.start": "Start connection test",
  "diagnostics.cancel": "Cancel test",
  "diagnostics.ready": "Ready to test.",
  "diagnostics.limitation":
    "Results describe this device and this moment. Incoming media checks do not verify speaker output, outgoing delivery or anyone's encryption identity. Other networks may behave differently.",
  "diagnostics.testing": "Testing…",
  "diagnostics.sessionChanged":
    "The signed-in session changed. Run a new test for the current server.",
  "diagnostics.notTested": "Not tested",
  "diagnostics.complete": "Test complete. Review each result below.",
  "diagnostics.cancelled": "Test cancelled.",
  "diagnostics.failed": "The test could not finish. Try again.",
  "diagnostics.status.passed": "Passed",
  "diagnostics.status.running": "Running",
  "diagnostics.status.failed": "Failed",

  "logs.entries": "{count} entries",
  "logs.version.loading": "Client version: loading...",
  "logs.version.known": "Client version: v{version}",
  "logs.version.unknown": "Client version: unknown",
  "logs.filter": "Filter:",
  "logs.filterLabel": "Log filter",
  "logs.minLevel": "Min Level:",
  "logs.minLevelLabel": "Minimum log level",
  "logs.copyAll": "Copy All",
  "logs.copied": "Copied!",
  "logs.copyFailed": "Failed to copy",
  "logs.clear": "Clear Logs",
  "logs.refresh": "Refresh",
  "logs.voiceDiagnostics": "Voice Diagnostics",
  "logs.refreshDiagnostics": "Refresh Diagnostics",
  "logs.copyDiagnostics": "Copy Diagnostics",
  "logs.exportBundle": "Export Support Bundle",
  "logs.bundleNote":
    "Saves a zip on this computer with your log files, these diagnostics, your saved servers and display and voice settings. Nothing is uploaded, and passwords, tokens, recovery kits, recovery codes and 2FA secrets are never read into it. Log lines are exported verbatim, without redaction — read them before sharing.",
  "logs.bundleSaved": "Support bundle saved.",
  "logs.exportFailed": "Export failed: {error}",
  "logs.bundleReadme":
    "OwnCord support bundle\n\nCreated on this computer by the OwnCord desktop client. Nothing was sent to\na server. Contents:\n\n  app.json               client version and when this bundle was made\n  settings.json          allowlisted display and voice settings, and your saved\n                         servers (name, address, username, sign-in options)\n  voice-diagnostics.json the voice session state shown in Settings > Logs\n  logs/*.jsonl           the client's log files, copied verbatim\n\nPasswords, session tokens, recovery kits, recovery codes and 2FA secrets are\nnever read into this bundle: settings are copied from a fixed allowlist and the\nOS keychain is not touched. The log files are NOT redacted: they are exported\nexactly as written. Read them before sharing this bundle, and share it only\nwith someone you trust.\n",

  "diagnostics.stage.connection": "Server connection",
  "diagnostics.stage.authentication": "Signed-in access",
  "diagnostics.stage.websocket": "Live message connection",
  "diagnostics.stage.microphone": "Microphone access",
  "diagnostics.stage.signaling": "Voice signaling",
  "diagnostics.stage.media": "Incoming media",
  "diagnostics.detail.checking": "Checking…",
  "diagnostics.detail.connectionPassed":
    "This client reached the server through its normal certificate-checked connection.",
  "diagnostics.detail.noServer": "Choose and connect to a server, then run this test again.",
  "diagnostics.detail.authPassed":
    "The server accepted a fresh request for your signed-in account.",
  "diagnostics.detail.authFailed":
    "The account request failed. Reconnect or sign in again, then retry.",
  "diagnostics.detail.wsPassed":
    "A fresh heartbeat response arrived on your authenticated message connection.",
  "diagnostics.detail.wsFailed":
    "No live heartbeat response arrived. Wait for reconnection or check whether your network allows WebSocket connections.",
  "diagnostics.detail.signInAccount": "Sign in to test access to your account.",
  "diagnostics.detail.signInMessage": "Sign in to test the live message connection.",
  "diagnostics.detail.micPassed":
    "Your selected microphone opened successfully. The test capture has stopped; no audio was sent.",
  "diagnostics.detail.micDenied":
    "Microphone access was denied. Allow it in your app or system privacy settings, then retry.",
  "diagnostics.detail.micTimeout":
    "The microphone prompt did not finish. Dismiss any pending prompt, then retry. Any late capture will be stopped.",
  "diagnostics.detail.micFailed":
    "The selected microphone could not open. Check Voice & Audio settings and reconnect your device.",
  "diagnostics.detail.micSkipped": "Microphone check was not selected.",
  "diagnostics.detail.joinVoice": "Join a voice channel yourself, then run this test again.",
  "diagnostics.detail.joinCall":
    "Join a call with another person speaking or sharing video to test incoming media.",
  "diagnostics.detail.signalingClosed":
    "The current voice signaling connection is not open. Wait for voice recovery or leave and rejoin the channel.",
  "diagnostics.detail.restoreVoice": "Restore the voice connection before checking incoming media.",
  "diagnostics.detail.signalingOpen": "Your current call has an open voice signaling connection.",
  "diagnostics.detail.noParticipant":
    "No other participant is in this call. Ask someone to join and speak or share video, then retry.",
  "diagnostics.detail.listening":
    "Listening for decoded incoming media for three seconds. Ask another participant to speak or share video.",
  "diagnostics.detail.callChanged":
    "The call changed during the check. Run it again in your current call.",
  "diagnostics.detail.mediaPassed":
    "Incoming {kinds} decoded during this check. This does not test your speakers, outgoing media, or the other person's identity.",
  "diagnostics.detail.kinds.audio": "audio",
  "diagnostics.detail.kinds.video": "video",
  "diagnostics.detail.kinds.audioAndVideo": "audio and video",
  "diagnostics.detail.mediaMissing":
    "No advancing decoded media was observed. Ask someone to speak or share video and retry. If they are already sending, check voice permissions, encryption warnings and the media network path.",
  "diagnostics.detail.mediaFailed":
    "Incoming media could not be inspected. Rejoin the call and retry.",
  "diagnostics.detail.connectionTimeout":
    "The server did not respond in time. Check your connection and server address, then retry.",
  "diagnostics.detail.connectionRefused":
    "The server could not be reached through the normal certificate-checked connection. Check the server address and any certificate prompt, then retry.",

  "voiceAudio.inputDevice": "Input Device",
  "voiceAudio.default": "Default",
  "voiceAudio.inputVolume": "Input Volume",
  "voiceAudio.inputSensitivity": "Input Sensitivity",
  "voiceAudio.sensitivityValue": "Sensitivity {value}%",
  "voiceAudio.outputDevice": "Output Device",
  "voiceAudio.outputVolume": "Output Volume",
  "voiceAudio.streamQuality": "Stream Quality",
  "voiceAudio.streamQualityDesc":
    "Applies to camera and screenshare. Higher quality uses more bandwidth. Changes take effect on next voice join.",
  "voiceAudio.quality.low": "Low (360p cam / 720p screen)",
  "voiceAudio.quality.medium": "Medium (720p)",
  "voiceAudio.quality.high": "High (1080p)",
  "voiceAudio.quality.source": "Source (1080p max bitrate)",
  "voiceAudio.screenFps": "Screen Share FPS",
  "voiceAudio.screenFpsDesc":
    "Higher frame rates use more bandwidth and depend on what the capture source and display can deliver. Takes effect the next time you start sharing.",
  "voiceAudio.fps.30": "30 FPS (default)",
  "voiceAudio.fps.60": "60 FPS",
  "voiceAudio.fps.120": "120 FPS",
  "voiceAudio.videoDevice": "Video Device",
  "voiceAudio.kind.microphone": "Microphone",
  "voiceAudio.kind.speaker": "Speaker",
  "voiceAudio.kind.camera": "Camera",
  "voiceAudio.enumerateFailed": "Could not enumerate devices",
  "voiceAudio.cameraUnavailable": "Camera unavailable",
  "voiceAudio.echo.label": "Echo Cancellation",
  "voiceAudio.echo.desc": "Reduce echo from speakers feeding back into microphone",
  "voiceAudio.noise.label": "Noise Suppression",
  "voiceAudio.noise.desc": "Filter out background noise from your microphone",
  "voiceAudio.agc.label": "Automatic Gain Control",
  "voiceAudio.agc.desc": "Automatically adjust microphone volume",
  "voiceAudio.enhanced.label": "Enhanced Noise Suppression",
  "voiceAudio.enhanced.desc":
    "ML-powered noise removal (RNNoise) — filters keyboard, pets, and other non-voice sounds",
  "voiceAudio.applyNextJoin": "{desc}. Applies when you next join a voice channel.",
  "voiceAudio.nativeNote":
    "On Linux, audio runs in the app's native engine. Your microphone level and voice sensitivity are handled by the engine's automatic gain control and silence detection, so the input volume and input sensitivity controls are not available here. Use your system mixer to adjust your microphone level.",
});
