/**
 * Turn named rows into `it.each` tuples so the full row name becomes the test
 * title: `it.each(byName(rows))("%s", (_name, row) => ...)`. A `$name` title is
 * cut at about forty characters, which would rename the long titles.
 */
export function byName<T extends { readonly name: string }>(
  rows: readonly T[],
): Array<[string, T]> {
  return rows.map((row): [string, T] => [row.name, row]);
}
