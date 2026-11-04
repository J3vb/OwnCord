/**
 * A small QR code encoder: byte mode, error correction level M, versions 1
 * to 20 (up to 666 bytes). Runs fully in the client, so the text it encodes
 * (a two-factor secret) never leaves the device to be drawn.
 */

const ECC_PER_BLOCK = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
] as const;
const BLOCK_COUNT = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16] as const;
const MAX_VERSION = 20;
/** Format bits for level M are 00. */
const ECC_FORMAT_BITS = 0;

export interface QrMatrix {
  readonly size: number;
  /** True where the module is dark; row-major, `size * size` entries. */
  readonly modules: readonly boolean[];
}

function rawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(ver: number): number {
  return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ver]! * BLOCK_COUNT[ver]!;
}

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = Array.from({ length: degree }, () => 0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      const next = j + 1 < degree ? result[j + 1]! : 0;
      result[j] = gfMultiply(result[j]!, root) ^ next;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = Array.from({ length: divisor.length }, () => 0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] = result[i]! ^ gfMultiply(coef, factor);
    });
  }
  return result;
}

function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result = [6];
  for (let pos = ver * 4 + 10; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

function interleave(ver: number, data: readonly number[]): number[] {
  const numBlocks = BLOCK_COUNT[ver]!;
  const eccLen = ECC_PER_BLOCK[ver]!;
  const rawCodewords = Math.floor(rawDataModules(ver) / 8);
  const numShort = numBlocks - (rawCodewords % numBlocks);
  const shortLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= numShort) result.push(block[i]!);
    });
  }
  return result;
}

function encodeData(bytes: Uint8Array): { ver: number; codewords: number[] } | null {
  let ver = 1;
  for (; ver <= MAX_VERSION; ver++) {
    const countBits = ver <= 9 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= dataCodewords(ver) * 8) break;
  }
  if (ver > MAX_VERSION) return null;
  const bits: number[] = [];
  const push = (value: number, len: number): void => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const capacity = dataCodewords(ver) * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]!;
    data.push(byte);
  }
  return { ver, codewords: interleave(ver, data) };
}

class Grid {
  readonly size: number;
  readonly modules: boolean[];
  readonly fixed: boolean[];
  constructor(size: number) {
    this.size = size;
    this.modules = Array.from({ length: size * size }, () => false);
    this.fixed = Array.from({ length: size * size }, () => false);
  }
  get(x: number, y: number): boolean {
    return this.modules[y * this.size + x]!;
  }
  setFixed(x: number, y: number, dark: boolean): void {
    this.modules[y * this.size + x] = dark;
    this.fixed[y * this.size + x] = true;
  }
}

function drawFinder(g: Grid, cx: number, cy: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= g.size || y >= g.size) continue;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      g.setFixed(x, y, dist !== 2 && dist !== 4);
    }
  }
}

function drawFormat(g: Grid, mask: number): void {
  const data = (ECC_FORMAT_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0;
  const s = g.size;
  for (let i = 0; i <= 5; i++) g.setFixed(8, i, bit(i));
  g.setFixed(8, 7, bit(6));
  g.setFixed(8, 8, bit(7));
  g.setFixed(7, 8, bit(8));
  for (let i = 9; i < 15; i++) g.setFixed(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) g.setFixed(s - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) g.setFixed(8, s - 15 + i, bit(i));
  g.setFixed(8, s - 8, true);
}

function drawVersion(g: Grid, ver: number): void {
  if (ver < 7) return;
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (ver << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) !== 0;
    const a = g.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    g.setFixed(a, b, dark);
    g.setFixed(b, a, dark);
  }
}

function drawFunctionPatterns(g: Grid, ver: number): void {
  const s = g.size;
  for (let i = 0; i < s; i++) {
    g.setFixed(6, i, i % 2 === 0);
    g.setFixed(i, 6, i % 2 === 0);
  }
  drawFinder(g, 3, 3);
  drawFinder(g, s - 4, 3);
  drawFinder(g, 3, s - 4);
  const align = alignmentPositions(ver);
  const last = align.length - 1;
  align.forEach((ax, i) => {
    align.forEach((ay, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          g.setFixed(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    });
  });
  drawFormat(g, 0);
  drawVersion(g, ver);
}

function drawCodewords(g: Grid, codewords: readonly number[]): void {
  const s = g.size;
  let i = 0;
  for (let right = s - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < s; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? s - 1 - vert : vert;
        if (!g.fixed[y * s + x] && i < codewords.length * 8) {
          g.modules[y * s + x] = ((codewords[i >>> 3]! >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }
}

const MASKS: ReadonlyArray<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(g: Grid, mask: number): void {
  const fn = MASKS[mask]!;
  for (let y = 0; y < g.size; y++) {
    for (let x = 0; x < g.size; x++) {
      if (!g.fixed[y * g.size + x] && fn(x, y)) {
        g.modules[y * g.size + x] = !g.modules[y * g.size + x];
      }
    }
  }
}

const FINDER_LIKE = [true, false, true, true, true, false, true] as const;

/** The standard's penalty score: lower reads more reliably. */
function penalty(g: Grid): number {
  const s = g.size;
  let score = 0;
  const line = (get: (i: number, j: number) => boolean): void => {
    for (let i = 0; i < s; i++) {
      let run = 1;
      for (let j = 1; j <= s; j++) {
        if (j < s && get(i, j) === get(i, j - 1)) {
          run++;
          continue;
        }
        if (run >= 5) score += run - 2;
        run = 1;
      }
      for (let j = 0; j + FINDER_LIKE.length <= s; j++) {
        if (!FINDER_LIKE.every((p, k) => get(i, j + k) === p)) continue;
        const light = (from: number): boolean =>
          [0, 1, 2, 3].every((k) => from + k < 0 || from + k >= s || !get(i, from + k));
        if (light(j - 4) || light(j + FINDER_LIKE.length)) score += 40;
      }
    }
  };
  line((y, x) => g.get(x, y));
  line((x, y) => g.get(x, y));
  for (let y = 0; y + 1 < s; y++) {
    for (let x = 0; x + 1 < s; x++) {
      const c = g.get(x, y);
      if (c === g.get(x + 1, y) && c === g.get(x, y + 1) && c === g.get(x + 1, y + 1)) score += 3;
    }
  }
  const dark = g.modules.filter(Boolean).length;
  const total = s * s;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/** Encode `text` as UTF-8. Null when it does not fit in version 20. */
export function encodeQr(text: string): QrMatrix | null {
  const encoded = encodeData(new TextEncoder().encode(text));
  if (encoded === null) return null;
  const size = encoded.ver * 4 + 17;
  const g = new Grid(size);
  drawFunctionPatterns(g, encoded.ver);
  drawCodewords(g, encoded.codewords);
  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(g, mask);
    drawFormat(g, mask);
    const score = penalty(g);
    if (score < bestScore) {
      best = mask;
      bestScore = score;
    }
    applyMask(g, mask);
  }
  applyMask(g, best);
  drawFormat(g, best);
  return { size, modules: g.modules };
}

const SVG_NS = "http://www.w3.org/2000/svg";
const QUIET_ZONE = 4;

/**
 * Draw `text` as an SVG QR code: dark modules on white with the standard
 * four-module margin, whatever the theme, so every scanner can read it.
 */
export function qrCodeSvg(text: string, label: string): SVGSVGElement | null {
  const qr = encodeQr(text);
  if (qr === null) return null;
  const full = qr.size + QUIET_ZONE * 2;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${full} ${full}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  svg.setAttribute("shape-rendering", "crispEdges");
  const bg = document.createElementNS(SVG_NS, "rect");
  bg.setAttribute("width", String(full));
  bg.setAttribute("height", String(full));
  bg.setAttribute("fill", "#fff");
  const path = document.createElementNS(SVG_NS, "path");
  let d = "";
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y * qr.size + x] === true) d += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`;
    }
  }
  path.setAttribute("d", d);
  path.setAttribute("fill", "#000");
  svg.append(bg, path);
  return svg;
}
