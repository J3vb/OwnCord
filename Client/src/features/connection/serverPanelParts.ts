/**
 * Pieces of the server panel's DOM: the per-row health and compatibility badges,
 * the delete-profile confirmation and the add-server modal. The panel owns the
 * state and passes in what each reads.
 */
import { Disposable } from "@lib/disposable";
import { isImeCommit } from "@lib/text/ime";
import { createElement, setText, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { createModal } from "@lib/ui/modalFactory";
import { statusForLatency } from "@lib/presence/latency";
import type { Compatibility, HealthStatus } from "@lib/presence/profiles";
import { isValidHost } from "@lib/net/hostValidation";
import { canonicalServerHost, setAddressInputHints } from "@lib/net/hostNormalize";
import { connectText } from "../../i18n/connect";

/** The status elements of one server row. */
export interface HealthRowElements {
  dot: HTMLDivElement;
  latency: HTMLSpanElement;
  onlineUsers: HTMLSpanElement;
  compat: HTMLSpanElement;
}

/** The part of a saved profile the add-server guard reads. */
export interface KnownProfileRef {
  readonly host: string;
  readonly synthetic?: boolean;
}

/** Show one health report on a row: the dot, the latency badge and the online count. */
export function applyHealthToRow(els: HealthRowElements, status: HealthStatus): void {
  // Update status dot
  els.dot.className = `srv-status-dot ${status.status}`;

  // Update latency badge: the same cut-off as the dot, so the two agree
  if (status.latencyMs !== null) {
    const ms = status.latencyMs;
    setText(els.latency, connectText("servers.latency", { ms }));
    els.latency.className = `srv-latency ${statusForLatency(ms) === "online" ? "good" : "warn"}`;
  } else {
    setText(els.latency, "");
    els.latency.className = "srv-latency";
  }

  // Update online users count
  if (status.onlineUsers !== null && status.onlineUsers >= 0) {
    setText(els.onlineUsers, connectText("servers.online", { count: status.onlineUsers }));
    els.onlineUsers.className = `srv-online-users ${status.onlineUsers > 0 ? "has-users" : ""}`;
  } else {
    setText(els.onlineUsers, "");
    els.onlineUsers.className = "srv-online-users";
  }
}

/** Show one compatibility verdict on a row; only a real mismatch earns a badge. */
export function applyCompatToRow(els: HealthRowElements, compatibility: Compatibility): void {
  if (compatibility === "client-older") {
    setText(els.compat, connectText("servers.clientUpdateNeeded"));
    els.compat.className = "srv-compat-badge client-older";
  } else if (compatibility === "server-older") {
    setText(els.compat, connectText("servers.serverUpdateNeeded"));
    els.compat.className = "srv-compat-badge server-older";
  } else {
    setText(els.compat, "");
    els.compat.className = "srv-compat-badge";
  }
}

/** Confirm before deleting a saved profile — a one-click, hover-only delete
 *  had no undo and no warning (#19). */
export function confirmDeleteProfile(
  anchor: Element,
  profileId: string,
  name: string,
  onConfirm: (id: string) => void,
  ownerSignal: AbortSignal,
): void {
  const header = createElement("div", { class: "modal-header" });
  header.appendChild(
    createElement("h3", { id: "delete-server-title" }, connectText("servers.deleteConfirmTitle")),
  );
  const body = createElement(
    "div",
    { class: "modal-body" },
    connectText("servers.deleteConfirmBody", { name }),
  );
  const footer = createElement("div", { class: "modal-footer" });
  const cancel = createElement(
    "button",
    { class: "btn-ghost", type: "button", "data-testid": "cancel-delete-server" },
    connectText("common.cancel"),
  );
  const confirm = createElement(
    "button",
    { class: "btn-danger", type: "button", "data-testid": "confirm-delete-server" },
    connectText("servers.delete"),
  );
  appendChildren(footer, cancel, confirm);
  const content = createElement("div", {});
  appendChildren(content, header, body, footer);

  const modal = createModal(
    {
      content,
      ariaLabelledBy: "delete-server-title",
      signal: ownerSignal,
      onClose: () => {},
    },
    // Inside .server-panel the login form paints over the buttons (#19).
    anchor.closest(".connect-page") ?? document.body,
  );
  cancel.addEventListener("click", () => modal.destroy(), { signal: ownerSignal });
  confirm.addEventListener("click", () => {
    modal.destroy();
    onConfirm(profileId);
  });
}

export interface AddServerModalOptions {
  /** The panel element: the modal mounts on its closest connect-page root. */
  readonly anchor: Element;
  /** The page-lifetime signal; an open modal is torn down when it aborts. */
  readonly signal: AbortSignal;
  /** The list last rendered, read when the user saves. */
  readonly getKnownProfiles: () => readonly KnownProfileRef[];
  readonly onAddProfile: (name: string, host: string) => void;
}

export function openAddServerModal(opts: AddServerModalOptions): void {
  const { anchor, signal, getKnownProfiles, onAddProfile } = opts;

  const header = createElement("div", { class: "modal-header" });
  const title = createElement("h3", { id: "add-server-title" }, connectText("servers.add.title"));
  // Icon-only button: the aria-label is its whole accessible name.
  const closeBtn = createElement("button", {
    class: "modal-close",
    type: "button",
    "aria-label": connectText("common.close"),
  });
  closeBtn.textContent = "";
  closeBtn.appendChild(createIcon("x", 14));
  appendChildren(header, title, closeBtn);

  const body = createElement("div", { class: "modal-body" });
  const nameGroup = createElement("div", { class: "form-group" });
  const nameLabel = createElement(
    "label",
    { class: "form-label" },
    connectText("servers.add.nameLabel"),
  );
  const nameInput = createElement("input", {
    class: "form-input",
    type: "text",
    placeholder: connectText("servers.add.namePlaceholder"),
  });
  appendChildren(nameGroup, nameLabel, nameInput);

  const hostGroup = createElement("div", { class: "form-group" });
  const hostLabel = createElement(
    "label",
    { class: "form-label" },
    connectText("servers.add.hostLabel"),
  );
  const hostAddrInput = createElement("input", {
    class: "form-input",
    type: "text",
    placeholder: "example.com:8443", // i18n-exempt: example host:port, the same in every language
  });
  setAddressInputHints(hostAddrInput);
  appendChildren(hostGroup, hostLabel, hostAddrInput);

  appendChildren(body, nameGroup, hostGroup);

  const footer = createElement("div", { class: "modal-footer" });
  const cancelBtn = createElement("button", { class: "btn-ghost", type: "button" });
  setText(cancelBtn, connectText("common.cancel"));
  const saveBtn = createElement("button", { class: "btn-primary", type: "button" });
  setText(saveBtn, connectText("servers.add.submit"));
  appendChildren(footer, cancelBtn, saveBtn);

  // Each open modal gets its own Disposable so closeModal() can
  // release its own button listeners; registering them on the
  // page-lifetime `signal` instead (which only aborts once, at page
  // teardown) would keep every discarded modal subtree reachable until
  // then. Chained to the page signal so an open modal is also
  // torn down on page teardown.
  const modalOwner = new Disposable();
  signal.addEventListener("abort", () => modalOwner.destroy(), {
    once: true,
    signal: modalOwner.signal,
  });

  function closeModal(): void {
    modalOwner.destroy();
    instance.destroy();
  }

  // A self-contained local modal with no caller-owned destroy() to
  // decouple from, so backdrop click and Escape close it directly through
  // the factory; dialog semantics, focus trap and focus save/restore come
  // from there too. Mounted onto the panel's closest connect-page root.
  const root = anchor.closest(".connect-page") ?? document.body;
  const instance = createModal(
    {
      content: header,
      ariaLabelledBy: "add-server-title",
      onClose: closeModal,
      // Also tears the modal down on page teardown (the chained abort of
      // modalOwner above), not just on backdrop click / Escape / Save.
      signal: modalOwner.signal,
    },
    root,
  );
  appendChildren(instance.modal, body, footer);

  function handleSave(): void {
    const name = nameInput.value.trim();
    const addr = canonicalServerHost(hostAddrInput.value);
    if (!name || !addr) return;
    // Validate address: must be a valid host or host:port (DNS name, IPv4,
    // bracketed/bare IPv6) — no paths, no special chars. Shared with
    // api.ts's setConfig so an address accepted here is also accepted by
    // the actual connection path, and vice versa.
    if (!isValidHost(addr)) {
      // Show inline validation error via the host input
      hostAddrInput.setCustomValidity(connectText("servers.add.invalidHost"));
      hostAddrInput.reportValidity();
      return;
    }
    // Credentials are stored per host, so a second profile for the same host
    // would share (and overwrite) the first one's saved sign-in.
    if (getKnownProfiles().some((p) => !p.synthetic && p.host.toLowerCase() === addr)) {
      hostAddrInput.setCustomValidity(connectText("servers.add.duplicateHost"));
      hostAddrInput.reportValidity();
      return;
    }
    hostAddrInput.setCustomValidity("");
    onAddProfile(name, addr);
    closeModal();
  }

  closeBtn.addEventListener("click", closeModal, { signal: modalOwner.signal });
  cancelBtn.addEventListener("click", closeModal, { signal: modalOwner.signal });
  saveBtn.addEventListener("click", handleSave, { signal: modalOwner.signal });

  // Enter key submits
  hostAddrInput.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Enter" && !isImeCommit(e)) handleSave();
    },
    { signal: modalOwner.signal },
  );

  nameInput.focus();
}
