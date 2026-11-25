/**
 * The Command Deck top bar's ping: four signal bars and "18 ms", left of the
 * connection state. It shows only while you are in a connected call, the chat
 * connection is up, and the voice widget's latest sample was written while
 * connected after the current join. It reads the samples the widget writes and
 * starts no poller or timer of its own. It is not a control: the bars and the
 * drawn text are aria-hidden, and an sr-only sibling says the same in words.
 */
import type { Disposable } from "@lib/disposable";
import { createElement, setText } from "@lib/dom";
import { createSignalIcon } from "@lib/icons";
import { select } from "@lib/ui/select";
import type { QualityLevel } from "@lib/voice/connectionStats";
import { liveStatsStore, shownPing, shownStats } from "@lib/voice/liveStats";
import { uiStore } from "@stores/ui.store";
import { voiceStore } from "@stores/voice.store";
import { voiceText } from "../../i18n/voice";

/** The voice widget's bar colours and counts, so the two readouts match. */
const BARS: Readonly<Record<QualityLevel, { readonly lit: number; readonly colour: string }>> = {
  excellent: { lit: 4, colour: "var(--text-positive, #62c28c)" },
  fair: { lit: 3, colour: "var(--text-warning, #f2b84b)" },
  poor: { lit: 2, colour: "var(--text-danger, #ff9a9c)" },
  bad: { lit: 1, colour: "var(--text-danger, #ff9a9c)" },
};

const WORDS: Readonly<
  Record<QualityLevel, "stats.excellent" | "stats.fair" | "stats.poor" | "stats.bad">
> = {
  excellent: "stats.excellent",
  fair: "stats.fair",
  poor: "stats.poor",
  bad: "stats.bad",
};

interface PingView {
  readonly rtt: number;
  readonly level: QualityLevel;
}

/** `div.deck-ping`, kept true from the stores; its subscription belongs to `owner`. */
export function createDeckPing(owner: Disposable): HTMLElement {
  const root = createElement("div", { class: "deck-ping", "data-testid": "deck-ping" });
  const text = createElement("span", { class: "deck-ping-text", "aria-hidden": "true" });
  const spoken = createElement("span", { class: "sr-only" });
  let bars: SVGSVGElement | null = null;
  root.append(text, spoken);

  const draw = (view: PingView | null): void => {
    root.hidden = view === null;
    if (view === null) return;
    const { lit, colour } = BARS[view.level];
    const icon = createSignalIcon(lit, colour, 16);
    icon.setAttribute("aria-hidden", "true");
    if (bars === null) root.prepend(icon);
    else bars.replaceWith(icon);
    bars = icon;
    setText(text, voiceText("stats.ping", { rtt: view.rtt }));
    const quality = voiceText(WORDS[view.level]);
    setText(spoken, voiceText("stats.pingSr", { rtt: view.rtt, quality }));
  };

  const sel = select(
    [liveStatsStore, voiceStore, uiStore],
    (live, voice, ui): PingView | null => {
      if (voice.currentChannelId === null) return null;
      if (ui.connectionStatus !== "connected" || ui.sessionReplaced) return null;
      const shown = shownStats(live, voice.voiceStatus === "connected", voice.joinedAt);
      const rtt = shownPing(shown);
      return shown === null || rtt === null ? null : { rtt, level: shown.quality };
    },
    draw,
    {
      signal: owner.signal,
      equals: (a, b) =>
        a === b || (a !== null && b !== null && a.rtt === b.rtt && a.level === b.level),
    },
  );
  draw(sel.get());
  return root;
}
