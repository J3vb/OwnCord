/**
 * The voice widget's connection readout: the signal button, and the
 * connection card it opens (quality, ping and its recent history, the two
 * directions' rates and the session totals).
 */
import { createElement, appendChildren, setText } from "@lib/dom";
import { createSignalIcon } from "@lib/icons";
import {
  formatBytes,
  formatRateCompact,
  type ConnectionStats,
  type QualityLevel,
} from "@lib/voice/connectionStats";
import { authStore } from "@stores/auth.store";
import { voiceStore } from "@stores/voice.store";
import { voiceText as t } from "../../../i18n/voice";
import { createPingHistory, sparklinePoints } from "./pingHistory";

/** Connection-quality colour, used both for the signal bars (a fill, where
 *  --green/--yellow/--red are fine) and for the ping text beside them (text,
 *  which must meet contrast on the panel). */
const QUALITY_COLORS: Record<QualityLevel, string> = {
  excellent: "var(--text-positive, #62c28c)",
  fair: "var(--text-warning, #f2b84b)",
  poor: "var(--text-danger, #ff9a9c)",
  bad: "var(--text-danger, #ff9a9c)",
};

/** The quality pill's word for each level. */
const QUALITY_NAMES = {
  excellent: "conn.quality.good",
  fair: "conn.quality.fair",
  poor: "conn.quality.poor",
  bad: "conn.quality.bad",
} as const satisfies Record<QualityLevel, string>;

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

/** One direction's tile: an arrow + label, a big rate, its packet count and
 *  a thin meter of the rate. */
function statTile(
  arrow: string,
  label: string,
): {
  tile: HTMLDivElement;
  rate: HTMLSpanElement;
  packets: HTMLSpanElement;
  meter: HTMLSpanElement;
} {
  const tile = createElement("div", { class: "vw-stats-tile" });
  const labelEl = createElement("div", { class: "vw-stats-tile-label" });
  appendChildren(
    labelEl,
    createElement("span", { class: "vw-stat-arrow", "aria-hidden": "true" }, arrow),
    createElement("span", {}, label),
  );
  const rate = createElement("span", { class: "vw-stat-value vw-stat-rate" });
  const packets = createElement("span", { class: "vw-stat-packets" });
  const track = createElement("span", { class: "vw-stat-meter", "aria-hidden": "true" });
  const meter = createElement("span", { class: "vw-stat-meter-fill" });
  track.appendChild(meter);
  appendChildren(tile, labelEl, rate, packets, track);
  return { tile, rate, packets, meter };
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
export function createSignalButton(
  onToggle: (e: MouseEvent) => void,
  signal: AbortSignal,
): SignalButton {
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
  /** Forget the ping history: the call it measured is over. */
  resetHistory(): void;
}

/** A rate's meter: the square root of its share of 1 MB/s, so a voice call's
 *  few kB/s still shows and a busy share fills it without overflowing. */
const METER_FULL = 1_000_000;
export function meterShare(rate: number): number {
  if (!(rate > 0)) return 0;
  return Math.min(1, Math.sqrt(rate / METER_FULL));
}

const SVG_NS = "http://www.w3.org/2000/svg";
const SPARK_W = 300;
const SPARK_H = 46;

/** The ping graph: a line over a soft fill, in the quality's colour. */
function createSparkline(): {
  el: SVGSVGElement;
  draw(values: readonly number[], color: string): void;
} {
  const el = document.createElementNS(SVG_NS, "svg");
  el.setAttribute("class", "vw-spark");
  el.setAttribute("viewBox", `0 0 ${SPARK_W} ${SPARK_H}`);
  el.setAttribute("preserveAspectRatio", "none");
  el.setAttribute("aria-hidden", "true");
  el.setAttribute("data-testid", "vw-spark");
  const fill = document.createElementNS(SVG_NS, "path");
  fill.setAttribute("class", "vw-spark-fill");
  const line = document.createElementNS(SVG_NS, "polyline");
  line.setAttribute("class", "vw-spark-line");
  el.append(fill, line);

  function draw(values: readonly number[], color: string): void {
    const points = sparklinePoints(values, SPARK_W, SPARK_H);
    el.style.color = color;
    line.setAttribute("points", points.map(([x, y]) => `${x},${y}`).join(" "));
    const first = points[0];
    const last = points[points.length - 1];
    const area =
      first === undefined || last === undefined
        ? ""
        : `M${first[0]} ${SPARK_H} ${points.map(([x, y]) => `L${x} ${y}`).join(" ")} L${last[0]} ${SPARK_H} Z`;
    fill.setAttribute("d", area);
  }

  return { el, draw };
}

/** The card's head: "Connection" and the quality pill, then the big ping
 *  beside the server's name and whether the call is secured. */
function createConnectionHead(): {
  el: HTMLDivElement;
  draw(stats: ConnectionStats): void;
} {
  const el = createElement("div", { class: "vw-conn-head" });
  const top = createElement("div", { class: "vw-conn-top" });
  const pill = createElement("span", { class: "vw-conn-pill", "data-testid": "vw-conn-quality" });
  appendChildren(top, createElement("span", { class: "vw-card-eyebrow" }, t("conn.eyebrow")), pill);
  const main = createElement("div", { class: "vw-conn-main" });
  const ping = createElement("div", { class: "vw-conn-ping" });
  const ms = createElement("span", { class: "vw-conn-ms", "data-testid": "vw-conn-ping" }, "—");
  appendChildren(ping, ms, createElement("small", {}, t("conn.msPing")));
  const where = createElement("div", { class: "vw-conn-where" });
  const server = createElement("span", { class: "vw-conn-server" });
  const secured = createElement("span", { class: "vw-conn-secured" });
  appendChildren(where, server, secured);
  appendChildren(main, ping, where);
  appendChildren(el, top, main);

  function drawWhere(): void {
    setText(server, authStore.getState().serverName ?? "");
    const voice = voiceStore.getState();
    const connected = voice.voiceStatus === "connected";
    const degraded = connected && voice.encryptionDegraded === true;
    setText(secured, connected ? t(degraded ? "widget.unsecured" : "widget.secured") : "");
    secured.classList.toggle("vw-conn-secured--degraded", degraded);
  }

  function draw(stats: ConnectionStats): void {
    const known = stats.available && stats.rtt > 0;
    setText(ms, known ? String(Math.round(stats.rtt)) : "—");
    pill.hidden = !stats.available;
    pill.dataset["quality"] = stats.quality;
    setText(pill, t(QUALITY_NAMES[stats.quality]));
    drawWhere();
  }

  return { el, draw };
}

/** The connection card (hidden until its button opens it). */
export function createStatsPane(): StatsPane {
  const el = createElement("div", {
    class: "vw-stats",
    role: "group",
    "aria-label": t("widget.transportStatistics"),
    "data-testid": "vw-stats",
  });
  const head = createConnectionHead();
  const history = createPingHistory();
  const spark = createSparkline();
  const legend = createElement("div", { class: "vw-spark-legend" });
  appendChildren(
    legend,
    createElement("span", {}, t("conn.historySpan")),
    createElement("span", {}, t("conn.now")),
  );
  const statsGrid = createElement("div", { class: "vw-stats-grid" });
  const upload = statTile("↑", t("widget.upload"));
  const download = statTile("↓", t("widget.download"));
  for (const dir of [upload, download]) {
    setStatValue(dir.rate, t("widget.idle"), true);
    setText(dir.packets, packetText(0));
  }
  appendChildren(statsGrid, upload.tile, download.tile);

  const footer = createElement("div", { class: "vw-stats-footer" });
  const footerLead = createElement(
    "span",
    { class: "vw-stats-footer-lead" },
    t("widget.thisSession"),
  );
  const totalsRow = createElement("span", { class: "vw-stats-totals" });
  const totalUp = createElement("span", { class: "vw-stat-value" });
  const totalDown = createElement("span", { class: "vw-stat-value" });
  setStatValue(totalUp, t("widget.zeroBytes"), true);
  setStatValue(totalDown, t("widget.zeroBytes"), true);
  appendChildren(totalsRow, totalWrap("↑", totalUp), totalWrap("↓", totalDown));
  appendChildren(footer, footerLead, totalsRow);
  appendChildren(el, head.el, spark.el, legend, statsGrid, footer);

  /** An idle direction reads "Idle" / "no packets" softly (the CSS dims
   *  .vw-stat-value--empty) rather than as another full-strength zero
   *  competing for attention. */
  function drawDirection(dir: ReturnType<typeof statTile>, rate: number, packets: number): void {
    setStatValue(dir.rate, rate === 0 ? t("widget.idle") : formatRateCompact(rate), rate === 0);
    setText(dir.packets, packetText(packets));
    dir.meter.style.width = `${Math.round(meterShare(rate) * 100)}%`;
  }

  function update(stats: ConnectionStats): void {
    if (stats.available) history.push(stats.rtt);
    head.draw(stats);
    spark.draw(
      history.values(),
      stats.available ? QUALITY_COLORS[stats.quality] : "var(--text-muted)",
    );
    drawDirection(upload, stats.outRate, stats.outPackets);
    drawDirection(download, stats.inRate, stats.inPackets);
    setStatValue(totalUp, formatBytes(stats.totalUp), stats.totalUp === 0);
    setStatValue(totalDown, formatBytes(stats.totalDown), stats.totalDown === 0);
  }

  function resetHistory(): void {
    history.reset();
    spark.draw([], "var(--text-muted)");
  }

  return { el, update, resetHistory };
}
