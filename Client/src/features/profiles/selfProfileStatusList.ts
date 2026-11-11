/** The self profile card's status menu: Online, Idle, Do Not Disturb and
 *  Invisible, with the timed-status duration lists and their keyboard walk. */

import { isImeCommit } from "@lib/text/ime";
import { createElement, appendChildren, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { UserStatus } from "@lib/types";
import { STATUS_DURATIONS } from "@lib/text/statusChoices";
import { isTimedStatus, loadStatusTimer } from "@lib/presence/userStatus";
import { STATUS_DEFS, statusNote, statusTimerLine, type StatusDef } from "../presence/statusDefs";
import { shellText } from "../../i18n/shell";
import type { CardSession } from "./selfProfileTypes";

export interface StatusListPart {
  readonly element: HTMLElement;
  paintStatus(): void;
  paintTimer(): void;
  /** Enable or disable the rows to match `session.enabled`. */
  paintEnabled(): void;
  /** The row for the current status: where focus lands on open. */
  currentRow(): HTMLElement | undefined;
}

/** The maps one open list keeps per status. */
interface ListState {
  readonly s: CardSession;
  readonly items: Map<UserStatus, HTMLButtonElement>;
  readonly untilLines: Map<UserStatus, HTMLElement>;
  readonly chevrons: Map<UserStatus, HTMLButtonElement>;
  readonly durationGroups: Map<UserStatus, HTMLElement>;
  readonly durationItems: Map<UserStatus, HTMLButtonElement[]>;
  expanded: UserStatus | null;
}

function paintExpanded(st: ListState): void {
  for (const [value, el] of st.durationGroups) el.hidden = value !== st.expanded;
  for (const [value, el] of st.items) {
    if (isTimedStatus(value)) el.setAttribute("aria-expanded", String(value === st.expanded));
  }
}

function commitStatus(st: ListState, value: UserStatus, durationMs?: number): void {
  const { s } = st;
  if (!s.enabled) return;
  s.status = value;
  paintStatusRows(st);
  s.options.onStatusChange(value, durationMs);
  s.close();
}

function paintStatusRows(st: ListState): void {
  for (const [value, el] of st.items) {
    const on = value === st.s.status;
    el.setAttribute("aria-checked", String(on));
    el.tabIndex = on ? 0 : -1;
    el.classList.toggle("spc-status--current", on);
  }
}

/** "Until 3:40 PM" under the status a running timer belongs to. */
function paintTimerLines(st: ListState): void {
  const timer = loadStatusTimer();
  const live = timer !== null && timer.status === st.s.status && timer.until > Date.now();
  for (const [value, el] of st.untilLines) {
    const show = live && timer.status === value;
    el.hidden = !show;
    setText(el, show ? statusTimerLine(timer.until) : "");
  }
}

/** The status button itself: dot, label, note, "until" line and check. */
function buildStatusButton(st: ListState, def: StatusDef): HTMLButtonElement {
  const timed = isTimedStatus(def.value);
  const btn = createElement("button", {
    class: "spc-status",
    type: "button",
    role: "menuitemradio",
    "aria-checked": "false",
    tabindex: "-1",
    "data-testid": `spc-status-${def.value}`,
    ...(timed
      ? { "aria-keyshortcuts": "ArrowRight", "aria-haspopup": "menu", "aria-expanded": "false" }
      : {}),
  });
  const dot = createElement("span", { class: "spc-status-dot" });
  dot.style.background = def.color;
  const text = createElement("span", { class: "spc-status-text" });
  text.appendChild(createElement("span", { class: "spc-status-label" }, shellText(def.labelKey)));
  const note = statusNote(def);
  if (note !== null) {
    text.appendChild(
      createElement(
        "span",
        { class: "spc-status-note", "data-testid": `spc-note-${def.value}` },
        note,
      ),
    );
  }
  const until = createElement("span", {
    class: "spc-status-until",
    "data-testid": `spc-until-${def.value}`,
  });
  until.hidden = true;
  st.untilLines.set(def.value, until);
  text.appendChild(until);
  const check = createElement("span", { class: "spc-status-check" });
  check.appendChild(createIcon("check", 16));
  appendChildren(btn, dot, text, check);
  btn.addEventListener("click", () => commitStatus(st, def.value), { signal: st.s.signal });
  st.items.set(def.value, btn);
  return btn;
}

/** Idle, Do Not Disturb and Invisible can be put on a timer. The chevron
 *  is the pointer's way in; the keyboard's is ArrowRight on the row, so
 *  it stays out of the roving order and the accessibility tree. */
function buildChevron(st: ListState, def: StatusDef): HTMLButtonElement {
  const { signal } = st.s;
  const chevron = createElement("button", {
    class: "spc-status-chevron",
    type: "button",
    tabindex: "-1",
    "aria-hidden": "true",
    "data-testid": `spc-chevron-${def.value}`,
  });
  chevron.appendChild(createIcon("chevron-down", 16));
  chevron.addEventListener("mousedown", (e: MouseEvent) => e.preventDefault(), { signal });
  chevron.addEventListener(
    "click",
    () => {
      if (!st.s.enabled) return;
      st.expanded = st.expanded === def.value ? null : def.value;
      paintExpanded(st);
    },
    { signal },
  );
  st.chevrons.set(def.value, chevron);
  return chevron;
}

/** The "for 30 minutes ... until I turn it off" list under a timed status. */
function buildDurationList(st: ListState, def: StatusDef): HTMLElement {
  const durations = createElement("div", {
    class: "spc-durations",
    role: "menu",
    "aria-label": shellText("status.durationsFor", { status: shellText(def.labelKey) }),
    "data-testid": `spc-durations-${def.value}`,
  });
  durations.hidden = true;
  const buttons: HTMLButtonElement[] = [];
  const choices: ReadonlyArray<{
    id: string;
    label: string;
    ms: number | undefined;
  }> = [
    ...STATUS_DURATIONS.map((o) => ({ id: o.id, label: shellText(o.labelKey), ms: o.ms })),
    { id: "forever", label: shellText("status.duration.forever"), ms: undefined },
  ];
  for (const choice of choices) {
    const item = createElement(
      "button",
      {
        class: "spc-action spc-duration",
        type: "button",
        role: "menuitem",
        tabindex: "-1",
        "data-testid": `spc-duration-${def.value}-${choice.id}`,
      },
      choice.label,
    );
    item.disabled = !st.s.enabled;
    item.addEventListener("click", () => commitStatus(st, def.value, choice.ms), {
      signal: st.s.signal,
    });
    buttons.push(item);
    durations.appendChild(item);
  }
  st.durationGroups.set(def.value, durations);
  st.durationItems.set(def.value, buttons);
  return durations;
}

function buildStatusRadio(st: ListState, def: StatusDef): HTMLElement {
  const btn = buildStatusButton(st, def);
  const wrap = createElement("div", { class: "spc-status-entry" });
  if (!isTimedStatus(def.value)) {
    wrap.appendChild(btn);
    return wrap;
  }
  const row = createElement("div", { class: "spc-status-row" });
  appendChildren(row, btn, buildChevron(st, def));
  appendChildren(wrap, row, buildDurationList(st, def));
  return wrap;
}

/** Everything the arrow keys walk, top to bottom: the status rows, with
 *  the open duration list under its row. */
function focusOrder(st: ListState): HTMLButtonElement[] {
  const order: HTMLButtonElement[] = [];
  for (const def of STATUS_DEFS) {
    const row = st.items.get(def.value);
    if (row !== undefined) order.push(row);
    if (st.expanded === def.value) order.push(...(st.durationItems.get(def.value) ?? []));
  }
  return order;
}

/** ArrowRight on a timed row opens its duration list. True when the key is spent. */
function tryExpand(st: ListState, e: KeyboardEvent, rowStatus: UserStatus | undefined): boolean {
  if (e.key !== "ArrowRight" || rowStatus === undefined || !isTimedStatus(rowStatus)) return false;
  if (!st.s.enabled) return true;
  e.preventDefault();
  st.expanded = rowStatus;
  paintExpanded(st);
  st.durationItems.get(rowStatus)?.[0]?.focus();
  return true;
}

/** ArrowLeft, or Escape inside an open list, closes that list. Escape inside
 *  a list closes the list; the card's own Escape (document level) then sees it
 *  was handled. True when the key is spent. */
function tryLeave(
  st: ListState,
  e: KeyboardEvent,
  rowStatus: UserStatus | undefined,
  ownerOfDuration: UserStatus | undefined,
): boolean {
  const leaves =
    e.key === "ArrowLeft" ||
    (e.key === "Escape" && !isImeCommit(e) && ownerOfDuration !== undefined);
  if (!leaves || (ownerOfDuration === undefined && rowStatus === undefined)) return false;
  const owner = ownerOfDuration ?? rowStatus;
  if (owner === undefined || st.expanded !== owner) return true;
  e.preventDefault();
  st.expanded = null;
  paintExpanded(st);
  st.items.get(owner)?.focus();
  return true;
}

/** ArrowUp/Down/Home/End step through the rows. */
function stepFocus(e: KeyboardEvent, list: readonly HTMLButtonElement[], at: number): void {
  let next: number;
  if (e.key === "ArrowDown") next = (at + 1) % list.length;
  else if (e.key === "ArrowUp") next = (at <= 0 ? list.length : at) - 1;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = list.length - 1;
  else return;
  e.preventDefault();
  list[next]?.focus();
}

function onGroupKeydown(st: ListState, e: KeyboardEvent): void {
  const list = focusOrder(st);
  const active = document.activeElement;
  const at = list.findIndex((el) => el === active);
  const rowStatus = [...st.items].find(([, el]) => el === active)?.[0];
  const ownerOfDuration = [...st.durationItems].find(([, els]) =>
    els.some((el) => el === active),
  )?.[0];
  if (tryExpand(st, e, rowStatus)) return;
  if (tryLeave(st, e, rowStatus, ownerOfDuration)) return;
  stepFocus(e, list, at);
}

export function buildStatusList(s: CardSession): StatusListPart {
  const st: ListState = {
    s,
    items: new Map(),
    untilLines: new Map(),
    chevrons: new Map(),
    durationGroups: new Map(),
    durationItems: new Map(),
    expanded: null,
  };
  const group = createElement("div", {
    class: "spc-status-group",
    role: "menu",
    "aria-label": shellText("status.change"),
  });
  for (const def of STATUS_DEFS) group.appendChild(buildStatusRadio(st, def));
  group.addEventListener("keydown", (e: KeyboardEvent) => onGroupKeydown(st, e), {
    signal: s.signal,
  });
  paintStatusRows(st);
  paintTimerLines(st);

  return {
    element: group,
    paintStatus: () => paintStatusRows(st),
    paintTimer: () => paintTimerLines(st),
    paintEnabled(): void {
      for (const btn of st.items.values()) btn.disabled = !s.enabled;
      for (const els of st.durationItems.values()) for (const el of els) el.disabled = !s.enabled;
      for (const el of st.chevrons.values()) el.disabled = !s.enabled;
    },
    currentRow: () => st.items.get(s.status),
  };
}
