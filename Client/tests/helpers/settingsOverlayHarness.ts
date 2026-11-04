import { expect, vi, beforeEach, afterEach } from "vitest";
import { createSettingsOverlay } from "../../src/features/settings/SettingsOverlay";
import type { SettingsOverlayOptions } from "../../src/features/settings/SettingsOverlay";
import { baseOptions } from "./settingsOverlayOptions";
import * as attachments from "../../src/features/messaging/content/attachments";
import * as formatting from "@lib/text/formatting";
import * as media from "../../src/features/messaging/content/media";
import * as channelMutes from "@lib/prefs/channelMutes";
import {
  mockAppVersion,
  mockUiState,
  uiSubscriptions,
  mockAuthState,
} from "./settingsOverlayMocks";

// vi.doMock resolves a relative id from the calling test file; a
// root-relative id works from any test directory.
export const APP_LIFETIME_MODULES = [
  ["/src/features/messaging/content/attachments", attachments],
  ["@lib/text/formatting", formatting],
  ["/src/features/messaging/content/media", media],
  ["@lib/prefs/channelMutes", channelMutes],
] as const;

export function clickEl(el: Element | null): void {
  expect(el).not.toBeNull();
  (el as HTMLElement).click();
}

export function getTab(container: HTMLDivElement, index: number): HTMLElement {
  const tabs = container.querySelectorAll(".settings-sidebar > button.settings-nav-item");
  const tab = tabs[index];
  expect(tab).toBeDefined();
  return tab as HTMLElement;
}

export const defaultOptions = baseOptions();

/** Creates, mounts and opens a settings overlay over `container`. */
export function openOverlay(
  container: HTMLElement,
  options: SettingsOverlayOptions = defaultOptions,
): ReturnType<typeof createSettingsOverlay> {
  const overlay = createSettingsOverlay(options);
  overlay.mount(container);
  overlay.open();
  return overlay;
}

/** The account tab button whose text is exactly `label`. */
export function acButton(container: ParentNode, label: string): HTMLButtonElement {
  return Array.from(container.querySelectorAll(".ac-btn")).find(
    (b) => b.textContent === label,
  ) as HTMLButtonElement;
}

/** Lookup by `data-testid`; like a bare cast, it yields null-at-runtime when absent. */
export function testId<T extends Element = HTMLElement>(container: ParentNode, id: string): T {
  return container.querySelector(`[data-testid='${id}']`) as T;
}

/** Opens the delete-account prompt, types the password and confirms; returns the confirm button. */
export function submitDeleteAccount(container: ParentNode, password: string): HTMLButtonElement {
  testId(container, "delete-account-trigger").click();
  testId<HTMLInputElement>(container, "delete-account-password").value = password;
  const confirm = testId<HTMLButtonElement>(container, "delete-account-confirm");
  confirm.click();
  return confirm;
}

/** Fills the change-password form and returns its three inputs in order. */
export function fillPasswordForm(
  container: ParentNode,
  current: string,
  next: string,
  confirm: string,
): NodeListOf<HTMLInputElement> {
  const inputs = container.querySelectorAll<HTMLInputElement>("#pw-old, #pw-new, #pw-confirm");
  inputs[0]!.value = current;
  inputs[1]!.value = next;
  inputs[2]!.value = confirm;
  return inputs;
}

/** Registers the shared beforeEach/afterEach for the SettingsOverlay describes; `bind` receives each fresh container. */
export function useSettingsOverlayHarness(bind: (el: HTMLDivElement) => void): void {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    bind(container);
    localStorage.clear();
    vi.clearAllMocks();
    mockAppVersion.mockResolvedValue("1.2.3-test");
    mockAuthState.user = { id: 1, username: "testuser", totp_enabled: false, display_name: null };
    mockUiState.settingsOpen = false;
    mockUiState.settingsTab = null;
    mockUiState.settingsTabSeq = 0;
    uiSubscriptions.all.length = 0;
  });

  afterEach(() => {
    container.remove();
  });
}
