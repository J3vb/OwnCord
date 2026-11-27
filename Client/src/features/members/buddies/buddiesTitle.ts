/**
 * Buddies' title strip: "Buddies" and the online count out of all members.
 * The count is patched when the roster changes, for as long as `signal` lives.
 */

import { createElement, setText } from "@lib/dom";
import { select } from "@lib/ui/select";
import { getOnlineMembers, membersStore } from "@stores/members.store";
import { buddiesText } from "../../../i18n/buddies";

export function createBuddiesTitle(signal: AbortSignal): HTMLElement {
  const title = createElement("div", { class: "buddies-title", "data-testid": "buddies-title" });
  const heading = createElement(
    "h2",
    { class: "buddies-title-text", tabindex: "-1" },
    buddiesText("title"),
  );
  const count = createElement("span", {
    class: "buddies-count",
    "data-testid": "buddies-count",
    "aria-hidden": "true",
  });
  const label = createElement("span", { class: "sr-only" });
  title.append(heading, count, label);

  const paint = (): void => {
    const counts = {
      online: getOnlineMembers().length,
      total: membersStore.getState().members.size,
    };
    const shown = buddiesText("count", counts);
    if (count.textContent !== shown) setText(count, shown);
    const spoken = buddiesText("countLabel", counts);
    if (label.textContent !== spoken) setText(label, spoken);
  };
  paint();
  select([membersStore], (state) => state.members, paint, { signal });
  return title;
}
