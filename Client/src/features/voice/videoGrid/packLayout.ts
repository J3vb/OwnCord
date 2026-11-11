/**
 * Packs video tiles into a rectangle by their real aspect ratio and a
 * per-tile size. Pure: numbers in, rectangles out.
 *
 * Large tiles (and pinned ones) form the top band; the rest form a second
 * band placed below or beside it. Each band is packed in justified rows.
 * Of the layouts tried, the one showing the most picture area wins.
 */
import { GRID_GAP, GRID_PAD } from "./gridConstants";

export type TileSize = "large" | "medium" | "small";

export interface PackTile {
  readonly id: number;
  /** Width over height of the picture. */
  readonly aspect: number;
  readonly size: TileSize;
  /** A pinned tile counts as large. */
  readonly pinned?: boolean;
}

export interface PackRect {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const DEFAULT_ASPECT = 16 / 9;
const MIN_ASPECT = 0.25;
const MAX_ASPECT = 8;

/** Share of the space the top band may take, tried from first to last. */
const SPLIT_FRACTIONS: readonly number[] = [
  0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9,
];

/** A small tile is drawn at this scale of a medium one in the rest band. */
const SMALL_SCALE = 0.6;

/** A lower tier tile ends up a little under the smallest higher tier tile. */
const TIER_MARGIN = 0.97;

const RANK = { large: 2, medium: 1, small: 0 } as const;

interface Item {
  /** Position of the tile in the input. */
  readonly idx: number;
  readonly aspect: number;
  readonly scale: number;
  /** Width share of the tile in a row: scale times aspect. */
  readonly weight: number;
  readonly rank: number;
}

interface Placed {
  readonly idx: number;
  readonly rank: number;
  readonly aspect: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Band {
  readonly placed: Placed[];
  readonly w: number;
  readonly h: number;
}

/** A usable aspect: finite, positive and within the supported range. */
function cleanAspect(aspect: number): number {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : DEFAULT_ASPECT;
  return Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, a));
}

function rankOf(tile: PackTile): number {
  return tile.pinned === true ? RANK.large : RANK[tile.size];
}

/** Start index of each row when `items` are cut into `rows` balanced runs. */
function rowStarts(items: readonly Item[], rows: number): number[] {
  const n = items.length;
  let total = 0;
  for (const it of items) total += it.weight;
  const target = total / rows;
  const starts = [0];
  let idx = 0;
  let cum = 0;
  for (let r = 0; r < rows - 1; r++) {
    cum += items[idx]?.weight ?? 0;
    idx++;
    const goal = target * (r + 1);
    while (n - idx > rows - r - 1 && cum + (items[idx]?.weight ?? 0) / 2 < goal) {
      cum += items[idx]?.weight ?? 0;
      idx++;
    }
    starts.push(idx);
  }
  return starts;
}

function maxScaleOf(row: readonly Item[]): number {
  let m = 0;
  for (const it of row) m = Math.max(m, it.scale);
  return m;
}

/** How `rows` justified rows would fall, measured without placing tiles. */
interface RowPlan {
  readonly rows: number;
  readonly starts: readonly number[];
  /** Height of a scale-1 tile in each row, before shrinking. */
  readonly unitH: readonly number[];
  /** Uniform shrink so the rows fit the band height. */
  readonly f: number;
  /** Picture area the plan shows. */
  readonly area: number;
}

interface RowStats {
  /** Summed weight, summed scale squared times aspect, and scale range. */
  sw: number;
  sq: number;
  maxScale: number;
  minScale: number;
}

function rowStats(items: readonly Item[], from: number, to: number): RowStats {
  const st = { sw: 0, sq: 0, maxScale: 0, minScale: Infinity };
  for (let i = from; i < to; i++) {
    const it = items[i] as Item;
    st.sw += it.weight;
    st.sq += it.scale * it.scale * it.aspect;
    st.maxScale = Math.max(st.maxScale, it.scale);
    st.minScale = Math.min(st.minScale, it.scale);
  }
  return st;
}

function planRows(items: readonly Item[], rows: number, bw: number, bh: number): RowPlan | null {
  const availH = bh - GRID_GAP * (rows - 1);
  if (availH <= 0) return null;
  const starts = rowStarts(items, rows);
  const stats: RowStats[] = [];
  const unitH: number[] = [];
  for (let r = 0; r < rows; r++) {
    const from = starts[r] ?? 0;
    const to = starts[r + 1] ?? items.length;
    const availW = bw - GRID_GAP * (to - from - 1);
    if (availW <= 0) return null;
    const st = rowStats(items, from, to);
    stats.push(st);
    unitH.push(availW / st.sw);
  }
  // A row of only shrunken tiles does not outgrow the rows of full ones.
  let fullH = 0;
  for (let r = 0; r < rows; r++)
    if (stats[r]?.minScale === 1) fullH = Math.max(fullH, unitH[r] ?? 0);
  let sumH = 0;
  let areaAtUnit = 0;
  for (let r = 0; r < rows; r++) {
    const st = stats[r] as RowStats;
    if (fullH > 0 && st.maxScale < 1) unitH[r] = Math.min(unitH[r] ?? 0, fullH);
    const h = unitH[r] ?? 0;
    sumH += h * st.maxScale;
    areaAtUnit += h * h * st.sq;
  }
  const f = Math.min(1, availH / sumH);
  return { rows, starts, unitH, f, area: areaAtUnit * f * f };
}

/** Place the tiles of `plan`, rows centred in a band as wide as the widest. */
function placeRows(items: readonly Item[], plan: RowPlan): Band {
  const placed: Placed[] = [];
  const rowWidths: number[] = [];
  let y = 0;
  let bandW = 0;
  for (let r = 0; r < plan.rows; r++) {
    const row = items.slice(plan.starts[r], plan.starts[r + 1] ?? items.length);
    const h = (plan.unitH[r] ?? 0) * plan.f;
    const rowH = h * maxScaleOf(row);
    let x = 0;
    for (const it of row) {
      const th = it.scale * h;
      const tw = th * it.aspect;
      placed.push({
        idx: it.idx,
        rank: it.rank,
        aspect: it.aspect,
        x,
        y: y + (rowH - th) / 2,
        w: tw,
        h: th,
      });
      x += tw + GRID_GAP;
    }
    rowWidths.push(x - GRID_GAP);
    bandW = Math.max(bandW, x - GRID_GAP);
    y += rowH + GRID_GAP;
  }
  for (let r = 0; r < plan.rows; r++) {
    const shift = (bandW - (rowWidths[r] ?? 0)) / 2;
    const end = plan.starts[r + 1] ?? placed.length;
    for (let i = plan.starts[r] ?? 0; i < end; i++) (placed[i] as Placed).x += shift;
  }
  return { placed, w: bandW, h: y - GRID_GAP };
}

/** The row count showing the most picture for `items` inside `bw` x `bh`. */
function packBand(items: readonly Item[], bw: number, bh: number): Band | null {
  let best: RowPlan | null = null;
  for (let rows = 1; rows <= items.length; rows++) {
    const plan = planRows(items, rows, bw, bh);
    if (plan !== null && (best === null || plan.area > best.area)) best = plan;
  }
  return best === null ? null : placeRows(items, best);
}

function shifted(band: Band, dx: number, dy: number): Placed[] {
  return band.placed.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
}

/**
 * Shrink lower tier tiles about their centre so none is larger than the
 * smallest tile of any higher tier.
 */
function capTiers(placed: Placed[]): void {
  let cap = Infinity;
  for (let rank = RANK.large; rank >= RANK.small; rank--) {
    let min = Infinity;
    for (const p of placed) {
      if (p.rank !== rank) continue;
      const a = p.w * p.h;
      if (a > cap && a > 0) {
        const k = Math.sqrt(cap / a);
        p.x += (p.w - p.w * k) / 2;
        p.y += (p.h - p.h * k) / 2;
        p.w *= k;
        p.h *= k;
      }
      min = Math.min(min, p.w * p.h);
    }
    cap = Math.min(cap, min * TIER_MARGIN);
  }
}

function placedArea(placed: readonly Placed[]): number {
  let sum = 0;
  for (const p of placed) sum += p.w * p.h;
  return sum;
}

/** Top band and rest band stacked (`below`) or side by side, centred. */
function compose(
  top: readonly Item[],
  rest: readonly Item[],
  w: number,
  h: number,
  below: boolean,
  fraction: number,
): Placed[] | null {
  const span = (below ? h : w) - GRID_GAP;
  const topSpan = span * fraction;
  const restSpan = span - topSpan;
  const topBand = below ? packBand(top, w, topSpan) : packBand(top, topSpan, h);
  const restBand = below ? packBand(rest, w, restSpan) : packBand(rest, restSpan, h);
  if (topBand === null || restBand === null) return null;
  if (below) {
    const y0 = (h - (topBand.h + GRID_GAP + restBand.h)) / 2;
    return [
      ...shifted(topBand, (w - topBand.w) / 2, y0),
      ...shifted(restBand, (w - restBand.w) / 2, y0 + topBand.h + GRID_GAP),
    ];
  }
  const x0 = (w - (topBand.w + GRID_GAP + restBand.w)) / 2;
  return [
    ...shifted(topBand, x0, (h - topBand.h) / 2),
    ...shifted(restBand, x0 + topBand.w + GRID_GAP, (h - restBand.h) / 2),
  ];
}

/**
 * Place every tile inside `width` x `height`, keeping each tile's aspect.
 * Returns one rectangle per tile, in whole pixels, with `GRID_PAD` around
 * the outside and `GRID_GAP` between tiles. The output is positional: the
 * rectangle at index `i` belongs to `tiles[i]`, whatever the ids are.
 * A rectangle with a width of 0 means there is no room: hide that tile.
 * Returns an empty array for no tiles or a window that is not a positive,
 * finite size.
 */
export function packTiles(width: number, height: number, tiles: readonly PackTile[]): PackRect[] {
  if (tiles.length === 0 || !isRoom(width) || !isRoom(height)) return [];
  const { top, rest } = splitTiers(tiles);
  const w = width - GRID_PAD * 2;
  const h = height - GRID_PAD * 2;
  const candidates = layouts(top, rest, w, h);
  let best: Placed[] = [];
  let bestArea = -1;
  for (const placed of candidates) {
    capTiers(placed);
    const a = placedArea(placed);
    if (a > bestArea) {
      best = placed;
      bestArea = a;
    }
  }
  if (best.length === 0) best = singleBand(top, rest, w, h);
  return toRects(tiles, best);
}

function isRoom(size: number): boolean {
  return Number.isFinite(size) && size > 0;
}

/** Last resort: every tile at scale 1 in one band, tiers ignored. */
function singleBand(top: readonly Item[], rest: readonly Item[], w: number, h: number): Placed[] {
  if (w <= 0 || h <= 0) return [];
  const all = [...top, ...rest]
    .map((it) => ({ ...it, scale: 1, weight: it.aspect, rank: RANK.small }))
    .toSorted((a, b) => a.idx - b.idx);
  const band = packBand(all, w, h);
  return band === null ? [] : shifted(band, (w - band.w) / 2, (h - band.h) / 2);
}

/** The top tier and the rest, each in stable order, as packable items. */
function splitTiers(tiles: readonly PackTile[]): { top: Item[]; rest: Item[] } {
  const ranked = tiles.map((t, i) => ({ t, i, rank: rankOf(t), pin: t.pinned === true }));
  ranked.sort((a, b) => b.rank - a.rank || Number(b.pin) - Number(a.pin) || a.i - b.i);
  const topRank = ranked[0]?.rank ?? RANK.small;
  const shrinkSmall = topRank === RANK.large && ranked.some((r) => r.rank === RANK.medium);
  const toItem = (r: (typeof ranked)[number]): Item => {
    const aspect = cleanAspect(r.t.aspect);
    const scale = shrinkSmall && r.rank === RANK.small ? SMALL_SCALE : 1;
    return { idx: r.i, aspect, scale, weight: scale * aspect, rank: r.rank };
  };
  return {
    top: ranked.filter((r) => r.rank === topRank).map(toItem),
    rest: ranked.filter((r) => r.rank !== topRank).map(toItem),
  };
}

/** Every layout worth scoring inside the padded `w` x `h`. */
function layouts(top: readonly Item[], rest: readonly Item[], w: number, h: number): Placed[][] {
  const out: Placed[][] = [];
  if (rest.length === 0) {
    const band = w > 0 && h > 0 ? packBand(top, w, h) : null;
    if (band !== null) out.push(shifted(band, (w - band.w) / 2, (h - band.h) / 2));
  } else if (w > GRID_GAP && h > GRID_GAP) {
    for (const fraction of SPLIT_FRACTIONS) {
      for (const below of [true, false]) {
        const placed = compose(top, rest, w, h, below, fraction);
        if (placed !== null) out.push(placed);
      }
    }
  }
  return out;
}

interface Mutable {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Whole-pixel rectangles by input position; unplaced ones are empty. Edges
 * snap inward, so the gap between tiles never shrinks.
 */
function toRects(tiles: readonly PackTile[], placed: readonly Placed[]): PackRect[] {
  const out: Mutable[] = tiles.map((t) => ({ id: t.id, x: 0, y: 0, w: 0, h: 0 }));
  for (const p of placed) {
    let x = Math.ceil(p.x + GRID_PAD - 1e-6);
    const top = Math.ceil(p.y + GRID_PAD - 1e-6);
    let w = Math.max(0, Math.floor(p.x + p.w + GRID_PAD + 1e-6) - x);
    let h = Math.max(0, Math.floor(p.y + p.h + GRID_PAD + 1e-6) - top);
    if (Math.floor(w / p.aspect + 1e-6) <= h) {
      h = Math.floor(w / p.aspect + 1e-6);
    } else {
      const narrower = Math.floor(h * p.aspect + 1e-6);
      x += Math.floor((w - narrower) / 2);
      w = narrower;
    }
    out[p.idx] = { id: tiles[p.idx]?.id ?? 0, x, y: top, w, h };
  }
  enforceTierOrder(out, placed);
  return out;
}

/**
 * After rounding, shrink any lower tier rectangle (keeping its aspect and
 * centre) until it is no larger than the smallest rectangle of a higher tier.
 */
function enforceTierOrder(out: Mutable[], placed: readonly Placed[]): void {
  let cap = Infinity;
  for (let rank = RANK.large; rank >= RANK.small; rank--) {
    let min = Infinity;
    for (const p of placed) {
      const r = out[p.idx];
      if (p.rank !== rank || r === undefined) continue;
      if (r.w * r.h > cap) {
        let w = Math.floor(Math.sqrt(cap * p.aspect));
        let h = Math.floor(w / p.aspect);
        while (w > 0 && w * h > cap) {
          w--;
          h = Math.floor(w / p.aspect);
        }
        if (w === 0) h = 0;
        r.x += Math.floor((r.w - w) / 2);
        r.y += Math.floor((r.h - h) / 2);
        r.w = w;
        r.h = h;
      }
      min = Math.min(min, r.w * r.h);
    }
    cap = Math.min(cap, min);
  }
}
