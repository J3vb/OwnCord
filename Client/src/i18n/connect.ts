import { defineCatalog } from "./format";

/**
 * Connect, sign-in, trust and session copy (B9-18): the connect page and its
 * server panel, login and two-factor forms, the incompatible-server notice,
 * the certificate trust prompts, the post-login overlay and the session
 * messages main.ts raises. It ships in the
 * startup chunk, so it also holds the few shell messages raised by startup
 * modules (the render fallback, the channel-deleted notice, the DM helpers the
 * dispatcher reaches) and keeps shell.ts, the main page's catalog, out of it.
 */
export const connectText = defineCatalog("connect", {
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.unknown": "Unknown",
  "common.settings": "Settings",
  "modal.save": "Save",

  "media.playPauseGif": "Play/pause GIF",

  "update.downloadingPercent": "Downloading update… {percent}%",
  "update.downloadingMb": "Downloading update… {mb} MB",
  "update.downloading": "Downloading update…",
  "update.unavailable":
    "This install cannot update itself. Ask your server administrator for the new version.",
  "update.dismiss": "Dismiss",
  "update.available": "Update v{version} available",
  "update.now": "Update Now",
  "update.later": "Later",
  "update.installedRestarting": "Update installed. Restarting…",
  "update.installedRestart": "Update installed. Please restart OwnCord to finish.",
  "update.failed": "Update failed. Please try again later.",
  "update.retry": "Retry",

  "voice.disconnected": "You were disconnected from voice",
  "voice.channelFull": "That voice channel is full",
  "voice.videoLimit": "That voice channel has reached its video limit",

  "brand.tagline": "Self-hosted chat — Your server, your rules",
  "profiles.defaultName": "Local Server",
  "profiles.saveFailed": "Could not save server profiles",
  "settings.notAuthenticated": "Not authenticated",

  "servers.heading": "Servers",
  "servers.addButton": "+ Add Server",
  "servers.autoLogin.disable": "Disable auto-login",
  "servers.autoLogin.enable": "Enable auto-login",
  "servers.autoLogin.enabled": "Auto-login enabled",
  "servers.delete": "Delete server",
  "servers.latency": "{ms}ms",
  "servers.online": "{count} online",
  "servers.clientUpdateNeeded": "Client update needed",
  "servers.serverUpdateNeeded": "Server update needed",
  "servers.add.title": "Add Server",
  "servers.add.nameLabel": "Server Name",
  "servers.add.namePlaceholder": "My Server",
  "servers.add.hostLabel": "Host Address",
  "servers.add.submit": "Add Server",
  "servers.add.invalidHost": "Invalid server address (expected host or host:port)",

  "incompatible.clientOlder":
    "{host}: this client speaks protocol epoch {clientEpoch} but the server needs {serverEpoch}; update the client.",
  "incompatible.serverOlder":
    "{host}: this client speaks protocol epoch {clientEpoch} but the server only speaks {serverEpoch}; update the server.",
  "incompatible.unknown":
    "{host}: this client cannot speak to this server — the protocol epochs differ.",
  "incompatible.updateClient": "Update client",
  "incompatible.leave": "Choose another server",

  "login.subtitle": "Connect to your server",
  "login.title": "Login",
  "login.registerTitle": "Register",
  "login.hostLabel": "Server Address",
  "login.usernameLabel": "Username",
  "login.passwordLabel": "Password",
  "login.rememberPassword": "Remember password",
  "login.autoConnect": "Auto connect",
  "login.inviteLabel": "Invite Code",
  "login.toRegister": "Need an account? Register",
  "login.toLogin": "Already have an account? Login",
  "login.recoverLink": "Lost your password or 2FA device? Recover your account",
  "login.togglePassword": "Toggle password visibility",
  "login.connecting": "Connecting…",
  "login.loggingIn": "Logging in…",
  "login.registering": "Registering…",
  "login.registrationClosed": "Registration closed",
  "login.autoConnecting": "Auto-connecting...",
  "login.recoveryUnavailable": "Account recovery is unavailable.",
  "registration.closedNotice": "Registration is closed on this server.",
  "registration.approvalNotice":
    "Registration requires admin approval. You can register now, but an admin must approve your account before you can sign in.",
  "registration.pendingApproval":
    "Registration received. An admin has to approve your account before you can sign in.",

  "validation.hostRequired": "Server address is required.",
  "validation.usernameRequired": "Username is required.",
  "validation.passwordRequired": "Password is required.",
  "validation.passwordTooShort": "Password must be at least {min} characters.",
  "validation.placeholderPassword":
    "That is the saved-password placeholder, not a password. Choose a different one.",
  "validation.inviteRequired": "Invite code is required for registration.",

  "totp.title": "Two-Factor Authentication",
  "totp.description":
    "Enter the 6-digit code from your authenticator app, or an emergency recovery code.",
  "totp.placeholder": "000000 or XXXXX-XXXXX",
  "totp.inputLabel": "Authentication or recovery code",
  "totp.verify": "Verify",
  "totp.verifying": "Verifying…",
  "totp.failed": "Verification failed.",

  "cert.mismatch.title": "Certificate Warning",
  "cert.mismatch.heading": "Certificate Changed",
  "cert.mismatch.description":
    "The server's TLS certificate fingerprint has changed. This could mean the server regenerated its certificate, or it could indicate a security issue.",
  "cert.mismatch.previous": "Previous",
  "cert.mismatch.current": "Current",
  "cert.mismatch.reject": "Disconnect",
  "cert.mismatch.accept": "Accept New Certificate",
  "cert.firstUse.title": "New Server Certificate",
  "cert.firstUse.heading": "Confirm the certificate fingerprint",
  "cert.firstUse.description":
    "This is the first connection to this server, so its certificate is not yet trusted. Verify the fingerprint below out-of-band (e.g. with the server operator) before trusting it — on an untrusted network an attacker could present a fake certificate.",
  "cert.firstUse.fingerprint": "Fingerprint",
  "cert.firstUse.accept": "Trust This Certificate",
  "cert.host": "Host",

  "connected.title": "Connected!",
  "connected.loggedInAs": "Logged in as {username}",
  "connected.loading": "Loading server data...",
  "connected.ready": "Ready!",

  "session.expired": "Your session expired — sign in again.",
  "session.serverShutdown": "The server was shut down — you have been signed out.",
  "session.serverRestarting": "Server is restarting: {reason}",
  "session.banned": "You have been banned.",
  "error.serverFallback": "Server error",
  "error.rateLimited": "Too many requests. Try again later.",
  "session.passwordRemoveFailed": "Could not remove the saved password — it is still stored",
  "session.credentialsSaveFailed": "Could not save credentials — auto-login won't work",
  "session.savedLoginUnavailable":
    "Saved-password login is unavailable here — please type your password.",
  "session.autoLoginFailed": "Auto-login failed",
  "session.autoLoginFailedDetail": "Auto-login failed: {message}",
  "session.loginFailedStatus": "Login failed ({status})",
  "session.loginUnreadable": "Login failed: the server returned an unreadable response.",

  "app.renderFailed": "Something went wrong rendering this section.",
  "app.channelDeleted": "This channel was deleted",
  "app.dmNoMessages": "No messages yet",
  "app.dmCreateFailed": "Failed to create DM",
  "app.dmCreateGroupFailed": "Failed to create group DM",

  "dm.emptyGroup": "Empty group",
  "dm.unknownUser": "Unknown user",
  "dm.more": "and {count} more",
  "channel.voiceCategory": "Voice",
  "notifications.channelFallback": "Channel {id}",
  "notifications.mentioned": "{author} mentioned you in {channel}",
  "retention.kept": "keeps messages until they are deleted",
  "retention.deleted": {
    one: "deletes messages after {days} day",
    other: "deletes messages after {days} days",
  },
  "retention.notice":
    "By default this server {window}; attachments are removed with their messages.",

  "blocks.blockedByMe": "You've blocked this user. Unblock to send messages.",
  "blocks.blockedByThem": "You can't message this user right now.",
});
