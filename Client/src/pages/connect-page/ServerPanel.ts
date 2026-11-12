// ServerPanel — server profile list sub-component for ConnectPage.
// Pure extraction from ConnectPage.ts. No behavior changes.

import { Disposable } from "@lib/disposable";
import { createElement, setText, appendChildren, clearChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { Compatibility, HealthStatus, ServerProfile } from "@lib/presence/profiles";
import { loadCredential } from "@lib/net/credentials";
import { createLogger } from "@lib/logger";
import { connectText } from "../../i18n/connect";
import {
  applyCompatToRow,
  applyHealthToRow,
  confirmDeleteProfile as confirmDeleteProfileDom,
  openAddServerModal,
  type HealthRowElements,
} from "./serverPanelParts";

const log = createLogger("server-panel");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal profile shape for the default profile list (backward compat). */
export interface SimpleProfile {
  readonly name: string;
  readonly host: string;
  /** An unsaved placeholder (fresh install); it never blocks adding the same host. */
  readonly synthetic?: boolean;
}

/** Color palette for server icons. */
const ICON_COLORS = [
  "#5865F2",
  "#57F287",
  "#FEE75C",
  "#EB459E",
  "#ED4245",
  "#3BA55D",
  "#FAA61A",
  "#5865F2",
];

function getIconColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return ICON_COLORS[Math.abs(hash) % ICON_COLORS.length] ?? "#5865f2";
}

function getIconInitials(name: string): string {
  return name.charAt(0).toUpperCase();
}

// ---------------------------------------------------------------------------
// Options & Return type
// ---------------------------------------------------------------------------

export interface ServerPanelOptions {
  readonly signal: AbortSignal;
  /** Called immediately when the user clicks a server profile. */
  /**
   * `autoConnect` / `rememberPassword` are the saved profile's own settings;
   * both are undefined for an unsaved placeholder row.
   */
  readonly onServerClick: (
    host: string,
    username?: string,
    autoConnect?: boolean,
    rememberPassword?: boolean,
  ) => void;
  /** Called after async credential lookup succeeds (may set password). */
  readonly onCredentialLoaded: (host: string, username: string, hasPassword?: boolean) => void;
  readonly onAddProfile?: (name: string, host: string) => void;
  readonly onDeleteProfile?: (profileId: string) => void;
  /** Called when the user toggles auto-login on a server profile. */
  readonly onToggleAutoLogin?: (profileId: string, enabled: boolean) => void;
}

export interface ServerPanelApi {
  readonly element: HTMLDivElement;
  renderProfiles(profiles: readonly SimpleProfile[]): void;
  updateHealthStatus(host: string, status: HealthStatus): void;
  /**
   * Advisory epoch-compatibility badge. It NEVER disables Connect — the
   * WebSocket auth_error stays authoritative.
   */
  updateCompatibility(host: string, compatibility: Compatibility): void;
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createServerPanel(
  opts: ServerPanelOptions,
  initialProfiles: readonly SimpleProfile[],
): ServerPanelApi {
  // The list last rendered; the add-server guard checks it for a duplicate host.
  let knownProfiles: readonly SimpleProfile[] = initialProfiles;
  // Monotonic token: only the newest credential load may apply.
  let credentialLoadSeq = 0;
  const {
    signal,
    onServerClick,
    onCredentialLoaded,
    onAddProfile,
    onDeleteProfile,
    onToggleAutoLogin,
  } = opts;

  // Host -> the health-status elements of EVERY row with that host. Two
  // profiles may share a host (same server, different accounts); a single
  // slot per host left all but the last row's dot stale (F8).
  const healthElements = new Map<string, HealthRowElements[]>();

  // Cached DOM references
  let serverListEl: HTMLDivElement;

  // renderServerProfiles rebuilds every row from scratch on every profile
  // load/add/delete/toggle. Per-row listeners must NOT be registered on the
  // page-lifetime `signal`, which only aborts once, at page teardown --
  // addEventListener({ signal }) keeps a detached row reachable via that
  // signal's own retained abort-listener list until it fires, so every
  // re-render would otherwise leak the previous generation's rows,
  // the same defect already fixed in MemberList/ChannelSidebar/MessageList.
  // renderOwner is aborted and replaced at the top of every render, so only the
  // CURRENT render's rows stay reachable.
  let renderOwner: Disposable | null = null;

  // ---------------------------------------------------------------------------
  // DOM construction
  // ---------------------------------------------------------------------------

  let toggleBtn: HTMLButtonElement;
  let listOpen = false;

  function setListOpen(open: boolean): void {
    listOpen = open;
    panelEl.classList.toggle("server-panel--collapsed", !open);
    toggleBtn.setAttribute("aria-expanded", String(open));
    toggleBtn.setAttribute(
      "aria-label",
      connectText(open ? "servers.hideList" : "servers.showList"),
    );
  }

  function buildPanel(): HTMLDivElement {
    const panel = createElement("div", { class: "server-panel" });

    // On a phone the panel stacks above the form and folds down to the
    // selected server; the toggle is hidden on wider screens (login.css).
    panel.classList.add("server-panel--collapsed");
    const header = createElement("div", { class: "server-panel-header" });
    const heading = createElement("h2", {}, connectText("servers.heading"));
    toggleBtn = createElement("button", {
      class: "server-panel-toggle",
      type: "button",
      "aria-expanded": "false",
      "aria-controls": "server-list",
      "aria-label": connectText("servers.showList"),
      "data-testid": "server-panel-toggle",
    });
    toggleBtn.addEventListener("click", () => setListOpen(!listOpen), { signal });
    appendChildren(header, heading, toggleBtn);

    serverListEl = createElement("div", { class: "server-list", id: "server-list" });

    renderServerProfiles(initialProfiles);

    // Footer with "Add Server" button
    const footer = createElement("div", { class: "server-panel-footer" });
    const addBtn = createElement("button", {
      class: "btn-add-server",
      type: "button",
    });
    setText(addBtn, connectText("servers.addButton"));
    addBtn.addEventListener("click", handleAddServer, { signal });
    footer.appendChild(addBtn);

    appendChildren(panel, header, serverListEl, footer);
    return panel;
  }

  function renderServerProfiles(profiles: readonly SimpleProfile[]): void {
    knownProfiles = profiles;
    renderOwner?.destroy();
    const currentRender = new Disposable();
    renderOwner = currentRender;
    const rowSignal = currentRender.signal;

    clearChildren(serverListEl);
    healthElements.clear();
    if (profiles.length === 0) {
      // A fresh install with no saved profiles is a real state, not a blank
      // panel; the footer's Add Server is the way out (#19).
      serverListEl.appendChild(
        createElement(
          "div",
          { class: "server-list-empty", "data-testid": "server-list-empty" },
          connectText("servers.empty"),
        ),
      );
      return;
    }
    for (const profile of profiles) {
      const item = createElement("div", {
        class: "server-item",
        "data-host": profile.host,
        // Keyboard users reach the same rows a pointer does (#19).
        role: "button",
        tabindex: "0",
      });

      const icon = createElement("div", {
        class: "srv-icon",
        style: `background:${getIconColor(profile.name)}`,
      });
      setText(icon, getIconInitials(profile.name));

      // Health status dot — placed as sibling after info, not inside icon
      const statusDot = createElement("div", { class: "srv-status-dot unknown" });

      const info = createElement("div", { class: "srv-info" });
      const name = createElement("div", { class: "srv-name" }, profile.name);
      const meta = createElement("div", { class: "srv-meta" });
      const host = createElement("span", { class: "srv-host" }, profile.host);
      const latency = createElement("span", { class: "srv-latency" });
      const onlineUsersEl = createElement("span", { class: "srv-online-users" });
      // Advisory epoch badge: text + modifier class set by
      // updateCompatibility; empty and inert until then.
      const compatEl = createElement("span", { class: "srv-compat-badge" });
      appendChildren(meta, host, latency, onlineUsersEl, compatEl);

      // Show username if available (full profile has it)
      const fullProfile = profile as Partial<ServerProfile>;
      if (fullProfile.username) {
        const usernameEl = createElement("span", { class: "srv-host" }, fullProfile.username);
        appendChildren(meta, usernameEl);
      }

      appendChildren(info, name, meta);

      const entry = {
        dot: statusDot,
        latency,
        onlineUsers: onlineUsersEl,
        compat: compatEl,
      };
      const existing = healthElements.get(profile.host);
      if (existing === undefined) healthElements.set(profile.host, [entry]);
      else existing.push(entry);

      // Action buttons (auto-login toggle + delete)
      const actions = createElement("div", { class: "srv-actions" });

      // Auto-login toggle (only for full profiles)
      if (fullProfile.id && onToggleAutoLogin) {
        const isAutoLogin = fullProfile.autoConnect === true;
        const autoLoginBtn = createElement("button", {
          class: `srv-btn auto-login${isAutoLogin ? " active" : ""}`,
          type: "button",
          "aria-label": connectText(
            isAutoLogin ? "servers.autoLogin.disable" : "servers.autoLogin.enable",
          ),
          title: connectText(
            isAutoLogin ? "servers.autoLogin.enabled" : "servers.autoLogin.enable",
          ),
        });
        autoLoginBtn.textContent = "";
        autoLoginBtn.appendChild(createIcon("zap", 14));
        autoLoginBtn.addEventListener(
          "click",
          (e) => {
            e.stopPropagation();
            onToggleAutoLogin(fullProfile.id!, !isAutoLogin);
          },
          { signal: rowSignal },
        );
        actions.appendChild(autoLoginBtn);
      }

      // Delete button (only for full profiles that have an id)
      if (fullProfile.id && onDeleteProfile) {
        const deleteBtn = createElement("button", {
          class: "srv-btn danger",
          type: "button",
          "aria-label": connectText("servers.delete"),
        });
        deleteBtn.textContent = "";
        deleteBtn.appendChild(createIcon("x", 14));
        deleteBtn.addEventListener(
          "click",
          (e) => {
            e.stopPropagation();
            confirmDeleteProfile(fullProfile.id!, profile.name, onDeleteProfile, rowSignal);
          },
          { signal: rowSignal },
        );
        actions.appendChild(deleteBtn);
      }

      appendChildren(item, icon, info, statusDot, actions);

      const activate = (): void => {
        // The active profile gets a selected state; clicking is the only
        // writer and there was previously none (the CSS existed unused).
        for (const row of serverListEl.querySelectorAll(".server-item")) {
          row.classList.toggle("active", row === item);
        }
        if (listOpen) setListOpen(false);
        // Immediately fill host + username from profile
        const saved = profile.synthetic !== true;
        onServerClick(
          profile.host,
          fullProfile.username,
          saved ? fullProfile.autoConnect === true : undefined,
          saved ? fullProfile.rememberPassword === true : undefined,
        );
        // Auto-fill credentials from credential store (async)
        const requestedHost = profile.host;
        // Two profiles can share a host (same server, different accounts),
        // and `loadCredential` is keyed by host alone, so a slower earlier
        // click could resolve last and overwrite the selection the user
        // actually made. Only the newest click may apply its result. The
        // host check downstream is not enough on its own, and a mismatch is
        // no longer visible now that the password box shows identical dots.
        credentialLoadSeq += 1;
        const seq = credentialLoadSeq;
        // A profile that opted out must not pick up a stored credential that
        // outlived the opt-out.
        if (fullProfile.rememberPassword === false) return;
        void (async () => {
          try {
            const cred = await loadCredential(requestedHost);
            if (cred && seq === credentialLoadSeq) {
              onCredentialLoaded(requestedHost, cred.username, cred.hasPassword);
            }
          } catch (err) {
            log.debug("Credential auto-fill failed (best-effort, user can type manually)", {
              host: requestedHost,
              err,
            });
          }
        })();
      };

      item.addEventListener("click", activate, { signal: rowSignal });
      item.addEventListener(
        "keydown",
        (e: KeyboardEvent) => {
          if (e.target !== item) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            activate();
          }
        },
        { signal: rowSignal },
      );

      serverListEl.appendChild(item);
    }
  }

  function updateHealthStatus(host: string, status: HealthStatus): void {
    const rows = healthElements.get(host);
    if (!rows) return;

    for (const els of rows) applyHealthToRow(els, status);
  }

  function updateCompatibility(host: string, compatibility: Compatibility): void {
    const rows = healthElements.get(host);
    if (!rows) return;

    for (const els of rows) applyCompatToRow(els, compatibility);
  }

  // ---------------------------------------------------------------------------
  // Add Server modal
  // ---------------------------------------------------------------------------

  function confirmDeleteProfile(
    profileId: string,
    name: string,
    onConfirm: (id: string) => void,
    ownerSignal: AbortSignal,
  ): void {
    confirmDeleteProfileDom(panelEl, profileId, name, onConfirm, ownerSignal);
  }

  function handleAddServer(): void {
    if (!onAddProfile) return;
    openAddServerModal({
      anchor: panelEl,
      signal,
      getKnownProfiles: () => knownProfiles,
      onAddProfile,
    });
  }

  // ---------------------------------------------------------------------------
  // Build & return
  // ---------------------------------------------------------------------------

  const panelEl = buildPanel();

  return {
    element: panelEl,
    renderProfiles: renderServerProfiles,
    updateHealthStatus,
    updateCompatibility,
    destroy(): void {
      renderOwner?.destroy();
      renderOwner = null;
    },
  };
}
