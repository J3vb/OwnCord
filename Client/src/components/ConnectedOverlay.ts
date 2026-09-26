/**
 * ConnectedOverlay — full-screen overlay shown after auth_ok,
 * displays server info while waiting for the ready event.
 * Matches login-mockup.html connected overlay structure.
 */

import { Disposable } from "@lib/disposable";
import { createElement, setText, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { connectText } from "../i18n/connect";

export interface ConnectedOverlayOptions {
  readonly serverName: string;
  readonly username: string;
  readonly motd: string;
  readonly onReady: () => void;
}

export interface ConnectedOverlayControl {
  readonly element: HTMLDivElement;
  /** Call when ready payload is received. */
  markReady(): void;
  /** Show the overlay (adds .visible class). */
  show(): void;
  destroy(): void;
}

const READY_DELAY_MS = 800;

function serverIconColor(name: string): string {
  const palette = [
    "#5865f2",
    "#57f287",
    "#fee75c",
    "#eb459e",
    "#ed4245",
    "#f0b232",
    "#2ecc71",
    "#e74c3c",
  ] as const;
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return palette[Math.abs(hash) % palette.length] ?? palette[0];
}

export function createConnectedOverlay(options: ConnectedOverlayOptions): ConnectedOverlayControl {
  const { serverName, username, motd, onReady } = options;
  const disposable = new Disposable();

  // Root overlay (hidden by default, .visible to show)
  const overlay = createElement("div", {
    class: "connected-overlay",
    "data-testid": "connected-overlay",
  });

  // Server icon with check badge
  const iconWrap = createElement("div", { class: "connected-icon-wrap" });
  const srvIcon = createElement("div", {
    class: "connected-srv-icon",
    style: `background:${serverIconColor(serverName)}`,
  });
  setText(srvIcon, serverName.charAt(0).toUpperCase());

  // Checkmark badge (matches mockup)
  const checkBadge = createElement("div", { class: "connected-check-badge" });
  checkBadge.appendChild(createIcon("check"));
  appendChildren(iconWrap, srvIcon, checkBadge);

  // Text elements
  const connectedText = createElement(
    "div",
    {
      class: "connected-text",
    },
    connectText("connected.title"),
  );

  const userText = createElement(
    "div",
    {
      class: "connected-user",
    },
    connectText("connected.loggedInAs", { username }),
  );

  const motdEl = createElement("div", { class: "connected-motd" });
  if (motd) {
    setText(motdEl, motd);
  }

  // Loader with spinner
  const loader = createElement("div", { class: "connected-loader" });
  const spinner = createElement("div", { class: "spinner" });
  const loaderText = createElement("span", {}, connectText("connected.loading"));
  appendChildren(loader, spinner, loaderText);

  appendChildren(overlay, iconWrap, connectedText, userText, motdEl, loader);

  function show(): void {
    overlay.classList.add("visible");
  }

  function markReady(): void {
    if (disposable.signal.aborted) return;

    spinner.style.display = "none";
    loaderText.textContent = "";
    loaderText.appendChild(createIcon("check", 16));
    loaderText.appendChild(document.createTextNode(` ${connectText("connected.ready")}`));

    const timer = setTimeout(() => {
      if (!disposable.signal.aborted) {
        onReady();
      }
    }, READY_DELAY_MS);

    disposable.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  }

  function destroy(): void {
    disposable.destroy();
    overlay.remove();
  }

  return { element: overlay, markReady, show, destroy };
}
