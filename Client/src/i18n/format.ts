/**
 * The English text seam (B9-3, BPR-064): feature-owned catalogs with typed
 * parameters and plurals, and the one place dates and numbers are formatted.
 *
 * A feature defines its catalog once and reads it where it renders:
 *
 *   export const shellText = defineCatalog("shell", {
 *     "dm.viewAll": "View all messages ({count})",
 *     "dm.unread": { one: "{count} unread message", other: "{count} unread messages" },
 *   });
 *   setText(button, shellText("dm.viewAll", { count: dms.length }));
 *
 * - Keys are stable identifiers; never derive them from the English text.
 * - `{name}` is a placeholder. Its parameter is required by the type, and the
 *   value is inserted verbatim, so user and server data (names, topics,
 *   reasons, message text) and wire identifiers pass through untranslated.
 * - A plural entry takes `count` and picks the English plural category; never
 *   concatenate plural fragments.
 * - The result is plain text. Render it with setText, textContent or an
 *   attribute, never as HTML.
 * - Resolve text when rendering, not at module load, so every read goes
 *   through the seam.
 *
 * English is the only shipped language: no locale picker and no runtime
 * download. The expansion transform exists for tests only.
 */

/** The locale every catalog string, number and date is written in. */
export const TEXT_LOCALE = "en-US";

type PluralEntry = Readonly<Partial<Record<Intl.LDMLPluralRule, string>>> & {
  readonly other: string;
};
type Entry = string | PluralEntry;
type Entries = Readonly<Record<string, Entry>>;
type TextValue = string | number;

type Placeholders<S> = S extends `${string}{${infer P}}${infer Rest}`
  ? P | Placeholders<Rest>
  : never;
type Templates<E> = E extends string ? E : E[keyof E];
type ParamsOf<E> = E extends string
  ? { readonly [P in Placeholders<E>]: TextValue }
  : { readonly count: number } & {
      readonly [P in Exclude<Placeholders<Templates<E>>, "count">]: TextValue;
    };
type ArgsOf<E> = E extends string
  ? [Placeholders<E>] extends [never]
    ? []
    : [params: ParamsOf<E>]
  : [params: ParamsOf<E>];

/** A catalog's reader: the key picks the entry, and the entry types its parameters. */
export type Translate<C extends Entries> = <K extends keyof C & string>(
  key: K,
  ...args: ArgsOf<C[K]>
) => string;

const pluralRules = new Intl.PluralRules(TEXT_LOCALE);
const numberFormat = new Intl.NumberFormat(TEXT_LOCALE);

let transform: ((template: string) => string) | null = null;

/** Format a number for display, grouped the English way (1,234). */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return options === undefined
    ? numberFormat.format(value)
    : new Intl.NumberFormat(TEXT_LOCALE, options).format(value);
}

/** Format a date or time for display in the catalog locale. */
export function formatDate(value: Date | number, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(TEXT_LOCALE, options).format(value);
}

function interpolate(template: string, params: Readonly<Record<string, TextValue>>): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = params[name];
    if (value === undefined) return placeholder;
    return typeof value === "number" ? formatNumber(value) : value;
  });
}

/**
 * Define a feature's English catalog. A key the catalog lacks can only arrive
 * through a cast; it renders as `namespace.key` so the gap is visible without
 * breaking the screen.
 */
export function defineCatalog<const C extends Entries>(
  namespace: string,
  entries: C,
): Translate<C> {
  const translate = (key: string, params: Readonly<Record<string, TextValue>> = {}): string => {
    const entry = Object.hasOwn(entries, key) ? entries[key] : undefined;
    if (entry === undefined) return `${namespace}.${key}`;
    const template =
      typeof entry === "string"
        ? entry
        : (entry[pluralRules.select(Number(params["count"]))] ?? entry.other);
    return interpolate(transform === null ? template : transform(template), params);
  };
  return translate;
}

/**
 * Pseudo-expansion for layout tests: the template gains about 40 % of its own
 * words and a bracket at each end, so clipping shows as a missing `⟧`.
 * Placeholders are kept, and parameters are inserted unexpanded.
 */
export function expandText(template: string): string {
  const words = template.replace(/\{\w+\}/g, "").trim();
  const extra = Math.ceil(template.length * 0.4);
  const pad =
    words === ""
      ? ""
      : " " +
        `${words} `
          .repeat(Math.ceil(extra / (words.length + 1)))
          .slice(0, extra)
          .trim();
  return `⟦${template}${pad}⟧`;
}

/** Test only: rewrite every catalog template before interpolation, or restore English with null. */
export function setTextTransformForTesting(fn: ((template: string) => string) | null): void {
  transform = fn;
}
