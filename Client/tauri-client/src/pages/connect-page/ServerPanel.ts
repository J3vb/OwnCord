// ServerPanel — server profile list sub-component for ConnectPage.
// Pure extraction from ConnectPage.ts. No behavior changes.

import {
  createElement,
  setText,
  appendChildren,
  clearChildren,
} from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { HealthStatus, ServerProfile } from "@lib/profiles";
import { loadCredential } from "@lib/credentials";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal profile shape for the default profile list (backward compat). */
export interface SimpleProfile {
  readonly name: string;
  readonly host: string;
}

/** Color palette for server icons. */
const ICON_COLORS = [
  "#5865F2", "#57F287", "#FEE75C", "#EB459E", "#ED4245",
  "#3BA55D", "#FAA61A", "#5865F2",
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
  readonly onServerClick: (host: string, username?: string) => void;
  /** Called after async credential lookup succeeds (may set password). */
  readonly onCredentialLoaded: (host: string, username: string, password?: string) => void;
  readonly onAddProfile?: (name: string, host: string) => void;
  readonly onDeleteProfile?: (profileId: string) => void;
  /** Called when the user toggles auto-login on a server profile. */
  readonly onToggleAutoLogin?: (profileId: string, enabled: boolean) => void;
}

export interface ServerPanelApi {
  readonly element: HTMLDivElement;
  renderProfiles(profiles: readonly SimpleProfile[]): void;
  updateHealthStatus(host: string, status: HealthStatus): void;
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createServerPanel(
  opts: ServerPanelOptions,
  initialProfiles: readonly SimpleProfile[],
): ServerPanelApi {
  const { signal, onServerClick, onCredentialLoaded, onAddProfile, onDeleteProfile, onToggleAutoLogin } = opts;

  // Map of host -> DOM elements for health status updates
  const healthElements = new Map<string, { dot: HTMLDivElement; latency: HTMLSpanElement; onlineUsers: HTMLSpanElement }>();

  // Cached DOM references
  let serverListEl: HTMLDivElement;

  // ---------------------------------------------------------------------------
  // DOM construction
  // ---------------------------------------------------------------------------

  function buildPanel(): HTMLDivElement {
    const panel = createElement("div", { class: "server-panel" });

    const header = createElement("div", { class: "server-panel-header" });
    const heading = createElement("h2", {}, "Servers");
    header.appendChild(heading);

    serverListEl = createElement("div", { class: "server-list" });

    renderServerProfiles(initialProfiles);

    // Footer with "Add Server" button
    const footer = createElement("div", { class: "server-panel-footer" });
    const addBtn = createElement("button", {
      class: "btn-add-server",
      type: "button",
    });
    setText(addBtn, "+ Add Server");
    addBtn.addEventListener("click", handleAddServer, { signal });
    footer.appendChild(addBtn);

    appendChildren(panel, header, serverListEl, footer);
    return panel;
  }

  function renderServerProfiles(profiles: readonly SimpleProfile[]): void {
    clearChildren(serverListEl);
    healthElements.clear();
    for (const profile of profiles) {
      const item = createElement("div", {
        class: "server-item",
        "data-host": profile.host,
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
      appendChildren(meta, host, latency, onlineUsersEl);

      // Show username if available (full profile has it)
      const fullProfile = profile as Partial<ServerProfile>;
      if (fullProfile.username) {
        const usernameEl = createElement("span", { class: "srv-host" }, fullProfile.username);
        appendChildren(meta, usernameEl);
      }

      appendChildren(info, name, meta);

      healthElements.set(profile.host, { dot: statusDot, latency, onlineUsers: onlineUsersEl });

      // Action buttons (auto-login toggle + delete)
      const actions = createElement("div", { class: "srv-actions" });

      // Auto-login toggle (only for full profiles)
      if (fullProfile.id && onToggleAutoLogin) {
        const isAutoLogin = fullProfile.autoConnect === true;
        const autoLoginBtn = createElement("button", {
          class: `srv-btn auto-login${isAutoLogin ? " active" : ""}`,
          type: "button",
          "aria-label": isAutoLogin ? "Disable auto-login" : "Enable auto-login",
          title: isAutoLogin ? "Auto-login enabled" : "Enable auto-login",
        });
        autoLoginBtn.textContent = "";
        autoLoginBtn.appendChild(createIcon("zap", 14));
        autoLoginBtn.addEventListener(
          "click",
          (e) => {
            e.stopPropagation();
            onToggleAutoLogin(fullProfile.id!, !isAutoLogin);
          },
          { signal },
        );
        actions.appendChild(autoLoginBtn);
      }

      // Delete button (only for full profiles that have an id)
      if (fullProfile.id && onDeleteProfile) {
        const deleteBtn = createElement("button", {
          class: "srv-btn danger",
          type: "button",
          "aria-label": "Delete server",
        });
        deleteBtn.textContent = "";
        deleteBtn.appendChild(createIcon("x", 14));
        deleteBtn.addEventListener(
          "click",
          (e) => {
            e.stopPropagation();
            onDeleteProfile(fullProfile.id!);
          },
          { signal },
        );
        actions.appendChild(deleteBtn);
      }

      appendChildren(item, icon, info, statusDot, actions);

      item.addEventListener(
        "click",
        () => {
          // Immediately fill host + username from profile
          onServerClick(profile.host, fullProfile.username);
          // Auto-fill credentials from credential store (async)
          const requestedHost = profile.host;
          void (async () => {
            const cred = await loadCredential(requestedHost);
            if (cred) {
              onCredentialLoaded(requestedHost, cred.username, cred.password);
            }
          })();
        },
        { signal },
      );

      serverListEl.appendChild(item);
    }
  }

  function updateHealthStatus(host: string, status: HealthStatus): void {
    const els = healthElements.get(host);
    if (!els) return;

    // Update status dot
    els.dot.className = `srv-status-dot ${status.status}`;

    // Update latency badge
    if (status.latencyMs !== null) {
      const ms = status.latencyMs;
      setText(els.latency, `${ms}ms`);
      els.latency.className = `srv-latency ${ms < 100 ? "good" : ms < 500 ? "warn" : "bad"}`;
    } else {
      setText(els.latency, "");
      els.latency.className = "srv-latency";
    }

    // Update online users count
    if (status.onlineUsers !== null && status.onlineUsers >= 0) {
      setText(els.onlineUsers, `${status.onlineUsers} online`);
      els.onlineUsers.className = `srv-online-users ${status.onlineUsers > 0 ? "has-users" : ""}`;
    } else {
      setText(els.onlineUsers, "");
      els.onlineUsers.className = "srv-online-users";
    }
  }

  // ---------------------------------------------------------------------------
  // Add Server modal
  // ---------------------------------------------------------------------------

  function handleAddServer(): void {
    if (!onAddProfile) return;

    const overlay = createElement("div", { class: "modal-overlay visible" });
    const modal = createElement("div", { class: "modal" });

    const header = createElement("div", { class: "modal-header" });
    const title = createElement("h3", {}, "Add Server");
    const closeBtn = createElement("button", { class: "modal-close", type: "button" });
    closeBtn.textContent = "";
    closeBtn.appendChild(createIcon("x", 14));
    appendChildren(header, title, closeBtn);

    const body = createElement("div", { class: "modal-body" });
    const nameGroup = createElement("div", { class: "form-group" });
    const nameLabel = createElement("label", { class: "form-label" }, "Server Name");
    const nameInput = createElement("input", {
      class: "form-input",
      type: "text",
      placeholder: "My Server",
    });
    appendChildren(nameGroup, nameLabel, nameInput);

    const hostGroup = createElement("div", { class: "form-group" });
    const hostLabel = createElement("label", { class: "form-label" }, "Host Address");
    const hostAddrInput = createElement("input", {
      class: "form-input",
      type: "text",
      placeholder: "example.com:8443",
    });
    appendChildren(hostGroup, hostLabel, hostAddrInput);

    appendChildren(body, nameGroup, hostGroup);

    const footer = createElement("div", { class: "modal-footer" });
    const cancelBtn = createElement("button", { class: "btn-ghost", type: "button" });
    setText(cancelBtn, "Cancel");
    const saveBtn = createElement("button", { class: "btn-primary", type: "button" });
    setText(saveBtn, "Add Server");
    appendChildren(footer, cancelBtn, saveBtn);

    appendChildren(modal, header, body, footer);
    overlay.appendChild(modal);

    function closeModal(): void {
      overlay.remove();
    }

    function handleSave(): void {
      const name = (nameInput as HTMLInputElement).value.trim();
      const addr = (hostAddrInput as HTMLInputElement).value.trim();
      if (!name || !addr) return;
      onAddProfile!(name, addr);
      closeModal();
    }

    closeBtn.addEventListener("click", closeModal, { signal });
    cancelBtn.addEventListener("click", closeModal, { signal });
    saveBtn.addEventListener("click", handleSave, { signal });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeModal();
    }, { signal });

    // Allow backdrop stop propagation on modal body
    modal.addEventListener("click", (e) => e.stopPropagation(), { signal });

    // Enter key submits
    hostAddrInput.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") handleSave();
    }, { signal });

    // Mount onto the panel's closest connect-page root
    const root = panelEl.closest(".connect-page") ?? document.body;
    root.appendChild(overlay);
    (nameInput as HTMLInputElement).focus();
  }

  // ---------------------------------------------------------------------------
  // Build & return
  // ---------------------------------------------------------------------------

  const panelEl = buildPanel();

  return {
    element: panelEl,
    renderProfiles: renderServerProfiles,
    updateHealthStatus,
    destroy(): void {
      // Cleanup is handled by the shared AbortSignal from the parent
    },
  };
}
