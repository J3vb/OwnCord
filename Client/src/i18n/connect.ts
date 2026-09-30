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
  "update.smartScreen":
    "Windows will show “Windows protected your PC” because this installer is not signed. Choose More info, then Run anyway to continue.",
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
  "servers.deleteConfirmTitle": "Delete server?",
  "servers.deleteConfirmBody":
    "Remove {name} from your saved servers? Its remembered credential is deleted too.",
  "servers.empty": "No saved servers yet — add one below.",
  // This number times one REST call through the desktop TLS tunnel (a fresh
  // connection and handshake per request, about 3× the network RTT), so it is
  // labelled "response time" rather than claimed to be a ping.
  "servers.latency": "{ms}ms response time",
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
  "totp.invalidCode": "Enter a 6-digit code or an 11-character recovery code.",
  "totp.failed": "Verification failed.",

  "cert.mismatch.title": "Certificate Warning",
  "cert.mismatch.heading": "Certificate Changed",
  "cert.mismatch.description":
    "This server is presenting a different certificate from the one you trusted before. Routine renewals from public certificate authorities no longer prompt, so seeing this on a server you use regularly deserves extra care: verify the fingerprint with the owner before accepting. Ask the server owner for the current fingerprint through another channel, such as a call or a chat outside OwnCord (the owner finds it on the admin Dashboard), and accept only if it matches Current below, character for character. If it does not match, or you cannot check, choose Disconnect.",
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
  "session.banned": "You have been banned.",
  "error.serverFallback": "Server error",
  "error.rateLimited": "Too many requests. Try again later.",
  "error.accountLocked":
    "Your account is temporarily locked after too many failed sign-in attempts. Try again later.",
  "error.totpTooManyAttempts": "Too many incorrect codes. Try again later.",
  "error.registrationQueueFull":
    "This server is not accepting new applications right now. Try again later.",
  "error.loginUnavailable": "Sign-in is temporarily unavailable. Try again shortly.",
  "error.registrationFailed": "Registration failed. Please try again.",
  "error.recoveryLocked":
    "Account recovery is temporarily locked after too many failed attempts. Try again later.",
  "error.tooManyAttempts": "Too many failed attempts. Try again later.",
  "error.registrationRateLimited":
    "Too many accounts have been created from this network. Try again later.",
  "error.authBusy": "The server is busy right now. Try again in a moment.",
  "error.couldNotComplete": "The server could not complete that right now. Try again shortly.",
  "error.recoveryCredentialBudget":
    "Too many recovery credentials have been issued. Try again later.",
  "error.registrationUnavailable": "Registration is temporarily unavailable. Try again shortly.",
  "error.sessionFailed": "Could not start your session. Try signing in again.",
  "error.registeredSignInFailed":
    "Your account was created, but signing in failed. Sign in to continue.",
  "error.totpUnavailable": "Two-factor verification is temporarily unavailable. Try again shortly.",
  "error.logoutFailed": "Could not sign out. Try again.",
  "error.deleteAccountFailed": "Could not delete your account. Try again.",
  "error.totpEnableFailed": "Could not turn on two-factor authentication. Try again.",
  "error.totpDisableFailed": "Could not turn off two-factor authentication. Try again.",
  "error.recoveryCodesFailed": "Could not create new recovery codes. Try again.",
  "error.recoveryFailed": "Account recovery failed. Please try again.",
  "error.recoveryKitFailed": "Could not create a recovery kit. Try again.",
  "error.recoveryCredentialFailed": "Could not issue a recovery credential. Try again.",
  "error.unauthorized": "Your session has expired — sign in again.",
  "error.invalidCredentials": "Incorrect username or password.",
  "error.forbidden": "You don't have permission to do that.",
  "error.notFound": "That item no longer exists.",
  "error.banned": "Your account has been suspended.",
  "error.unavailable": "The server is temporarily unavailable. Try again.",
  "error.storageQuota": "Your storage is full — delete files or ask a server admin.",
  "error.storageLowDisk": "The server is low on disk space — try again later.",
  "error.storageError": "The server could not store that. Try again.",
  "error.gifDisabled": "GIF search is not configured on this server.",
  "error.pushDisabled": "Notifications are not enabled on this server.",
  "session.passwordRemoveFailed": "Could not remove the saved password — it is still stored",
  "session.credentialsSaveFailed": "Could not save credentials — auto-login won't work",
  "session.savedLoginUnavailable":
    "Saved-password login is unavailable here — please type your password.",
  "session.autoLoginFailed": "Auto-login failed",
  "session.autoLoginFailedDetail": "Auto-login failed: {message}",
  "session.connectTimeout":
    "Couldn't reach this server — it may be offline. Check your connection and try again.",
  "session.loginFailedStatus": "Login failed ({status})",
  "session.loginUnreadable": "Login failed: the server returned an unreadable response.",

  "app.renderFailed": "Something went wrong rendering this section.",
  "app.channelDeleted": "This channel was deleted",
  "app.dmNoMessages": "No messages yet",
  "app.dmCreateFailed": "Failed to create DM",
  "app.dmCreateGroupFailed": "Failed to create group DM",
  "app.sendBeforeRestore":
    "The server was restored — check the conversation before sending this again.",

  "dm.emptyGroup": "Empty group",
  "dm.unknownUser": "Unknown user",
  "dm.more": "and {count} more",
  "channel.voiceCategory": "Voice",
  "notifications.channelFallback": "Channel {id}",
  "notifications.mentioned": "{author} mentioned you in {channel}",
  "notifications.inChannel": "{author} in {channel}",
  "notifications.spoiler": "Spoiler",
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
