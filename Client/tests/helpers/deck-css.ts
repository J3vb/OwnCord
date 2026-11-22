// Command Deck's stylesheet, read for the deck-css tests. deck.css is parsed
// alone with Lightning CSS (the parser Vite uses), walking into @media, and
// every style rule is yielded with its printed selectors and its declarations.
// Each declaration lists the var() names and the literal colours it holds, so
// a test can enforce the colour rule without matching source text. Media
// queries are compared as source text: Lightning CSS rewrites `max-width` as a
// range, which no longer reads like responsive.css.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { transform } from "lightningcss";
import type { Declaration, StyleSheet } from "lightningcss";
import { selectorText } from "./app-css";

export interface DeckDeclaration {
  readonly property: string;
  readonly value: Declaration;
  /** Every `var()` name in the value, fallbacks included. */
  readonly vars: readonly string[];
  /** Bare words in the value (`solid`, `none`, `currentcolor`); keyword typed values are not listed. */
  readonly idents: readonly string[];
  /** Colours written out in the value, apart from the transparent a shorthand expands to. */
  readonly literalColours: readonly string[];
}

export interface DeckRule {
  readonly selectors: readonly string[];
  /** The source prelude of the enclosing @media, or null at the top level. */
  readonly media: string | null;
  readonly declarations: readonly DeckDeclaration[];
}

const STYLES = join(process.cwd(), "src/styles");

/** The colour properties of the brief's colour rule. */
export const COLOUR_PROPERTIES: ReadonlySet<string> = new Set([
  "color",
  "background",
  "background-color",
  "border",
  "border-color",
  ...["top", "right", "bottom", "left"].flatMap((side) => [
    `border-${side}`,
    `border-${side}-color`,
  ]),
  "box-shadow",
  "fill",
  "stroke",
  "caret-color",
  "text-decoration-color",
  "column-rule-color",
]);

const COLOUR_TYPES = new Set([
  "lab",
  "lch",
  "oklab",
  "oklch",
  "hsl",
  "hwb",
  "predefined",
  "light-dark",
]);
const COLOUR_FUNCTIONS = new Set([
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "hwb",
  "lab",
  "lch",
  "oklab",
  "oklch",
  "color",
  "color-mix",
  "light-dark",
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

interface Found {
  vars: string[];
  idents: string[];
  literalColours: string[];
}

function tokenOf(node: Record<string, unknown>, found: Found): void {
  const token = node["value"];
  if (!isObject(token)) return;
  if (token["type"] === "ident" && typeof token["value"] === "string") {
    found.idents.push(token["value"].toLowerCase());
  } else if (token["type"] === "hash" || token["type"] === "id-hash") {
    found.literalColours.push(`#${String(token["value"])}`);
  }
}

function varOf(node: Record<string, unknown>, found: Found): void {
  const v = node["value"];
  if (!isObject(v)) return;
  const name = v["name"];
  if (isObject(name) && typeof name["ident"] === "string") found.vars.push(name["ident"]);
}

/** Walks a parsed value. Typed colours arrive as `{ type: "rgb", ... }`; a value
 *  holding a `var()` arrives as raw tokens, whose colours are hash tokens,
 *  colour functions or named idents. */
function walk(node: unknown, found: Found): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, found);
    return;
  }
  if (!isObject(node)) return;
  const type = node["type"];
  if (type === "var") varOf(node, found);
  if (type === "token") tokenOf(node, found);
  if (type === "rgb" && node["alpha"] !== 0) found.literalColours.push("rgb");
  if (typeof type === "string" && COLOUR_TYPES.has(type)) found.literalColours.push(type);
  const name = node["name"];
  if (type === "function" && typeof name === "string" && COLOUR_FUNCTIONS.has(name)) {
    found.literalColours.push(`${name}()`);
  }
  for (const child of Object.values(node)) walk(child, found);
}

function propertyName(d: Declaration): string {
  switch (d.property) {
    case "custom":
      return d.value.name;
    case "unparsed":
      return d.value.propertyId.property;
    default:
      return d.property;
  }
}

function declaration(value: Declaration): DeckDeclaration {
  const found: Found = { vars: [], idents: [], literalColours: [] };
  // The property id of an unparsed value is not part of the value to inspect.
  walk(value.property === "unparsed" ? value.value.value : value.value, found);
  return { property: propertyName(value), value, ...found };
}

/** Every `@media` prelude in `source`, in document order, comments dropped, spaces collapsed. */
export function mediaPreludes(source: string): string[] {
  const bare = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...bare.matchAll(/@media([^{]+)\{/g)].map((m) => m[1]!.replace(/\s+/g, " ").trim());
}

/** The preludes of a stylesheet under src/styles, e.g. "app/responsive.css". */
export function preludesOf(file: string): string[] {
  return mediaPreludes(readFileSync(join(STYLES, file), "utf8"));
}

/** Parses `source` as deck.css would be: style rules at the top level and inside @media. */
export function parseDeckCss(source: string): readonly DeckRule[] {
  let sheet: StyleSheet | undefined;
  transform({
    filename: "deck.css",
    code: new TextEncoder().encode(source),
    visitor: {
      StyleSheet(s) {
        sheet = s;
      },
    },
  });
  const preludes = mediaPreludes(source);
  let mediaIndex = 0;
  const rules: DeckRule[] = [];
  const addStyle = (
    rule: {
      value: {
        selectors: Parameters<typeof selectorText>[0][];
        declarations?: { declarations?: Declaration[]; importantDeclarations?: Declaration[] };
      };
    },
    media: string | null,
  ): void => {
    const block = rule.value.declarations;
    const written = [...(block?.declarations ?? []), ...(block?.importantDeclarations ?? [])];
    rules.push({
      selectors: rule.value.selectors.map(selectorText),
      media,
      declarations: written.map(declaration),
    });
  };
  for (const rule of sheet!.rules) {
    if (rule.type === "style") addStyle(rule, null);
    if (rule.type !== "media") continue;
    const media = preludes[mediaIndex++] ?? null;
    for (const inner of rule.value.rules) if (inner.type === "style") addStyle(inner, media);
  }
  return rules;
}

let cached: readonly DeckRule[] | undefined;

/** The rules of src/styles/app/deck.css. */
export function deckRules(): readonly DeckRule[] {
  cached ??= parseDeckCss(readFileSync(join(STYLES, "app/deck.css"), "utf8"));
  return cached;
}

/** Every rule that lists `selector` (one printed entry of its selector list). */
export function rulesFor(selector: string, rules: readonly DeckRule[] = deckRules()): DeckRule[] {
  return rules.filter((r) => r.selectors.includes(selector));
}

/** The first declaration of `property` among the rules for `selector`. */
export function declarationOf(
  selector: string,
  property: string,
  media?: string | null,
): DeckDeclaration | undefined {
  return rulesFor(selector)
    .filter((r) => media === undefined || r.media === media)
    .flatMap((r) => r.declarations)
    .find((d) => d.property === property);
}

/** A single-keyword value (`contents`, `none`) as text, or undefined. */
export function keywordOf(d: DeckDeclaration | undefined): string | undefined {
  const v: unknown = d?.value.value;
  if (isObject(v) && v["type"] === "keyword" && typeof v["value"] === "string") return v["value"];
  return undefined;
}
