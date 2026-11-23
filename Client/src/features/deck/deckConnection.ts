/**
 * The connection state as Command Deck draws it: an LED, and with `text` its
 * words. The top bar draws both; the server tree's root row draws only the LED.
 * It is kept true from the store and the device's network, and its
 * subscriptions and window listeners belong to the `owner` it is given.
 */
import type { Disposable } from "@lib/disposable";
import { createElement } from "@lib/dom";
import { uiStore } from "@stores/ui.store";
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

/** `div.deck-connection` (LED and words) with `text`, otherwise the bare `.deck-led`. */
export function createDeckConnection(
  owner: Disposable,
  opts: { readonly text: boolean },
): HTMLElement {
  const led = createElement("span", { class: "deck-led", "aria-hidden": "true" });
  const words = opts.text ? createElement("span", { class: "deck-connection-text" }) : null;

  const render = (): void => {
    const s = uiStore.getState();
    const label = connectionLabel({
      sessionReplaced: s.sessionReplaced,
      status: s.connectionStatus,
      dialFailed: s.connectionDialFailed,
      offline: deviceNetworkOffline(),
    });
    led.dataset["state"] = label;
    if (words !== null) words.textContent = shellText(LABEL_TEXT[label]);
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

  if (words === null) return led;
  const root = createElement("div", { class: "deck-connection", "data-testid": "deck-connection" });
  root.append(led, words);
  return root;
}
