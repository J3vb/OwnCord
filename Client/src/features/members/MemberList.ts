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
import {
  MEMBER_PATCH_FIELDS,
  drawMemberItem,
  patchMemberItem,
  type MemberItemModel,
} from "./memberRow.view";
import { createAvatarElement } from "../profiles/avatar";
import {
  buildModel,
  flattenModel,
  updateModel,
  type ListItem,
  type MemberModel,
} from "./memberModel";
import type { MemberListOptions } from "./memberListOptions";
import {
  ESTIMATED_HEIGHTS,
  OVERSCAN,
  VIRTUAL_ABOVE,
  itemModel,
  kindOf,
  kindOfModel,
  measureKindHeights,
  createMemberSearchInput,
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

export function createMemberList(opts: MemberListOptions): MemberListComponent {
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
  const heights = [...ESTIMATED_HEIGHTS];
  const kindByEl = new WeakMap<Element, number>();
  const topByKey = new Map<string, number>();
  const samples: (Element | null)[] = [null, null, null, null];
  const sampleSizes = new WeakMap<Element, string>();
  let scroller: HTMLElement | null = null;
  let observer: ResizeObserver | null = null;
  let scrollBinding: Disposable | null = null;

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

  /** The row to focus when the member is gone: in virtual mode the first drawn
   *  row inside the scroller's view, so focus never drags the list to a pinned
   *  or overscan row. */
  function fallbackRow(): HTMLElement | null {
    const first = root?.querySelector<HTMLElement>(".member-item") ?? null;
    if (!virtual || scroller === null || root === null) return first;
    const view = scroller.getBoundingClientRect();
    // The scroll padding is the strip under the sticky search box, which
    // scrollIntoView keeps clear, so a row there would still scroll.
    const css = getComputedStyle(scroller);
    const top = view.top + scroller.clientTop + (parseFloat(css.scrollPaddingTop) || 0);
    const bottom =
      view.top +
      scroller.clientTop +
      scroller.clientHeight -
      (parseFloat(css.scrollPaddingBottom) || 0);
    for (const row of root.querySelectorAll<HTMLElement>(".member-item")) {
      const box = row.getBoundingClientRect();
      if (box.top >= top && box.bottom <= bottom) return row;
    }
    return first;
  }

  function focusMember(id: number): HTMLElement | null {
    reveal(id);
    const el = rowEl(id) ?? fallbackRow();
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
    // A row that holds focus and is filtered away or removed drops focus to
    // the page; it goes to the same member if still shown, else the first row.
    const focused = document.activeElement;
    const focusedId =
      focused instanceof HTMLElement && focused.parentElement === root
        ? idByEl.get(focused)
        : undefined;
    reconcileModels<ListItem, MemberItemModel>(root, list, {
      key: (item) => item.key,
      model: itemModel,
      // Status is a patch field: it changes the dot in place without a rebuild.
      // A row rebuilt while its context menu is open drops focus to the page
      // when the menu closes (accepted; only its own name, avatar, custom
      // status or role colour changing does this).
      patch: { fields: MEMBER_PATCH_FIELDS, apply: patchMemberItem },
      create: (drawn, atEvent) => {
        const el = drawMemberItem(drawn, createAvatarElement);
        if (drawn.kind === "row") {
          const owner = new Disposable();
          createMemberItem(el, atEvent, opts, hooks, owner.signal);
          ownerByEl.set(el, owner);
          idByEl.set(el, drawn.id);
        }
        kindByEl.set(el, kindOfModel(drawn));
        return el;
      },
      dispose: (el) => {
        ownerByEl.get(el)?.destroy();
        ownerByEl.delete(el);
        idByEl.delete(el);
      },
    });
    // The container holds exactly one child per item, in order.
    list.forEach((item, i) => {
      const el = root?.children[i];
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
    items = flattenModel(model, query);
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

  function findScroller(): HTMLElement | null {
    for (let el = root?.parentElement ?? null; el !== null; el = el.parentElement) {
      const overflow = getComputedStyle(el).overflowY;
      if (overflow === "auto" || overflow === "scroll") return el;
    }
    return null;
  }

  function bindScroller(next: HTMLElement | null): void {
    if (next === scroller) return;
    scrollBinding?.destroy();
    scrollBinding = null;
    if (scroller !== null) observer?.unobserve(scroller);
    scroller = next;
    if (next === null) return;
    if (root !== null) observer?.unobserve(root);
    const binding = new Disposable();
    scrollBinding = binding;
    next.addEventListener("scroll", schedule, { passive: true, signal: binding.signal });
    observer?.observe(next);
  }

  // A scroller or a sampled row that changed size (collapse and expand, drag
  // resize, a font-size change) needs a frame. A sample's first report is only
  // its starting size, so a new sample never schedules one.
  function onResize(entries: readonly ResizeObserverEntry[]): void {
    let changed = false;
    for (const { target, contentRect } of entries) {
      const size = `${contentRect.width}x${contentRect.height}`;
      const before = sampleSizes.get(target);
      sampleSizes.set(target, size);
      if (before !== size && (before !== undefined || target === scroller || target === root)) {
        changed = true;
      }
    }
    if (changed) schedule();
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

  function ensureObserver(): void {
    if (observer === null && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(onResize);
      disposable.addCleanup(() => observer?.disconnect());
    }
  }

  function ensureScroller(rootEl: HTMLElement): void {
    // Until a scroller is found (the panel is built before its host appends
    // it) the root itself is watched, so connecting it schedules a frame.
    if (scroller === null || !scroller.contains(rootEl)) {
      bindScroller(findScroller());
      if (scroller === null) observer?.observe(rootEl);
    }
  }

  function syncItems(): void {
    model = memberModelFor(membersStore.getState().members, channelsStore.getState().roles);
    if (model !== flatModel || query !== flatQuery) {
      flatModel = model;
      flatQuery = query;
      items = flattenModel(model, query);
      itemIndex = new Map(items.map((item, at) => [item.key, at]));
      offsetsDirty = true;
    }
    if (queryChanged) {
      queryChanged = false;
      if (scroller !== null && scroller.scrollTop > 0) scroller.scrollTop = 0;
    }
  }

  function paintPasses(): void {
    for (let pass = 0; pass < 2; pass++) {
      if (offsetsDirty) {
        offsets = buildOffsets(items.map((item) => heights[kindOf(item)]!));
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
      ensureObserver();
      ensureScroller(root);
      syncItems();
      measure();
      paintPasses();
      sampleRows();
    } finally {
      inFrame = false;
    }
  }

  /** Watch one row of each kind, so a height change that moves nothing else
   *  still reaches `onResize`. */
  function sampleRows(): void {
    if (root === null) return;
    const first: (Element | null)[] = [null, null, null, null];
    for (const child of root.children) {
      const kind = kindByEl.get(child);
      if (kind !== undefined && first[kind] === null) first[kind] = child;
    }
    first.forEach((el, kind) => {
      const old = samples[kind];
      if (el === old) return;
      if (old !== null && old !== undefined) observer?.unobserve(old);
      if (el !== null) observer?.observe(el);
      samples[kind] = el;
    });
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

    disposable.addCleanup(() => scrollBinding?.destroy());
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
