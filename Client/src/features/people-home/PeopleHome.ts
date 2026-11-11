/**
 * The People view: DM mode's home. Who is on the server (Online or All, with
 * a search), a Message button per person, and an Active now column of people
 * playing a game or sitting in voice.
 *
 * Rows are redrawn from the stores whenever the roster, presence, voice or
 * blocks change. The tabs and search box are built once, so typing and focus
 * survive an update; focus on a row's Message button moves to the same
 * person's new button.
 */

import { appendChildren, createElement, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { channelsStore } from "@stores/channels.store";
import { membersStore } from "@stores/members.store";
import { voiceStore } from "@stores/voice.store";
import { peopleHomeText as t } from "../../i18n/peopleHome";
import type { FeatureViewContext } from "../navigation/destinations";
import { activeNow, peopleRows, type ActiveModel, type PeopleTab, type PersonModel } from "./model";
import { peopleScope, personAvatar, watchPeople } from "./shared";

function textBlock(person: PersonModel, lines: readonly string[]): HTMLElement {
  const wrap = createElement("div", { class: "mi-text" });
  wrap.appendChild(createElement("span", { class: "mi-name" }, person.name));
  lines.forEach((line, i) => {
    const icon = i === 0 ? person.lineIcon : null;
    if (icon === null) {
      wrap.appendChild(createElement("span", { class: "mi-custom-status" }, line));
      return;
    }
    const el = createElement("span", { class: "mi-activity" });
    const svg = createIcon(icon, 12);
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("mi-activity-icon");
    appendChildren(el, svg, createElement("span", { class: "mi-activity-text" }, line));
    wrap.appendChild(el);
  });
  return wrap;
}

export function renderPeopleHome(root: HTMLElement, ctx: FeatureViewContext): void {
  const { signal } = ctx;
  let tab: PeopleTab = "online";
  let query = "";

  const main = createElement("section", { class: "people-main" });
  const tabs = createElement("div", {
    class: "people-tabs",
    role: "group",
    "aria-label": t("tabs.label"),
  });
  const tabButtons = new Map<PeopleTab, HTMLButtonElement>();
  for (const id of ["online", "all"] as const) {
    const btn = createElement(
      "button",
      { type: "button", class: "people-tab", "data-testid": `people-tab-${id}` },
      t(id === "online" ? "tab.online" : "tab.all"),
    );
    btn.addEventListener(
      "click",
      () => {
        if (tab === id) return;
        tab = id;
        render();
      },
      { signal },
    );
    tabButtons.set(id, btn);
    tabs.appendChild(btn);
  }

  const search = createElement("input", {
    type: "search",
    class: "dm-search people-search",
    placeholder: t("search"),
    "aria-label": t("search"),
    "data-testid": "people-search",
  });
  search.addEventListener(
    "input",
    () => {
      query = search.value;
      render();
    },
    { signal },
  );

  const count = createElement("h3", { class: "member-role-group", "data-testid": "people-count" });
  const list = createElement("ul", {
    class: "people-list",
    "aria-label": t("list.label"),
    "data-testid": "people-list",
  });
  const empty = createElement("p", {
    class: "member-list-empty-text people-empty",
    "data-testid": "people-empty",
  });
  appendChildren(main, tabs, search, count, list, empty);

  const activeTitleId = "people-active-title";
  const active = createElement("aside", {
    class: "people-active",
    "aria-labelledby": activeTitleId,
    "data-testid": "people-active",
  });
  const activeList = createElement("ul", { class: "people-list" });
  const activeEmpty = createElement(
    "p",
    { class: "member-list-empty-text people-empty" },
    t("active.empty"),
  );
  appendChildren(
    active,
    createElement("h3", { class: "people-active-title", id: activeTitleId }, t("active.title")),
    activeList,
    activeEmpty,
  );
  appendChildren(root, main, active);

  function personRow(person: PersonModel): HTMLLIElement {
    const li = createElement("li", {
      class: "member-item people-row",
      "data-testid": `people-row-${person.id}`,
    });
    const msg = createElement("button", {
      type: "button",
      class: "people-msg",
      "aria-label": t("message", { name: person.name }),
      title: t("message", { name: person.name }),
      "data-testid": `people-message-${person.id}`,
      "data-user-id": String(person.id),
    });
    msg.appendChild(createIcon("message-square", 16));
    msg.addEventListener("click", (e) => {
      e.stopPropagation();
      ctx.messageUser?.(person.id);
    });
    // The whole row opens the DM, as on Discord; the button is its keyboard stop.
    li.addEventListener("click", () => ctx.messageUser?.(person.id));
    appendChildren(li, personAvatar(person), textBlock(person, [person.line]), msg);
    return li;
  }

  function activeCard(person: ActiveModel): HTMLLIElement {
    const li = createElement("li", {
      class: "member-item people-card",
      role: "button",
      tabindex: "0",
      "aria-label": t("message", { name: person.name }),
      "data-testid": `people-active-${person.id}`,
      "data-active-id": String(person.id),
    });
    li.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      ctx.messageUser?.(person.id);
    });
    const lines: string[] = [];
    if (person.game !== null) lines.push(person.game);
    if (person.voiceChannel !== null)
      lines.push(t("active.voice", { channel: person.voiceChannel }));
    const shown: PersonModel = { ...person, lineIcon: person.game !== null ? "gamepad-2" : null };
    li.addEventListener("click", () => ctx.messageUser?.(person.id));
    appendChildren(li, personAvatar(shown), textBlock(shown, lines));
    return li;
  }

  function focusedIds(): { focusedId: string | undefined; focusedCard: string | undefined } {
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return {
      focusedId: focused !== null && list.contains(focused) ? focused.dataset["userId"] : undefined,
      focusedCard:
        focused !== null && activeList.contains(focused) ? focused.dataset["activeId"] : undefined,
    };
  }

  function emptyText(): string {
    if (query.trim() !== "") return t("empty.search", { query: query.trim() });
    return t(tab === "online" ? "empty.online" : "empty.all");
  }

  function paintPeople(
    members: ReturnType<typeof membersStore.getState>["members"],
    sc: ReturnType<typeof peopleScope>,
    focusedId: string | undefined,
  ): void {
    const rows = peopleRows(members.values(), sc, tab, query);
    setText(
      count,
      t(tab === "online" ? "count.online" : "count.all", { count: String(rows.length) }),
    );
    list.replaceChildren(...rows.map(personRow));
    empty.hidden = rows.length > 0;
    if (rows.length === 0) setText(empty, emptyText());
    if (focusedId !== undefined) {
      // The person left this tab: the search keeps focus inside the view.
      (list.querySelector<HTMLElement>(`[data-user-id="${focusedId}"]`) ?? search).focus();
    }
  }

  function paintActive(
    members: ReturnType<typeof membersStore.getState>["members"],
    sc: ReturnType<typeof peopleScope>,
    focusedCard: string | undefined,
  ): void {
    const cards = activeNow(
      members,
      voiceStore.getState().voiceUsers,
      channelsStore.getState().channels,
      sc,
    );
    activeList.replaceChildren(...cards.map(activeCard));
    activeEmpty.hidden = cards.length > 0;
    if (focusedCard !== undefined) {
      (
        activeList.querySelector<HTMLElement>(`[data-active-id="${focusedCard}"]`) ??
        activeList.querySelector<HTMLElement>("[data-active-id]") ??
        search
      ).focus();
    }
  }

  function render(): void {
    if (signal.aborted) return;
    const { focusedId, focusedCard } = focusedIds();

    for (const [id, btn] of tabButtons) btn.setAttribute("aria-pressed", String(id === tab));

    const members = membersStore.getState().members;
    const sc = peopleScope();
    paintPeople(members, sc, focusedId);
    paintActive(members, sc, focusedCard);
  }

  watchPeople(render, signal);
  render();
}
