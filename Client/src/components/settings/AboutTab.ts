/**
 * About tab: the app version, the update check, this version's release notes,
 * the earlier versions and a link to the repository. The notes are the
 * CHANGELOG.md bundled into the build (features/whats-new), so nothing here
 * goes to the network except the update check itself.
 */

import { createElement, appendChildren, clearChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { createLogger } from "@lib/logger";
import { createDisclosure } from "../../features/settings/status";
import { buildUpdateCheckRow, installInProgressText } from "../../features/updates/UpdateCheckRow";
import { subscribeAvailableUpdate } from "../../features/updates/availableUpdate";
import type { AvailableUpdate } from "../../features/updates/availableUpdate";
import { desktop } from "../../platform/desktop";
import { downloadAndInstallUpdate, subscribeToUpdateInstall } from "@lib/net/updater";
import type { UpdateInstallState } from "@lib/net/updater";
import {
  REPO_URL,
  findVersion,
  releaseUrl,
  renderChangelogBody,
} from "../../features/whats-new/changelog";
import type { ChangelogVersion } from "../../features/whats-new/changelog";
import { loadChangelog } from "../../features/whats-new/changelogSource";
import { readAppVersion } from "../../features/whats-new/appVersion";
import { whatsNewText as t } from "../../i18n/whatsNew";

const log = createLogger("AboutTab");

function externalLink(href: string, text: string, className: string): HTMLAnchorElement {
  const a = createElement("a", {
    class: className,
    href,
    target: "_blank",
    rel: "noopener noreferrer",
  });
  a.append(text, " ");
  a.appendChild(createIcon("external-link", 14));
  return a;
}

function buildHistory(versions: readonly ChangelogVersion[]): HTMLDivElement {
  const list = createElement("div", { class: "about-history", "data-testid": "about-history" });
  if (versions.length === 0) {
    list.appendChild(createElement("p", { class: "setting-desc" }, t("about.historyEmpty")));
    return list;
  }
  for (const entry of versions) {
    const { details } = createDisclosure(t("about.version", { version: entry.version }));
    // Rendered on first open: the full history is long and mostly unread.
    let rendered = false;
    details.addEventListener("toggle", () => {
      if (!details.open || rendered) return;
      rendered = true;
      details.appendChild(renderChangelogBody(entry.body));
    });
    list.appendChild(details);
  }
  return list;
}

/**
 * The offer the update check found, with its own notes: what installing it
 * brings, next to what this version already has. Hidden while there is none.
 */
function buildUpdateCard(signal: AbortSignal, installed: Promise<string | null>): HTMLDivElement {
  const card = createElement("div", { class: "about-update", "data-testid": "about-update" });
  card.hidden = true;
  let offer: AvailableUpdate | null = null;
  let installState: UpdateInstallState = { status: "idle" };
  let current: string | null = null;

  const title = createElement("div", { class: "about-update-title" });
  const desc = createElement("div", { class: "setting-desc" });
  const text = createElement("div", { class: "about-update-text" });
  appendChildren(text, title, desc);
  const installBtn = createElement(
    "button",
    { class: "ac-btn about-update-install", type: "button" },
    t("about.updateNow"),
  );
  const head = createElement("div", { class: "about-update-head" });
  const tile = createElement("div", { class: "about-update-icon" });
  tile.appendChild(createIcon("download", 22));
  appendChildren(head, tile, text, installBtn);
  const notesTitle = createElement("div", { class: "about-update-eyebrow" });
  const notes = createElement("div", {
    class: "about-update-notes",
    tabindex: "0",
    role: "region",
  });
  card.append(head, notes);

  const renderDesc = (): void => {
    const busy = installInProgressText(installState);
    installBtn.disabled = busy !== null;
    if (busy !== null) desc.textContent = busy;
    else if (current !== null) desc.textContent = t("about.updateDesc", { current });
    else desc.textContent = t("about.updateDescNoVersion");
  };

  const render = (next: AvailableUpdate | null): void => {
    offer = next;
    card.hidden = next === null;
    if (next === null) return;
    title.textContent = t("about.updateTitle", { version: next.version });
    notesTitle.textContent = t("about.updateNotesFor", { version: next.version });
    notes.setAttribute("aria-label", t("about.updateNotesLabel", { version: next.version }));
    clearChildren(notes);
    notes.appendChild(notesTitle);
    notes.appendChild(
      next.body.trim() !== ""
        ? renderChangelogBody(next.body)
        : externalLink(
            releaseUrl(next.version),
            t("about.updateNotesMissing"),
            "about-notes-missing",
          ),
    );
    renderDesc();
  };

  installBtn.addEventListener(
    "click",
    () => {
      if (offer === null) return;
      void downloadAndInstallUpdate(offer.serverUrl).catch((err: unknown) => {
        log.error("Update install failed", { error: String(err) });
      });
    },
    { signal },
  );

  const unsubOffer = subscribeAvailableUpdate(render);
  const unsubInstall = subscribeToUpdateInstall((state) => {
    installState = state;
    renderDesc();
  });
  signal.addEventListener(
    "abort",
    () => {
      unsubOffer();
      unsubInstall();
    },
    { once: true },
  );
  void installed.then((version) => {
    if (version === null || signal.aborted) return;
    current = version;
    renderDesc();
  });
  return card;
}

export function buildAboutTab(signal: AbortSignal): HTMLDivElement {
  const section = createElement("div", { class: "settings-pane active about-tab" });

  const header = createElement("div", { class: "settings-card about-header" });
  const name = createElement(
    "div",
    { class: "about-name", "data-testid": "about-version" },
    t("about.appNameUnknown"),
  );
  appendChildren(
    header,
    name,
    createElement("div", { class: "setting-desc" }, t("about.desktop")),
    externalLink(REPO_URL, t("about.github"), "about-repo-link"),
  );
  section.appendChild(header);

  const versionRead = readAppVersion();
  // The update offer and the check are the desktop updater's; a platform with
  // none (the web build) does not draw them.
  if (desktop.updater.available) {
    section.appendChild(buildUpdateCard(signal, versionRead));
    section.appendChild(buildUpdateCheckRow(signal));
  }

  const notesTitle = createElement("h3", { class: "setting-group-title" });
  // Focusable so the keyboard can scroll long notes, as in the What's new window.
  const notes = createElement("div", {
    class: "about-notes",
    "data-testid": "about-notes",
    tabindex: "0",
    role: "region",
    "aria-label": t("about.notesLabel"),
  });
  const historyTitle = createElement("h3", { class: "setting-group-title" }, t("about.history"));
  const history = createElement("div", {});
  appendChildren(section, notesTitle, notes, historyTitle, history);

  void versionRead.then((version) => {
    if (version !== null && !signal.aborted) name.textContent = t("about.appName", { version });
  });
  void Promise.all([versionRead, loadChangelog()])
    .then(([version, versions]) => {
      if (signal.aborted) return;
      const current = version !== null ? findVersion(versions, version) : null;
      clearChildren(notes);
      if (current !== null) {
        notesTitle.textContent = t("about.notesFor", { version: current.version });
        notes.appendChild(renderChangelogBody(current.body));
      } else {
        notesTitle.hidden = true;
        notes.appendChild(
          externalLink(
            version !== null ? releaseUrl(version) : `${REPO_URL}/releases`,
            t("about.notesMissing"),
            "about-notes-missing",
          ),
        );
      }
      history.replaceWith(buildHistory(versions.filter((v) => v !== current)));
    })
    .catch((err: unknown) => {
      log.warn("Release notes unavailable", { error: String(err) });
      if (signal.aborted) return;
      notesTitle.hidden = true;
      historyTitle.hidden = true;
      clearChildren(notes);
      notes.appendChild(externalLink(`${REPO_URL}/releases`, t("about.loadFailed"), ""));
    });

  return section;
}
