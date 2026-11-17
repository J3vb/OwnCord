/**
 * The sound route control of a call, in the Android app: a round button that
 * shows where the call plays (speaker, earpiece, a headset) and opens the route
 * sheet to pick another. The routes, the one in use and the pick are the
 * host's (`mobileRoutes.ts`); this only draws them and passes a tap on.
 *
 * It sits with a call's full set of controls: the call view and the open DM
 * call. The small call bars keep Mute and Leave, one tap from there.
 *
 * The button shows where there is something to choose: in a call, with more
 * than one route, a microphone (Android routes a call only for an app that
 * captures) and no phone call holding the call.
 */

import { createElement, appendChildren, clearChildren } from "../../lib/dom";
import { createIcon, type IconName } from "../../lib/icons";
import { enableRovingNavigation, setRovingTabindex } from "../../lib/ui/a11y";
import { openBottomSheet } from "../../lib/ui/bottomSheet";
import { voiceStore, type VoiceState } from "../../stores/voice.store";
import { voiceText as t } from "../../i18n/voice";
import type {
  AudioRoute,
  AudioRouteKind,
  MobileAudioState,
} from "../../platform/contracts/mobileAudio";
import { mobileRouteStore, pickRoute } from "./mobileRoutes";

/** `call` is the call view's control row, `dm` the DM call panel; each takes
 *  its bar's own button look. */
export type RouteVariant = "call" | "dm";

const VARIANT: Readonly<Record<RouteVariant, { readonly cls: string; readonly icon: number }>> = {
  call: { cls: "video-fs-btn", icon: 18 },
  dm: { cls: "dcp-btn", icon: 20 },
};

/** A row of the route sheet. */
const ROW = "[role='radio']";

const ROUTE_ICON: Readonly<Record<AudioRouteKind, IconName>> = {
  speaker: "volume-2",
  earpiece: "phone",
  wired: "headphones",
  bluetooth: "bluetooth",
};

function routeLabel(kind: AudioRouteKind): string {
  // i18n-exempt: catalog key assembled from the route kind
  return t(`route.${kind}`);
}

function routeShown(host: MobileAudioState, voice: VoiceState): boolean {
  return (
    host.supported &&
    host.routes.length > 1 &&
    voice.currentChannelId !== null &&
    !voice.listenOnly &&
    voice.phoneCallHold !== true
  );
}

/** What decides `routeShown`, as one comparable key. */
function voiceKey(voice: VoiceState): string {
  return [voice.currentChannelId !== null, voice.listenOnly, voice.phoneCallHold === true].join(
    "|",
  );
}

function routeRow(route: AudioRoute, active: boolean): HTMLButtonElement {
  const row = createElement("button", {
    type: "button",
    class: "route-row",
    role: "radio",
    "aria-checked": String(active),
    // One tab stop for the group, on the route in use.
    tabindex: active ? "0" : "-1",
    "data-route": route.kind,
    "data-testid": `route-${route.kind}`,
  });
  // A Bluetooth headset goes by its own name, with what it is underneath.
  const named = route.kind === "bluetooth" && route.name !== "";
  const text = createElement("span", { class: "route-row-text" });
  text.appendChild(
    createElement(
      "span",
      { class: "route-row-label" },
      named ? route.name : routeLabel(route.kind),
    ),
  );
  if (named) {
    text.appendChild(createElement("span", { class: "route-row-detail" }, routeLabel(route.kind)));
  }
  appendChildren(row, createIcon(ROUTE_ICON[route.kind], 22), text);
  if (active) row.appendChild(createIcon("check", 20));
  return row;
}

/** The sheet's rows, as one comparable key: redrawn only when they change. */
function rowsKey(host: MobileAudioState): string {
  return `${host.active}|${host.routes.map((r) => `${r.kind}:${r.name}`).join(",")}`;
}

/** The route whose row holds the focus, when a row of `list` does. */
function focusedRoute(list: HTMLElement): string | null {
  const at = document.activeElement;
  return at !== null && list.contains(at) ? at.getAttribute("data-route") : null;
}

/** The route sheet. It follows the routes while it is open (a headset plugged
 *  in shows up), and closes with a pick, with the call, and when the button
 *  that opened it goes. The arrow keys move through the routes; a pick takes
 *  Enter, Space or a tap, because it moves the call's sound at once. */
function openRouteSheet(opener: HTMLButtonElement, signal: AbortSignal): void {
  const title = t("route.title");
  const list = createElement("div", {
    class: "route-sheet-list",
    role: "radiogroup",
    "aria-label": title,
  });
  const content = createElement("div", { class: "route-sheet" });
  appendChildren(
    content,
    createElement("div", { class: "route-sheet-title", "aria-hidden": "true" }, title),
    list,
    createElement("p", { class: "route-sheet-note" }, t("route.micNote")),
  );
  const sheet = openBottomSheet({
    label: title,
    content,
    testId: "route-sheet",
    signal,
    fallbackFocus: () => (opener.isConnected ? opener : null),
  });
  if (sheet.signal.aborted) return;
  opener.setAttribute("aria-expanded", "true");
  enableRovingNavigation(list, ROW, sheet.signal, "vertical");

  let drawn: string | null = null;
  const draw = (): void => {
    const host = mobileRouteStore.getState();
    if (!routeShown(host, voiceStore.getState())) {
      sheet.close();
      return;
    }
    const key = rowsKey(host);
    if (key === drawn) return;
    // The first draw takes the focus. A later one keeps it on the route it was
    // on, and moves it to the one in use only when that row is gone.
    const opening = drawn === null;
    const from = focusedRoute(list);
    drawn = key;
    clearChildren(list);
    for (const route of host.routes) {
      const row = routeRow(route, route.kind === host.active);
      row.addEventListener(
        "click",
        () => {
          sheet.close();
          pickRoute(route.kind);
        },
        { signal: sheet.signal },
      );
      list.appendChild(row);
    }
    setRovingTabindex(list, ROW);
    if (!opening && from === null) return;
    const row =
      (from === null ? null : list.querySelector<HTMLElement>(`[data-route='${from}']`)) ??
      list.querySelector<HTMLElement>("[tabindex='0']");
    // A sheet opened by a tap shows no focus ring; the keyboard's row keeps its own.
    row?.focus(opening ? { focusVisible: false } : undefined);
    // The tab stop goes with the focus.
    setRovingTabindex(list, ROW);
  };
  const unsubs = [mobileRouteStore.subscribe(draw), voiceStore.subscribeSelector(voiceKey, draw)];
  sheet.signal.addEventListener(
    "abort",
    () => {
      for (const unsub of unsubs) unsub();
      opener.setAttribute("aria-expanded", "false");
    },
    { once: true },
  );
  draw();
}

export function createRouteButton(variant: RouteVariant, signal: AbortSignal): HTMLButtonElement {
  const { cls, icon } = VARIANT[variant];
  const btn = createElement("button", {
    type: "button",
    class: `${cls} route-btn`,
    "aria-haspopup": "dialog",
    "aria-expanded": "false",
    "data-call-control": "route",
    "data-testid": `route-button-${variant}`,
  });
  let drawn: AudioRouteKind | null = null;

  const paint = (): void => {
    const host = mobileRouteStore.getState();
    btn.hidden = !routeShown(host, voiceStore.getState());
    const label = t("route.button", { route: routeLabel(host.active) });
    btn.setAttribute("aria-label", label);
    btn.title = label;
    if (host.active === drawn) return;
    drawn = host.active;
    clearChildren(btn);
    btn.appendChild(createIcon(ROUTE_ICON[host.active], icon));
  };

  btn.addEventListener("click", () => openRouteSheet(btn, signal), { signal });
  const unsubs = [mobileRouteStore.subscribe(paint), voiceStore.subscribeSelector(voiceKey, paint)];
  signal.addEventListener(
    "abort",
    () => {
      for (const unsub of unsubs) unsub();
    },
    { once: true },
  );
  paint();
  return btn;
}
