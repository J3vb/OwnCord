/**
 * The Command Deck top bar: the server's name on the left, search as a button
 * styled as a field in the centre, and the connection state on the right. It is
 * built detached; `mountDeckFrame` attaches it. Its subscriptions and window
 * listeners belong to the `owner` it is given, so a build that fails later
 * releases them with `owner.destroy()`.
 */
import type { Disposable } from "@lib/disposable";
import { createElement } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { authStore } from "@stores/auth.store";
import { uiStore } from "@stores/ui.store";
import { messagingText } from "../../i18n/messaging";
import { shellText } from "../../i18n/shell";
import {
  connectionLabel,
  deviceNetworkOffline,
  type ConnectionLabel,
} from "../connection/connectionBanner";

const LABEL_TEXT: Readonly<Record<ConnectionLabel, Parameters<typeof shellText>[0]>> = {
  elsewhere: "banner.signedInElsewhere",
  connected: "deck.connected",
  offline: "deck.offline",
  reconnecting: "banner.reconnecting",
  unreachable: "deck.unreachable",
};

/** The connection state: an LED and its words, kept true from the store and the device's network. */
function createConnection(owner: Disposable): HTMLDivElement {
  const led = createElement("span", { class: "deck-led", "aria-hidden": "true" });
  const text = createElement("span", { class: "deck-connection-text" });
  const root = createElement("div", { class: "deck-connection", "data-testid": "deck-connection" });
  root.append(led, text);

  const render = (): void => {
    const s = uiStore.getState();
    const label = connectionLabel({
      sessionReplaced: s.sessionReplaced,
      status: s.connectionStatus,
      dialFailed: s.connectionDialFailed,
      offline: deviceNetworkOffline(),
    });
    led.dataset["state"] = label;
    text.textContent = shellText(LABEL_TEXT[label]);
  };
  render();
  owner.onStoreChange(
    uiStore,
    (s) => ({
      status: s.connectionStatus,
      dialFailed: s.connectionDialFailed,
      sessionReplaced: s.sessionReplaced,
    }),
    render,
  );
  // `Disposable.onEvent` takes element event names only, so these two go on the signal directly.
  window.addEventListener("online", render, { signal: owner.signal });
  window.addEventListener("offline", render, { signal: owner.signal });
  return root;
}

/** Search as a button styled as a field. No shortcut hint: Ctrl+K is the Quick Switcher. */
function createSearchButton(onSearch: () => void): HTMLButtonElement {
  const label = messagingText("search.label");
  const button = createElement("button", {
    type: "button",
    class: "deck-search",
    "aria-label": label,
    "data-testid": "deck-search",
  });
  button.append(
    createIcon("search", 14),
    createElement("span", { class: "deck-search-text" }, label),
  );
  button.addEventListener("click", () => onSearch());
  return button;
}

/** A detached div.deck-top-bar, drawn once at build. Its subscriptions and listeners go on `owner`. */
export function createDeckTopBar(opts: {
  readonly onSearch: () => void;
  readonly owner: Disposable;
}): HTMLDivElement {
  const name = createElement("div", { class: "deck-top-name", "data-testid": "deck-top-name" });
  const draw = (serverName: string | null): void => {
    name.textContent = serverName ?? "";
  };
  draw(authStore.getState().serverName);
  opts.owner.onStoreChange(authStore, (s) => s.serverName, draw);

  const bar = createElement("div", { class: "deck-top-bar", "data-testid": "deck-top-bar" });
  bar.append(name, createSearchButton(opts.onSearch), createConnection(opts.owner));
  return bar;
}
