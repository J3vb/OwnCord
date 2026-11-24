/**
 * MemberList component — shows server members grouped by role with online status.
 * Subscribes to membersStore for reactive updates.
 * Right-click context menu for admin actions (force logout, ban, role change).
 */

import { createElement } from "@lib/dom";
import { reconcileModels } from "@lib/net/reconcile";
import { select } from "@lib/ui/select";
import { shallowEqual } from "@lib/store";
import { buildOffsets, rangeFor } from "@lib/ui/virtualRange";
import type { MountableComponent } from "@lib/text/safeRender";
import { Disposable } from "@lib/disposable";
import { membersStore } from "@stores/members.store";
import { channelsStore } from "@stores/channels.store";
import { classicMemberRows, classicView, type MemberRowModelBase } from "./memberRowRenderer";
import { createScrollWatch } from "./memberListScroll";
import {
  buildModel,
  flattenModel,
  updateModel,
  type ListItem,
  type MemberModel,
} from "./memberModel";
import type { MemberListOptions } from "./memberListOptions";
import {
  OVERSCAN,
  VIRTUAL_ABOVE,
  measureKindHeights,
  createMemberSearchInput,
  firstRowInView,
  memberModelFor,
  ownPopupClosers,
  navigationTarget,
} from "./memberListModel";
import { closeActiveMenu, createMemberItem, getMenuRowKey, type RowHooks } from "./memberRowMenu";

export type { MemberListOptions } from "./memberListOptions";
export { hasMemberModelMemo, memberModelFor } from "./memberListModel";

/** The member list, plus a way for its owner to return focus to a member's row. */
export interface MemberListComponent extends MountableComponent {
  /** Focus member `id`'s row, or the first row when that member is gone. Returns the row. */
  focusMember(id: number): HTMLElement | null;
}

/** No group is folded unless the owner passes a collapsed set. */
const NONE_COLLAPSED: ReadonlySet<string> = new Set();

export function createMemberList(opts: MemberListOptions): MemberListComponent {
  const view = opts.view ?? classicView(opts.rows ?? classicMemberRows);
  const flatten = opts.flatten ?? flattenModel;
  const disposable = new Disposable();
  let root: HTMLDivElement | null = null;
  let searchWrap: HTMLDivElement | null = null;
  // The filter lives here, so every store-driven render re-applies it. It is
  // not persisted: a remount starts with an empty box.
  let query = "";
  // Sorted and grouped members, updated in place of a rebuild on each store
  // change. Model only: it holds no DOM and is dropped with the component.
  let model: MemberModel | null = null;
  // What the list shows now, in order: navigation walks this, not DOM siblings.
  let items: readonly ListItem[] = [];
  // Rows are reused across renders, so each owns its listeners: a row's owner
  // is destroyed when reconcile removes or rebuilds it (listeners on
  // the component-lifetime signal would retain every discarded row), and
  // destroy() disposes the rest. Per-row state lives in WeakMaps keyed by the
  // row element.
  const ownerByEl = new WeakMap<Element, Disposable>();
  const idByEl = new WeakMap<Element, number>();

  // Virtual mode (more than VIRTUAL_ABOVE members): rows are absolutely
  // positioned inside `root`, whose height is the whole list, and only the
  // window around the viewport is in the DOM. Store changes and scrolls
  // schedule one frame; `items` and `offsets` always describe the whole list.
  let virtual = false;
  let frameId: number | null = null;
  let inFrame = false;
  let queryChanged = false;
  let flatModel: MemberModel | null = null;
  let flatQuery = "";
  let itemIndex = new Map<string, number>();
  let offsets = buildOffsets([]);
  let offsetsDirty = true;
  let revealKey: string | null = null;
  const heights = view.use((rows) => [...rows.estimatedHeights]);
  const kindByEl = new WeakMap<Element, number>();
  const topByKey = new Map<string, number>();
  const watch = createScrollWatch(schedule);

  function rowEl(id: number): HTMLElement | null {
    return root?.querySelector<HTMLElement>(`[data-testid="member-${id}"]`) ?? null;
  }

  function flushFrame(): void {
    if (frameId !== null) {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
    runFrame();
  }

  /** Draw member `id`'s row now when the window left it out (virtual mode). */
  function reveal(id: number): void {
    if (!virtual || inFrame || rowEl(id) !== null) return;
    revealKey = `u:${id}`;
    flushFrame();
    revealKey = null;
  }

  function focusMember(id: number): HTMLElement | null {
    reveal(id);
    // In virtual mode the fallback is the first drawn row inside the
    // scroller's view, so focus never drags the list to a pinned or overscan row.
    const el =
      rowEl(id) ?? (root === null ? null : firstRowInView(root, virtual ? watch.scroller() : null));
    if (el === null) {
      // No rows left (a search nobody matches): the search box keeps focus in the list.
      const search = searchWrap?.querySelector<HTMLElement>(".member-search") ?? null;
      search?.focus();
      return search;
    }
    if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
    el.focus({ preventScroll: true });
    return el;
  }

  function navigate(key: string, id: number, from: HTMLElement): void {
    const rows = items.filter((item) => item.kind === "row");
    if (rows.length === 0) return;
    // Looked up by id at key time, so a member that moved group continues from
    // where it is now.
    const at = rows.findIndex((item) => item.member.id === id);
    const last = rows.length - 1;
    const next = navigationTarget(key, at, last, from);
    const target = rows[next];
    if (target !== undefined && target.member.id !== id) focusMember(target.member.id);
  }

  const hooks: RowHooks = { navigate, focusMember };

  /** Put a row at its offset (virtual mode) or back in the flow (full mode). */
  function place(el: Element, key: string): void {
    const top = virtual ? topByKey.get(key) : undefined;
    if (top === undefined) {
      if (el.hasAttribute("style")) el.removeAttribute("style");
      return;
    }
    const style = (el as HTMLElement).style;
    const px = `${top}px`;
    if (style.top !== px) style.cssText = `position: absolute; left: 0; right: 0; top: ${px}`;
  }

  function reconcileRows(list: readonly ListItem[]): void {
    if (root === null) return;
    const host = root;
    // A row that holds focus and is filtered away or removed drops focus to
    // the page; it goes to the same member if still shown, else the first row.
    const focused = document.activeElement;
    const focusedId =
      focused instanceof HTMLElement && focused.parentElement === root
        ? idByEl.get(focused)
        : undefined;
    view.use((rows, ctx) =>
      reconcileModels(host, list, {
        key: (item) => item.key,
        model: (item) => rows.model(item, ctx),
        // Status is a patch field: it changes the dot in place without a rebuild.
        // A row rebuilt while its context menu is open drops focus to the page
        // when the menu closes (accepted; only its own name, avatar, custom
        // status or role colour changing does this).
        patch: rows.patch,
        create: (drawn, atEvent) => {
          const el = rows.draw(drawn);
          const base: MemberRowModelBase = drawn;
          if (base.kind === "row") {
            const owner = new Disposable();
            createMemberItem(el, atEvent, opts, hooks, owner.signal);
            ownerByEl.set(el, owner);
            idByEl.set(el, base.id);
          }
          kindByEl.set(el, rows.modelKind(drawn));
          return el;
        },
        dispose: (el) => {
          ownerByEl.get(el)?.destroy();
          ownerByEl.delete(el);
          idByEl.delete(el);
        },
      }),
    );
    // The container holds exactly one child per item, in order.
    list.forEach((item, i) => {
      const el = host.children[i];
      if (el !== undefined) place(el, item.key);
    });
    if (
      focusedId !== undefined &&
      !(
        document.activeElement instanceof HTMLElement &&
        document.activeElement.parentElement === root
      )
    ) {
      focusMember(focusedId);
    }
  }

  function renderFull(): void {
    const members = membersStore.getState().members;
    const roles = channelsStore.getState().roles;
    model = model === null ? buildModel(members, roles) : updateModel(model, members, roles);
    items = flatten(model, query, NONE_COLLAPSED);
    reconcileRows(items);
  }

  function render(): void {
    if (root === null) return;
    if (membersStore.getState().members.size > VIRTUAL_ABOVE) {
      virtual = true;
      schedule();
      return;
    }
    if (virtual) leaveVirtual();
    queryChanged = false;
    renderFull();
  }

  function leaveVirtual(): void {
    virtual = false;
    if (frameId !== null) {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
    flatModel = null;
    topByKey.clear();
    root?.removeAttribute("style");
  }

  function schedule(): void {
    if (!virtual || frameId !== null || root === null) return;
    frameId = requestAnimationFrame(runFrame);
  }

  /** Re-measure each kind from the rows in the DOM; true when a height changed. */
  function measure(): boolean {
    if (root === null) return false;
    const changed = measureKindHeights(root, kindByEl, heights);
    if (changed) offsetsDirty = true;
    return changed;
  }

  function pinnedIndices(): number[] {
    const active = document.activeElement;
    const focusedId =
      active instanceof HTMLElement && active.parentElement === root
        ? idByEl.get(active)
        : undefined;
    const out: number[] = [];
    for (const key of [
      focusedId === undefined ? null : `u:${focusedId}`,
      getMenuRowKey(),
      revealKey,
    ]) {
      const at = key === null ? undefined : itemIndex.get(key);
      if (at !== undefined) out.push(at);
    }
    return out;
  }

  /** Draw the window and the pinned rows. */
  function paint(): void {
    if (root === null) return;
    const wanted: ListItem[] = [];
    topByKey.clear();
    // Rows are positioned from the root's padding edge, so its own padding is
    // added back to keep the spacing the flowed list has.
    const css = getComputedStyle(root);
    const padTop = parseFloat(css.paddingTop) || 0;
    const padBottom = parseFloat(css.paddingBottom) || 0;
    const borderBox = css.boxSizing === "border-box";
    const scroller = watch.scroller();
    if (scroller !== null) {
      const viewTop =
        scroller.getBoundingClientRect().top +
        scroller.clientTop -
        root.getBoundingClientRect().top;
      const range = rangeFor(
        offsets,
        viewTop - padTop,
        scroller.clientHeight,
        OVERSCAN,
        pinnedIndices(),
      );
      const draw = (at: number): void => {
        const item = items[at]!;
        topByKey.set(item.key, padTop + offsets[at]!);
        wanted.push(item);
      };
      for (const at of range.pinned) if (at < range.start) draw(at);
      for (let at = range.start; at < range.end; at++) draw(at);
      for (const at of range.pinned) if (at >= range.end) draw(at);
    }
    reconcileRows(wanted);
    const total = offsets[offsets.length - 1]! + (borderBox ? padTop + padBottom : 0);
    root.style.position = "relative";
    root.style.height = `${total}px`;
  }

  function syncItems(): void {
    model = memberModelFor(membersStore.getState().members, channelsStore.getState().roles);
    if (model !== flatModel || query !== flatQuery) {
      flatModel = model;
      flatQuery = query;
      items = flatten(model, query, NONE_COLLAPSED);
      itemIndex = new Map(items.map((item, at) => [item.key, at]));
      offsetsDirty = true;
    }
    if (queryChanged) {
      queryChanged = false;
      const scroller = watch.scroller();
      if (scroller !== null && scroller.scrollTop > 0) scroller.scrollTop = 0;
    }
  }

  function paintPasses(): void {
    for (let pass = 0; pass < 2; pass++) {
      if (offsetsDirty) {
        offsets = view.use((rows) =>
          buildOffsets(items.map((item) => heights[rows.itemKind(item)]!)),
        );
        offsetsDirty = false;
      }
      paint();
      // Re-measure what was just drawn: a new row of a kind can be taller
      // than the one measured before (a wrapped role name, a font change
      // while no row of that kind was drawn).
      if (!measure()) break;
    }
  }

  function runFrame(): void {
    frameId = null;
    if (root === null || !virtual || inFrame) return;
    inFrame = true;
    try {
      watch.bind(root);
      syncItems();
      measure();
      paintPasses();
      watch.sample(root, kindByEl);
    } finally {
      inFrame = false;
    }
  }

  function mount(container: Element): void {
    root = createElement("div", { class: "member-list", "data-testid": "member-list" });
    const search = createMemberSearchInput(disposable.signal, (value) => {
      query = value;
      queryChanged = true;
      render();
    });
    searchWrap = createElement("div", { class: "member-search-wrap" });
    searchWrap.appendChild(search);
    render();

    // Members and the server's role list (role management makes it mutable at
    // runtime: a roles_update broadcast replaces it) both decide the groups.
    select(
      [membersStore, channelsStore],
      (m, c) => ({ members: m.members, roles: c.roles }),
      () => {
        render();
      },
      // Each slice keeps its own shallow compare, so a copied Map with the
      // same entries does not re-render.
      {
        signal: disposable.signal,
        equals: (a, b) => shallowEqual(a.members, b.members) && shallowEqual(a.roles, b.roles),
      },
    );

    // The row context (the renderer's state that is not on the member) patches
    // the drawn rows when it changes.
    view.subscribe(disposable.signal, render);
    disposable.addCleanup(() => watch.destroy());
    container.append(searchWrap, root);
  }

  function destroy(): void {
    closeActiveMenu();
    for (const close of ownPopupClosers) close();
    ownPopupClosers.clear();
    if (frameId !== null) {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
    disposable.destroy();
    if (root !== null) {
      for (const child of Array.from(root.children)) ownerByEl.get(child)?.destroy();
      root.remove();
      root = null;
    }
    searchWrap?.remove();
    searchWrap = null;
  }

  return { mount, destroy, focusMember };
}
