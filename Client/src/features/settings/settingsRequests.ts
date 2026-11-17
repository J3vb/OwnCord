/** How other surfaces drive Settings: the open flag and tab requests, including
 *  the parts of the Account tab ("Profile", "Devices") a request can ask for. */

import { uiStore, type SettingsTabRequest } from "@stores/ui.store";
import { openProfileEditor } from "./AccountProfile";
import { revealSessions } from "./AccountSessions";
import { ACCOUNT } from "./settingsTabs";

/** The tab the last request names; "Profile" and "Devices" are parts of Account. */
export function requestedTab(): Exclude<SettingsTabRequest, "Profile" | "Devices"> | null {
  const raw = uiStore.getState().settingsTab;
  return raw === "Profile" || raw === "Devices" ? ACCOUNT : raw;
}

/** Open the part of the Account tab in `content` that the last request asked
 *  for. A tab built since that request already lists the devices afresh, so
 *  only one built before it reloads them. */
export function revealRequestedPart(content: ParentNode, rebuilt: boolean): void {
  const raw = uiStore.getState().settingsTab;
  if (raw === "Profile") openProfileEditor(content);
  else if (raw === "Devices") revealSessions(content, !rebuilt);
}

/** Calls `onOpen` as the panel opens or closes and `onTabRequest` on every tab
 *  request: each bumps `settingsTabSeq`, so a repeat of the same tab is heard. */
export function subscribeSettingsRequests(
  onOpen: (open: boolean) => void,
  onTabRequest: () => void,
): Array<() => void> {
  return [
    uiStore.subscribeSelector((s) => s.settingsOpen, onOpen),
    uiStore.subscribeSelector((s) => s.settingsTabSeq, onTabRequest),
  ];
}
