/** Settings catalog entries: Advanced, Logs, updates and connection diagnostics. Spread into settingsText. */
export const settingsAdvancedEntries = {
  "advanced.developerMode.label": "Developer mode",
  "advanced.developerMode.desc":
    "Add Copy Message ID, Copy User ID and Copy Channel ID to right-click menus",
  "advanced.confirmServerSwitch.label": "Ask before switching servers",
  "advanced.confirmServerSwitch.desc":
    "Show a confirmation when you pick a different server from the server list.",
  "advanced.general": "General",
  "advanced.debug": "Debug",
  "advanced.devtools.label": "Open DevTools",
  "advanced.devtools.desc": "Open the browser developer tools for debugging",
  "advanced.devtools.button": "Open DevTools",
  "advanced.storageCache": "Storage & cache",
  "advanced.clearImages.label": "Clear image cache",
  "advanced.clearImages.desc":
    "Remove cached images and link previews. They will be re-downloaded as needed.",
  "advanced.clearLogs.label": "Clear log files",
  "advanced.clearLogs.desc": "Remove persisted client log files from disk.",
  "advanced.clearAll.label": "Clear all cache & restart",
  "advanced.clearAll.desc":
    "Remove all cached data (images, logs, WebView storage) and restart the app. Display and behaviour settings are reset. Server profiles, credentials, themes, notification levels, voice input mode and key, muted channels, drafts, notes and server folders are kept.",
  "advanced.button.clear": "Clear",
  "advanced.button.clearing": "Clearing...",
  "advanced.button.cleared": "Cleared!",
  "advanced.button.failed": "Failed",
  "advanced.button.clearRestart": "Clear & restart",
  "advanced.button.confirmAgain": "Are you sure? Click again",
  "advanced.launchOnLogin.label": "Launch on login",
  "advanced.launchOnLogin.desc": "Start OwnCord automatically when you sign in to your computer",
  "advanced.minimizeToTray.label": "Close to tray",
  "advanced.minimizeToTray.desc":
    "Closing the window keeps OwnCord running in the tray, if your desktop shows one. Quit from the tray menu.",
  "advanced.startMinimized.label": "Start minimized",
  "advanced.startMinimized.desc":
    "When OwnCord starts at login, keep the window hidden in the tray",

  "diagnostics.title": "Connection test",
  "diagnostics.description":
    "Checks this client's connection. To check incoming voice or video, join a call with someone speaking or sharing video before starting. The test does not join a call or send microphone audio.",
  "diagnostics.micCheck": " Include a brief microphone permission check",
  "diagnostics.start": "Start connection test",
  "diagnostics.runAgain": "Run again",
  "diagnostics.cancel": "Cancel test",
  "diagnostics.ready": "Ready to test.",
  "diagnostics.limitation":
    "Results describe this device and this moment. Incoming media checks do not verify speaker output, outgoing delivery or anyone's encryption identity. Other networks may behave differently.",
  "diagnostics.testing": "Testing…",
  "diagnostics.sessionChanged":
    "The signed-in session changed. Run a new test for the current server.",
  "diagnostics.notTested": "Not tested",
  "diagnostics.completeOk": "Test complete. Everything tested is working.",
  "diagnostics.completeProblems": {
    one: "Test complete. {count} problem found.",
    other: "Test complete. {count} problems found.",
  },
  "diagnostics.completeUntested": "Test complete. Nothing could be tested yet.",
  "diagnostics.count.passed": "{count} passed",
  "diagnostics.count.failed": "{count} failed",
  "diagnostics.count.notTested": "{count} not tested",
  "diagnostics.result": "{status} — {detail}",
  "diagnostics.limitsSummary": "What this test does not check",
  "diagnostics.cancelled": "Test cancelled.",
  "diagnostics.failed": "The test could not finish. Try again.",
  "diagnostics.status.passed": "Passed",
  "diagnostics.status.running": "Running",
  "diagnostics.status.failed": "Failed",

  "logs.entries": { one: "{count} entry", other: "{count} entries" },
  "logs.warnings": { one: "{count} warning", other: "{count} warnings" },
  "logs.errors": { one: "{count} error", other: "{count} errors" },
  "logs.technicalDetails": "Technical details",
  "logs.clientLogs": "Client logs",
  "logs.getHelp": "Get help",
  "updates.label": "Updates",
  "updates.desc": "Look for a newer OwnCord client on your server.",
  "updates.check": "Check for updates",
  "updates.checking": "Checking for updates…",
  "updates.upToDate": "You're up to date.",
  "updates.failed": "Couldn't check for updates. Try again later.",
  "updates.noServer": "Connect to a server to check for updates.",
  "logs.filter": "Filter:",
  "logs.filterLabel": "Log filter",
  "logs.minLevel": "Min level:",
  "logs.minLevelLabel": "Minimum log level",
  "logs.copyAll": "Copy all",
  "logs.copied": "Copied!",
  "logs.copyFailed": "Failed to copy",
  "logs.clear": "Clear logs",
  "logs.refresh": "Refresh",
  "logs.voiceDiagnostics": "Voice engine state",
  "logs.refreshDiagnostics": "Refresh diagnostics",
  "logs.copyDiagnostics": "Copy diagnostics",
  "logs.exportBundle": "Export support bundle",
  "logs.bundleNote":
    "Saves a zip of your logs, diagnostics and settings on this computer. Nothing is uploaded. Tokens, links, addresses and other secrets are removed first, but read it before sharing.",
  "logs.bundleSaved": "Support bundle saved.",
  "logs.eventLog": "Keep a diagnostic event log",
  "logs.eventLogDesc":
    "Records what the camera, calls and server connection did in the last 30 minutes, without names, messages or addresses. It stays on this device and goes into the support bundle. Turning it off deletes it.",
  "logs.shareBundle": "Share support bundle",
  "logs.bundleNoteShare":
    "Makes a zip of your logs, diagnostics and settings on this phone and opens the share sheet, so you choose where it goes. Tokens, links, addresses and other secrets are removed first, but read it before sharing.",
  "logs.openFolder": "Open log folder",
  "logs.openFolderFailed": "Could not open the log folder: {error}",
  "logs.exportFailed": "Export failed: {error}",
  "logs.shareTesting": "Screen share testing",
  "logs.shareRecord": "Record screen-share details",
  "logs.shareRecordDesc":
    "Keeps the last 3 minutes of screen-share stats on this computer. They go into the support bundle. Nothing is uploaded.",
  "logs.shareMode": "Test mode",
  "logs.shareModeDesc": "For testing only. Takes effect the next time you share.",
  "logs.shareMode.legacy": "Normal (default)",
  "logs.shareMode.detail-resolution": "Sharp text, keep resolution",
  "logs.shareMode.detail-balanced": "Sharp text, smooth fallback",
  "logs.shareMode.detail-framerate": "Sharp text, keep frame rate",
  "logs.shareMode.motion-resolution": "Smooth motion, keep resolution",
  "logs.shareMode.motion-balanced": "Smooth motion, balanced",
  "logs.shareMode.motion-framerate": "Smooth motion, keep frame rate",
  "logs.bundleReadme":
    "OwnCord support bundle\n\nCreated on this device by the OwnCord client. Nothing was sent to a server.\nContents:\n\n  manifest.json          every file below with its size, SHA-256 and how many\n                         values were removed from it; a report id; files left\n                         out to keep the bundle under 4 MB\n  redactions.json        how many values each rule removed, per file\n  app.json               client version, OS, webview and when this bundle\n                         was made\n  settings.json          allowlisted display and voice settings, and your saved\n                         servers (name, address, username, sign-in options)\n  voice-diagnostics.json the voice session state shown in Settings >\n                         Diagnostics & logs\n  share-diagnostics.json the recent screen-share stats (only when Record\n                         screen-share details was on and a share was recorded)\n  last-exit.json         how the app's last run ended (crash, killed, normal),\n                         read from the native log\n  logs/*.jsonl           the client's log files\n  logs/events-*.jsonl    the diagnostic event log: what the camera, calls and\n                         server connection did, without names or messages\n  logs/owncord-client*.log the native host log (startup, updates, TLS/TOFU,\n                         crashes and exits), tail-capped at 2 MB per file\n\nSettings are copied from a fixed allowlist and the OS keychain is not read, so\nno password, session token, recovery kit, recovery code or 2FA secret is taken\nfrom them. Every file passes through a redaction step first: tokens, passwords,\nkeys, cookies, recovery codes, links (cut to the server name), email and IP\naddresses, and your home folder name (written as ~) are removed. It looks for\ntheir shape only: a log line can contain anything the app logged in plain\nwords. Read the files before sharing this bundle, and share it only with\nsomeone you trust.\n",

  "diagnostics.short.connection": "Server",
  "diagnostics.short.authentication": "Sign-in",
  "diagnostics.short.websocket": "Messages",
  "diagnostics.short.microphone": "Microphone",
  "diagnostics.short.signaling": "Voice",
  "diagnostics.short.media": "Media",
  "diagnostics.stepName": "{label} — {stage}, {status}",
  "diagnostics.stepDetail": "{stage}: {status}",
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
    "The selected microphone could not open. Check Voice & video settings and reconnect your device.",
  "diagnostics.detail.micSilent":
    "The microphone opened but no audio arrived. Check that it is not muted at the system level, or pick another microphone in Voice & video settings.",
  "diagnostics.detail.micNativePresent":
    "Your microphone opened and reported audio. The test capture has stopped; nothing was recorded or sent.",
  "diagnostics.detail.micNativeDefault":
    "Your saved microphone is not connected, so calls will use the system default. The default opened and reported audio; nothing was recorded or sent.",
  "diagnostics.detail.micNativeInCall":
    "You are in a call, so its capture already holds your microphone and it was not opened again. The level bar in Voice & video settings shows it live.",
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
  "diagnostics.detail.mediaNative":
    "Incoming media cannot be checked on Linux: the web view has no WebRTC, so this test has no receiver to inspect. Hearing or seeing another participant in your call is the check.",
  "diagnostics.detail.mediaFailed":
    "Incoming media could not be inspected. Rejoin the call and retry.",
  "diagnostics.detail.connectionTimeout":
    "The server did not respond in time. Check your connection and server address, then retry.",
  "diagnostics.detail.connectionRefused":
    "The server could not be reached through the normal certificate-checked connection. Check the server address and any certificate prompt, then retry.",
} as const;
