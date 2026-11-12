/**
 * The phone's Messages drawer (features/people-home/phoneHead.ts draws it).
 * While it is mounted the sidebar carries `phone-messages`, which hides the
 * server header and the desktop DM controls the head replaces
 * (app/dm-phone.css). Phone layout only.
 */
import { createElement } from "@lib/dom";
import { Disposable } from "@lib/disposable";
import { isPhoneLayout, onPhoneLayoutChange } from "@lib/ui/bottomSheet";
import { trackCurrentView } from "../navigation/contentView";
import { handleCreateDm } from "./SidebarDmHelpers";
import type { SidebarScope } from "../../pages/main-page/sidebar-area/sidebarScope";

const MODE_CLASS = "phone-messages";
const SEARCH_OPEN = "dm-search-open";

/** Mount the head at the top of the DM content; its teardown goes on `unsubs`. */
export function mountDmPhoneHead(sc: SidebarScope, unsubs: Array<() => void>): void {
  const owner = new Disposable();
  const { signal } = owner;
  unsubs.push(() => owner.destroy());
  // A rotation or resize across the phone breakpoint redraws DM mode, so the
  // head comes or goes with the layout.
  onPhoneLayoutChange(() => sc.mountSidebarContent("dms"), signal);
  if (!isPhoneLayout()) return;
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

  import("../people-home/phoneHead").then(
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
    () => {
      wrapper.classList.remove(MODE_CLASS);
      head.remove();
    },
  );

  unsubs.push(() => {
    wrapper.classList.remove(MODE_CLASS, SEARCH_OPEN);
    head.remove();
  });
}
