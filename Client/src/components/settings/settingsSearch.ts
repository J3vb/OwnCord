/**
 * Settings search (3E-3b, Discord parity A11): what each tab says, and the
 * pure helpers that filter the nav and highlight matches in the open tab.
 *
 * The index is a static list of catalog strings per tab, not a scan of the
 * rendered DOM: tabs build lazily (and some read the network), so rendering
 * all of them to index would defeat that. `tests/unit/settings-search.test.ts`
 * renders every tab and fails when an indexed string is not on screen, or a
 * row label or description on screen is not indexed, so the list cannot drift
 * silently.
 *
 * Known gaps: rows that exist only on the Linux native build, or only in some
 * state (a connected server, a granted permission), are not in the test's
 * jsdom render and so are not indexed unless they also show there. Matching
 * and highlighting lower-case the text and slice the original by the match
 * length, which assumes the English catalog (no case mapping changes length).
 */

import { accountText } from "../../i18n/account";
import { externalConsentText } from "../../i18n/externalConsent";
import { gameActivityText } from "../../i18n/gameActivity";
import { listeningDetailsText } from "../../i18n/listeningDetails";
import { settingsText } from "../../i18n/settings";
import { whatsNewText } from "../../i18n/whatsNew";

const s = settingsText;
const a = accountText;

/** The tabs the overlay can show; `SettingsOverlay`'s `TabName` is this union. */
export type SearchableTab =
  | "Account"
  | "Safety"
  | "Appearance"
  | "Accessibility"
  | "Voice & Video"
  | "Text & Images"
  | "Notifications"
  | "Keybinds"
  | "Advanced"
  | "Logs"
  | "About";

/**
 * The label, description and section-heading text each tab shows, beyond its
 * own name. The Safety tab is built by its feature, so only its name is
 * searchable. Status, error and button text is deliberately left out: it
 * changes with state and is not what a person searches for.
 */
export const SETTINGS_SEARCH_INDEX: Readonly<Record<SearchableTab, () => readonly string[]>> = {
  Account: () => [
    a("profile.sectionTitle"),
    a("profile.username"),
    a("profile.displayName"),
    a("profile.about"),
    a("profile.changeAvatar"),
    a("password.sectionTitle"),
    a("totp.sectionTitle"),
    a("totp.description"),
    a("status.sectionTitle"),
    a("status.showMeAs"),
    a("status.hint"),
    a("devices.sectionTitle"),
    a("devices.description"),
    a("security.title"),
    a("delete.sectionTitle"),
    a("delete.description"),
  ],
  Safety: () => [],
  Appearance: () => [
    s("appearance.theme"),
    s("appearance.fontSize"),
    s("appearance.zoom"),
    s("appearance.compactMode"),
    s("appearance.timeFormat"),
    s("appearance.timeFormat.desc"),
    s("appearance.memberLayout"),
    s("appearance.memberLayout.desc"),
    s("appearance.accentColor"),
    s("appearance.accentNote"),
  ],
  Accessibility: () => [
    s("accessibility.group.motion"),
    s("accessibility.group.readability"),
    s("accessibility.group.chat"),
    s("accessibility.group.colors"),
    s("accessibility.reducedMotion.label"),
    s("accessibility.reducedMotion.desc"),
    s("accessibility.syncOsMotion.label"),
    s("accessibility.highContrast.label"),
    s("accessibility.highContrast.desc"),
    s("accessibility.largeFont.label"),
    s("accessibility.largeFont.desc"),
    s("accessibility.textSize.label"),
    s("accessibility.textSize.desc"),
    s("accessibility.underlineLinks.label"),
    s("accessibility.underlineLinks.desc"),
    s("accessibility.roleColors.label"),
    s("accessibility.roleColors.desc"),
    s("accessibility.saturation.label"),
    s("accessibility.saturation.desc"),
  ],
  "Voice & Video": () => [
    s("voiceAudio.card.inputMode"),
    s("voiceAudio.inputMode.ptt"),
    s("voiceAudio.card.microphone"),
    s("voiceAudio.card.speakers"),
    s("voiceAudio.card.camera"),
    s("voiceAudio.card.processing"),
    s("voiceAudio.micTest.label"),
    s("voiceAudio.micTest.desc"),
    s("voiceAudio.inputDevice"),
    s("voiceAudio.inputVolume"),
    s("voiceAudio.inputSensitivity"),
    s("voiceAudio.autoSensitivity"),
    s("voiceAudio.outputDevice"),
    s("voiceAudio.outputVolume"),
    s("voiceAudio.videoDevice"),
    s("voiceAudio.autoPlayCameras"),
    s("voiceAudio.autoPlayCamerasDesc"),
    s("voiceAudio.cameraQuality"),
    s("voiceAudio.cameraQualityDesc"),
    s("voiceAudio.screenQuality"),
    s("voiceAudio.screenQualityDesc"),
    s("voiceAudio.screenFps"),
    s("voiceAudio.screenFpsDesc"),
    s("voiceAudio.videoCodec"),
    s("voiceAudio.videoCodecDesc"),
    s("voiceAudio.echo.label"),
    s("voiceAudio.echo.desc"),
    s("voiceAudio.noise.label"),
    s("voiceAudio.noise.desc"),
    s("voiceAudio.agc.label"),
    s("voiceAudio.agc.desc"),
    s("voiceAudio.enhanced.label"),
    s("voiceAudio.enhanced.desc"),
  ],
  "Text & Images": () => [
    s("images.linkPreview.label"),
    s("images.linkPreview.desc"),
    s("images.embeds.label"),
    s("images.embeds.desc"),
    s("images.inline.label"),
    s("images.inline.desc"),
    s("images.animateGifs.label"),
    s("images.animateGifs.desc"),
    s("images.animateEmoji.label"),
    s("images.animateEmoji.desc"),
    externalConsentText("reset.label"),
    externalConsentText("reset.desc"),
  ],
  Notifications: () => [
    s("notifications.desktop.label"),
    s("notifications.desktop.desc"),
    s("notifications.permission.label"),
    s("notifications.flash.label"),
    s("notifications.flash.desc"),
    s("notifications.suppress.label"),
    s("notifications.suppress.desc"),
    s("notifications.unreadBadge.label"),
    s("notifications.unreadBadge.desc"),
    s("notifications.sounds.label"),
    s("notifications.sounds.desc"),
    s("notifications.callSound.label"),
    s("notifications.callSound.desc"),
    s("notifications.voiceSounds.label"),
    s("notifications.voiceSounds.desc"),
    s("notifications.volume.label"),
    s("notifications.volume.desc"),
    s("notifications.sound.message.label"),
    s("notifications.sound.message.desc"),
    s("notifications.sound.mention.label"),
    s("notifications.sound.mention.desc"),
    s("notifications.sound.ring.label"),
    s("notifications.sound.ring.desc"),
    s("notifications.sound.ringback.label"),
    s("notifications.sound.ringback.desc"),
    s("notifications.sound.joinLeave.label"),
    s("notifications.sound.joinLeave.desc"),
    s("notifications.sound.muteDeafen.label"),
    s("notifications.sound.muteDeafen.desc"),
    s("notifications.sound.stream.label"),
    s("notifications.sound.stream.desc"),
    s("notifications.level.label"),
    s("notifications.level.desc"),
    s("notifications.muted.title"),
    s("notifications.muted.desc"),
    s("notifications.channelLevels.title"),
    s("notifications.channelLevels.desc"),
  ],
  Keybinds: () => [
    s("keybinds.pushToTalk"),
    s("keybinds.pttReleaseDelay"),
    s("keybinds.globalSection"),
    s("keybinds.navigation"),
    s("keybinds.communication"),
    s("keybinds.messages"),
    s("keybinds.action.quickSwitcher"),
    s("keybinds.action.openSettings"),
    s("keybinds.action.showShortcuts"),
    s("keybinds.action.searchMessages"),
    s("keybinds.action.closeOverlay"),
    s("keybinds.action.markChannelRead"),
    s("keybinds.action.markServerRead"),
    s("keybinds.action.scrollChat"),
    s("keybinds.action.emojiPicker"),
    s("keybinds.action.gifPicker"),
    s("keybinds.action.nextChannel"),
    s("keybinds.action.nextUnreadChannel"),
    s("keybinds.action.toggleMute"),
    s("keybinds.action.toggleDeafen"),
    s("keybinds.action.toggleCamera"),
    s("keybinds.action.toggleScreenshare"),
    s("keybinds.action.disconnect"),
    s("keybinds.action.uploadFile"),
    s("keybinds.action.editLastMessage"),
    s("keybinds.action.bold"),
    s("keybinds.action.italic"),
    s("keybinds.action.underline"),
  ],
  Advanced: () => [
    s("advanced.developerMode.label"),
    s("advanced.developerMode.desc"),
    s("advanced.launchOnLogin.label"),
    s("advanced.launchOnLogin.desc"),
    s("advanced.minimizeToTray.label"),
    s("advanced.minimizeToTray.desc"),
    s("advanced.startMinimized.label"),
    s("advanced.startMinimized.desc"),
    gameActivityText("settings.title"),
    gameActivityText("settings.share.label"),
    gameActivityText("settings.share.desc"),
    gameActivityText("games.title"),
    gameActivityText("games.desc"),
    gameActivityText("games.empty"),
    gameActivityText("add.button"),
    listeningDetailsText("settings.share.label"),
    listeningDetailsText("settings.share.desc"),
    listeningDetailsText("players.title"),
    listeningDetailsText("players.desc"),
    listeningDetailsText("players.empty"),
    s("advanced.debug"),
    s("advanced.devtools.label"),
    s("advanced.devtools.desc"),
    s("advanced.storageCache"),
    s("advanced.clearImages.label"),
    s("advanced.clearImages.desc"),
    s("advanced.clearLogs.label"),
    s("advanced.clearLogs.desc"),
    s("advanced.clearAll.label"),
    s("advanced.clearAll.desc"),
  ],
  Logs: () => [
    s("diagnostics.title"),
    s("diagnostics.description"),
    s("diagnostics.limitation"),
    s("diagnostics.micCheck"),
    s("logs.getHelp"),
    s("logs.bundleNote"),
    s("logs.clientLogs"),
    s("logs.voiceDiagnostics"),
    s("logs.filter"),
    s("logs.minLevel"),
    s("logs.shareTesting"),
    s("logs.shareRecord"),
    s("logs.shareRecordDesc"),
    s("logs.shareMode"),
    s("logs.shareModeDesc"),
  ],
  About: () => [
    s("updates.label"),
    s("updates.desc"),
    whatsNewText("about.desktop"),
    whatsNewText("about.history"),
  ],
};

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/** The text a query is matched against: trimmed and case-folded; "" means no query. */
export function normalizeQuery(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Lower-cased search text per tab, built on first use. */
const searchTextCache = new Map<SearchableTab, string>();

function indexedText(tab: SearchableTab): string {
  let text = searchTextCache.get(tab);
  if (text === undefined) {
    text = SETTINGS_SEARCH_INDEX[tab]().join("\n").toLowerCase();
    searchTextCache.set(tab, text);
  }
  return text;
}

/**
 * Whether `tab` matches the normalized `query`: a case-insensitive substring
 * of its on-screen name or of any label, description or heading it shows.
 * An empty query matches everything.
 */
export function tabMatches(tab: SearchableTab, label: string, query: string): boolean {
  if (query === "") return true;
  return label.toLowerCase().includes(query) || indexedText(tab).includes(query);
}

// ---------------------------------------------------------------------------
// Highlighting
// ---------------------------------------------------------------------------

export const HIT_CLASS = "settings-search-hit";

/** The text elements a match is marked in. */
const HIGHLIGHT_SELECTOR = [
  ".setting-label",
  ".setting-desc",
  ".setting-group-title",
  ".settings-section-title",
  ".keybind-section-header",
  ".settings-card-head h3",
  ".settings-pane > h3",
].join(", ");

/** Remove every highlight under `root`, restoring the plain text nodes. */
export function clearHighlights(root: ParentNode): void {
  const parents = new Set<Node>();
  for (const mark of root.querySelectorAll(`mark.${HIT_CLASS}`)) {
    const parent = mark.parentNode;
    if (parent === null) continue;
    parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark);
    parents.add(parent);
  }
  for (const parent of parents) parent.normalize();
}

/**
 * Wrap each occurrence of the normalized `query` in the label, description and
 * heading text under `root` in `<mark class="settings-search-hit">`, replacing
 * any earlier highlights, and return the first mark (null when none).
 * Only elements holding a single text node are marked: one with live child
 * elements is left alone rather than rebuilt under its owner.
 */
export function highlightMatches(root: ParentNode, query: string): HTMLElement | null {
  clearHighlights(root);
  if (query === "") return null;
  let first: HTMLElement | null = null;
  for (const el of root.querySelectorAll<HTMLElement>(HIGHLIGHT_SELECTOR)) {
    const node = el.firstChild;
    if (el.childNodes.length !== 1 || node === null || node.nodeType !== Node.TEXT_NODE) continue;
    const text = node.textContent ?? "";
    const lower = text.toLowerCase();
    let at = lower.indexOf(query);
    if (at === -1) continue;
    const frag = document.createDocumentFragment();
    let from = 0;
    while (at !== -1) {
      if (at > from) frag.appendChild(document.createTextNode(text.slice(from, at)));
      const mark = document.createElement("mark");
      mark.className = HIT_CLASS;
      mark.textContent = text.slice(at, at + query.length);
      frag.appendChild(mark);
      first ??= mark;
      from = at + query.length;
      at = lower.indexOf(query, from);
    }
    if (from < text.length) frag.appendChild(document.createTextNode(text.slice(from)));
    el.replaceChild(frag, node);
  }
  return first;
}
