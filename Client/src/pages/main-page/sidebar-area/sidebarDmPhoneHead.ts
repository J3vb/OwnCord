/**
 * The phone's Messages drawer (features/people-home/phoneHead.ts draws it).
 * While it is mounted the sidebar carries `phone-messages`, which hides the
 * server header and the desktop DM controls the head replaces
 * (app/dm-phone.css). Phone layout only, checked each time DM mode mounts.
 */
import { createElement } from "@lib/dom";
import { Disposable } from "@lib/disposable";
import { isPhoneLayout } from "@lib/ui/bottomSheet";
import { trackCurrentView } from "../../../features/navigation/contentView";
import { handleCreateDm } from "../SidebarDmHelpers";
import type { SidebarScope } from "./sidebarScope";

const MODE_CLASS = "phone-messages";
const SEARCH_OPEN = "dm-search-open";

/** Mount the head at the top of the DM content; its teardown goes on `unsubs`. */
export function mountDmPhoneHead(sc: SidebarScope, unsubs: Array<() => void>): void {
  if (!isPhoneLayout()) return;
  const owner = new Disposable();
  const { signal } = owner;
  const wrapper = sc.sidebarWrapper;
  const head = createElement("div", { class: "dm-phone-head", "data-testid": "dm-phone-head" });
  sc.contentSlot.appendChild(head);
  wrapper.classList.add(MODE_CLASS);

  const onSearch = (): boolean => {
    const open = wrapper.classList.toggle(SEARCH_OPEN);
    const input = sc.contentSlot.querySelector<HTMLInputElement>(".dm-search");
    if (open) input?.focus();
    else if (input !== null && input.value !== "") {
      input.value = "";
      input.dispatchEvent(new Event("input"));
    }
    return open;
  };
  const people = sc.opts.destinations?.people;

  import("../../../features/people-home/phoneHead").then(
    ({ renderPhoneHead }) => {
      if (signal.aborted) return;
      renderPhoneHead(head, {
        signal,
        onSearch,
        onPeople:
          people === undefined ? undefined : (opener) => sc.opts.onOpenView?.("people", opener),
        trackPeople: (el) => trackCurrentView(el, "people"),
        onNew: () => sc.showMemberPicker(),
        onOpenUser: (id) => void handleCreateDm(id, sc.dmDeps),
      });
    },
    // Without the head the old DM controls come back: the drawer still works.
    () => wrapper.classList.remove(MODE_CLASS),
  );

  unsubs.push(() => {
    owner.destroy();
    wrapper.classList.remove(MODE_CLASS, SEARCH_OPEN);
    head.remove();
  });
}
