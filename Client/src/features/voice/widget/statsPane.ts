/** The voice widget's connection readout: the signal button and the expanded transport stats. */
import { createElement, appendChildren, setText } from "@lib/dom";
import { createSignalIcon } from "@lib/icons";
import {
  formatBytes,
  formatRateCompact,
  type ConnectionStats,
  type QualityLevel,
} from "@lib/voice/connectionStats";
import { voiceText as t } from "../../../i18n/voice";

/** Connection-quality colour, used both for the signal bars (a fill, where
 *  --green/--yellow/--red are fine) and for the ping text beside them (text,
 *  which must meet contrast on the panel). */
const QUALITY_COLORS: Record<QualityLevel, string> = {
  excellent: "var(--text-positive, #62c28c)",
  fair: "var(--text-warning, #f2b84b)",
  poor: "var(--text-danger, #ff9a9c)",
  bad: "var(--text-danger, #ff9a9c)",
};

const QUALITY_BARS: Record<QualityLevel, number> = {
  excellent: 4,
  fair: 3,
  poor: 2,
  bad: 1,
};

/** Update a stats value and mark it empty (zero/missing) so the CSS can
 *  soften it instead of showing it at full strength. */
function setStatValue(el: HTMLSpanElement, text: string, empty: boolean): void {
  setText(el, text);
  el.classList.toggle("vw-stat-value--empty", empty);
}

/** One direction's tile: an arrow + label, a big rate, and its packet count. */
function statTile(
  arrow: string,
  label: string,
): { tile: HTMLDivElement; rate: HTMLSpanElement; packets: HTMLSpanElement } {
  const tile = createElement("div", { class: "vw-stats-tile" });
  const labelEl = createElement("div", { class: "vw-stats-tile-label" });
  appendChildren(
    labelEl,
    createElement("span", { class: "vw-stat-arrow", "aria-hidden": "true" }, arrow),
    createElement("span", {}, label),
  );
  const rate = createElement("span", { class: "vw-stat-value vw-stat-rate" });
  const packets = createElement("span", { class: "vw-stat-packets" });
  appendChildren(tile, labelEl, rate, packets);
  return { tile, rate, packets };
}

/** A direction's packet count as prose; zero reads "no packets". */
function packetText(count: number): string {
  return count === 0 ? t("widget.noPackets") : t("widget.packetCount", { count });
}

/** A session total with its direction arrow. */
function totalWrap(arrow: string, value: HTMLSpanElement): HTMLSpanElement {
  const wrap = createElement("span", { class: "vw-stat-total" });
  wrap.appendChild(createElement("span", { class: "vw-stat-arrow" }, arrow));
  wrap.appendChild(value);
  return wrap;
}

export interface SignalButton {
  readonly el: HTMLButtonElement;
  draw(stats: ConnectionStats): void;
}

/** A button, not a clickable div: the quality readout toggles the transport
 *  stats pane, and a pointer-only control is unreachable by keyboard.
 *  aria-expanded reflects the pane it owns. */
export function createSignalButton(onToggle: () => void, signal: AbortSignal): SignalButton {
  const el = createElement("button", {
    type: "button",
    class: "vw-signal",
    "aria-label": t("widget.quality"),
    "aria-expanded": "false",
    "data-testid": "vw-signal",
  });
  el.appendChild(createSignalIcon(4, QUALITY_COLORS.excellent, 14));
  const ping = createElement("span", { class: "vw-ping" }, "—");
  ping.style.color = QUALITY_COLORS.excellent;
  el.appendChild(ping);
  el.addEventListener("click", onToggle, { signal });

  function draw(stats: ConnectionStats): void {
    const color = stats.available ? QUALITY_COLORS[stats.quality] : "var(--text-muted)";
    const bars = stats.available ? QUALITY_BARS[stats.quality] : 0;

    // Replace signal icon
    const oldSvg = el.querySelector("svg");
    if (oldSvg) oldSvg.remove();
    el.insertBefore(createSignalIcon(bars, color, 14), ping);

    // Update ping text. No transport to measure (the native host returned no
    // sample, the SDK's internals changed, or the first sample has not landed
    // yet) reads as unavailable, not a false 4-green-bars "excellent".
    const rttText = stats.available && stats.rtt > 0 ? `${Math.round(stats.rtt)}ms` : "—";
    setText(ping, rttText);
    ping.style.color = color;
    el.classList.toggle("vw-signal--unavailable", !stats.available);
  }

  return { el, draw };
}

export interface StatsPane {
  readonly el: HTMLDivElement;
  update(stats: ConnectionStats): void;
}

/** The expanded pane (hidden by default): Upload and Download tiles, then one
 *  footer line with the RTT (once known) and the session totals. */
export function createStatsPane(): StatsPane {
  const el = createElement("div", {
    class: "vw-stats",
    role: "group",
    "aria-label": t("widget.transportStatistics"),
  });
  const statsGrid = createElement("div", { class: "vw-stats-grid" });
  const upload = statTile("↑", t("widget.upload"));
  const download = statTile("↓", t("widget.download"));
  for (const dir of [upload, download]) {
    setStatValue(dir.rate, t("widget.idle"), true);
    setText(dir.packets, packetText(0));
  }
  appendChildren(statsGrid, upload.tile, download.tile);

  const footer = createElement("div", { class: "vw-stats-footer" });
  /** The footer's leading slot: "RTT 42.0 ms" once known, else "Session". */
  const footerLead = createElement("span", { class: "vw-stats-footer-lead" }, t("widget.session"));
  const rttEl = createElement("span", { class: "vw-stat-value" });
  const totalsRow = createElement("span", { class: "vw-stats-totals" });
  const totalUp = createElement("span", { class: "vw-stat-value" });
  const totalDown = createElement("span", { class: "vw-stat-value" });
  setStatValue(totalUp, t("widget.zeroBytes"), true);
  setStatValue(totalDown, t("widget.zeroBytes"), true);
  appendChildren(totalsRow, totalWrap("↑", totalUp), totalWrap("↓", totalDown));
  appendChildren(footer, footerLead, totalsRow);
  appendChildren(el, statsGrid, footer);

  /** The RTT only takes the footer's lead once it is known; until then the
   *  slot just labels the totals, so no "—" placeholder is ever shown. */
  function updateFooterLead(rtt: number): void {
    if (rtt > 0) {
      // i18n-exempt: numeric RTT value with its unit, not translatable prose
      setText(rttEl, `${rtt.toFixed(1)} ms`);
      if (!rttEl.isConnected) footerLead.replaceChildren(`${t("widget.rtt")} `, rttEl);
    } else if (footerLead.textContent !== t("widget.session")) {
      setText(footerLead, t("widget.session"));
    }
  }

  /** An idle direction reads "Idle" / "no packets" softly (the CSS dims
   *  .vw-stat-value--empty) rather than as another full-strength zero
   *  competing for attention. */
  function update(stats: ConnectionStats): void {
    setStatValue(
      upload.rate,
      stats.outRate === 0 ? t("widget.idle") : formatRateCompact(stats.outRate),
      stats.outRate === 0,
    );
    setText(upload.packets, packetText(stats.outPackets));
    setStatValue(
      download.rate,
      stats.inRate === 0 ? t("widget.idle") : formatRateCompact(stats.inRate),
      stats.inRate === 0,
    );
    setText(download.packets, packetText(stats.inPackets));
    updateFooterLead(stats.rtt);
    setStatValue(totalUp, formatBytes(stats.totalUp), stats.totalUp === 0);
    setStatValue(totalDown, formatBytes(stats.totalDown), stats.totalDown === 0);
  }

  return { el, update };
}
