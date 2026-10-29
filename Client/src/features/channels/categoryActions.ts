/**
 * Category management calls (WP 6.5b): create, rename, delete and move. Each is
 * a REST call wrapped in try/catch at the call site that turns a failure into a
 * user-visible toast; none writes a store. The result arrives the way every
 * other category change does, as `channel_update` frames and a
 * `channel_categories` frame through the dispatcher, so the actor's own sidebar
 * and everyone else's redraw from the same events.
 */

import { ApiClientError, errorText } from "../../lib/api";
import type { ApiClient } from "../../lib/api";
import { channelsStore } from "../../stores/channels.store";
import { shellText } from "../../i18n/shell";
import { RestErrorCode } from "@lib/protocolTypes";

/** The server refused a create or rename onto a name another category holds. */
export const CATEGORY_NAME_TAKEN = RestErrorCode.CATEGORY_NAME_TAKEN;
/** A reorder named a set of ids that is not the server's current set. */
export const CATEGORY_LIST_STALE = RestErrorCode.CATEGORY_LIST_STALE;

/** What the actions need from the toast container. */
export interface CategoryToast {
  show(message: string, kind: "error" | "info" | "success"): void;
}

export type CategoryApi = Pick<
  ApiClient,
  "adminCreateCategory" | "adminRenameCategory" | "adminDeleteCategory" | "adminReorderCategories"
>;

/** A failed category call's text: friendly copy for a duplicate name, else the shared mapping. */
export function categoryErrorText(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError && err.code === CATEGORY_NAME_TAKEN) {
    return shellText("category.nameTaken");
  }
  return errorText(err, fallback);
}

/**
 * Run one category call. A failure is toasted and rethrown, so the dialog that
 * made the call can show its inline error and re-arm its button.
 */
async function run(
  toast: () => CategoryToast | null,
  fallback: string,
  call: () => Promise<unknown>,
): Promise<void> {
  try {
    await call();
  } catch (err) {
    toast()?.show(categoryErrorText(err, fallback), "error");
    throw err;
  }
}

export function createCategory(
  api: CategoryApi,
  toast: () => CategoryToast | null,
  name: string,
): Promise<void> {
  return run(toast, shellText("category.createFailed"), () => api.adminCreateCategory(name));
}

export function renameCategory(
  api: CategoryApi,
  toast: () => CategoryToast | null,
  id: number,
  name: string,
): Promise<void> {
  return run(toast, shellText("category.renameFailed"), () => api.adminRenameCategory(id, name));
}

export function deleteCategory(
  api: CategoryApi,
  toast: () => CategoryToast | null,
  id: number,
): Promise<void> {
  return run(toast, shellText("category.deleteFailed"), () => api.adminDeleteCategory(id));
}

/** The manager's list as ids, in the order the sidebar shows it. */
function categoryIds(): number[] {
  return channelsStore.getState().categories.map((c) => c.id);
}

/** Whether `id` has a neighbour to swap with in direction `-1` (up) or `1` (down). */
export function canMoveCategory(id: number, direction: -1 | 1): boolean {
  const ids = categoryIds();
  const at = ids.indexOf(id);
  return at !== -1 && at + direction >= 0 && at + direction < ids.length;
}

/**
 * PUT the full id list. Nothing is applied locally. The server answers with the
 * new order as a `channel_categories` frame, and on `409 CATEGORY_LIST_STALE`
 * (another manager reordered or created one first) it refused and wrote
 * nothing, so the order this client already shows, which that other change's
 * frame brought, stays: only a toast says the move did not apply. Never rejects.
 */
async function putOrder(
  api: CategoryApi,
  toast: () => CategoryToast | null,
  ids: readonly number[],
): Promise<void> {
  try {
    await api.adminReorderCategories(ids);
  } catch (err) {
    if (err instanceof ApiClientError && err.code === CATEGORY_LIST_STALE) {
      toast()?.show(shellText("category.listChanged"), "info");
      return;
    }
    toast()?.show(categoryErrorText(err, shellText("category.reorderFailed")), "error");
  }
}

/** Move a category one place up or down: the full id list with it swapped with its neighbour. */
export async function moveCategory(
  api: CategoryApi,
  toast: () => CategoryToast | null,
  id: number,
  direction: -1 | 1,
): Promise<void> {
  const ids = categoryIds();
  const at = ids.indexOf(id);
  const to = at + direction;
  if (at === -1 || to < 0 || to >= ids.length) return;
  const next = ids.slice();
  [next[at], next[to]] = [ids[to] as number, ids[at] as number];
  await putOrder(api, toast, next);
}

/**
 * Drop a dragged category before or after another (WP 6.5c): the full id list
 * with `id` taken out and put back next to `targetId`. A drop that leaves the
 * order as it is, or names a category the list does not hold, sends nothing.
 */
export async function placeCategory(
  api: CategoryApi,
  toast: () => CategoryToast | null,
  id: number,
  targetId: number,
  before: boolean,
): Promise<void> {
  const ids = categoryIds();
  if (id === targetId || !ids.includes(id) || !ids.includes(targetId)) return;
  const rest = ids.filter((x) => x !== id);
  const at = rest.indexOf(targetId) + (before ? 0 : 1);
  const next = [...rest.slice(0, at), id, ...rest.slice(at)];
  if (next.every((x, i) => x === ids[i])) return;
  await putOrder(api, toast, next);
}
