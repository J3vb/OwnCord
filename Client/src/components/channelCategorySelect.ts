/**
 * The category <select> of the Create and Edit channel dialogs.
 *
 * The options are the categories the client knows (`getKnownCategories`: a
 * manager's list plus whatever the channels carry) and "No category". An option
 * value is `id:<n>` for a real category, `name:<text>` for a name-only category
 * from a server that sends no ids, and "" for none; what the dialog sends is
 * decided from the value by `categoryFields`.
 */

import { createElement } from "@lib/dom";
import { getKnownCategories } from "@stores/channels.store";
import { visibleCategories } from "@lib/permissions";
import { shellText } from "../i18n/shell";

/** The option value for a channel's (or a ref's) category. */
export function categoryOptionValue(categoryId: number, name: string): string {
  if (categoryId > 0) return `id:${categoryId}`;
  return name === "" ? "" : `name:${name}`;
}

/** A <select> of "No category" and every known category, with `selected` chosen. */
export function buildCategorySelect(
  id: string,
  testId: string,
  selected: string,
): HTMLSelectElement {
  const select = createElement("select", { id, class: "form-input", "data-testid": testId });
  select.appendChild(createElement("option", { value: "" }, shellText("channelForm.noCategory")));
  for (const known of getKnownCategories(visibleCategories())) {
    select.appendChild(
      createElement("option", { value: categoryOptionValue(known.id, known.name) }, known.name),
    );
  }
  setCategoryValue(select, selected);
  return select;
}

/** Select `value`, adding an option for it when the dialog opened before the category was known. */
export function setCategoryValue(select: HTMLSelectElement, value: string): void {
  if (!Array.from(select.options).some((o) => o.value === value)) {
    const label = value.startsWith("name:") ? value.slice("name:".length) : value;
    select.appendChild(createElement("option", { value }, label));
  }
  select.value = value;
}

/**
 * The request fields for a chosen option value. "No category" sends both fields
 * so an older server, which reads only the name, clears it too; a
 * current server lets `category_id` win.
 */
export function categoryFields(
  value: string,
): { category_id: number; category?: string } | { category: string } {
  if (value.startsWith("id:")) return { category_id: Number(value.slice("id:".length)) };
  if (value.startsWith("name:")) return { category: value.slice("name:".length) };
  return { category_id: 0, category: "" };
}
