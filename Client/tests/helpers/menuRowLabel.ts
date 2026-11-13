/**
 * A menu row's own label: the first child after its leading icon slot, so a
 * submenu trigger reports its label without its flyout's rows.
 */
export function menuRowLabel(row: Element): string {
  const slot = row.querySelector(":scope > .menu-item-icon");
  return (slot === null ? row.firstChild : slot.nextSibling)?.textContent ?? "";
}
