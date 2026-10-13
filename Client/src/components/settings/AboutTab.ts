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
import { buildUpdateCheckRow } from "../../features/updates/UpdateCheckRow";
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

  section.appendChild(buildUpdateCheckRow(signal));

  const notesTitle = createElement("h3", { class: "setting-group-title" });
  const notes = createElement("div", { class: "about-notes", "data-testid": "about-notes" });
  const historyTitle = createElement("h3", { class: "setting-group-title" }, t("about.history"));
  const history = createElement("div", {});
  appendChildren(section, notesTitle, notes, historyTitle, history);

  const versionRead = readAppVersion();
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
