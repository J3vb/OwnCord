import { afterEach, describe, expect, it, vi } from "vitest";
import { closeBottomSheet } from "../../lib/ui/bottomSheet";
import { createChatHeaderOverflow, type ChatHeaderOverflow } from "./chatHeaderOverflow";

const SHEET = '[data-testid="chat-header-more-sheet"]';
const sheet = (): HTMLElement | null => document.querySelector<HTMLElement>(SHEET);
const labels = (): string[] =>
  [...(sheet()?.querySelectorAll(".menu-sheet-label") ?? [])].map((el) => el.textContent ?? "");

function toolButton(testId: string, label: string, pressed?: boolean): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.dataset["testid"] = testId;
  btn.setAttribute("aria-label", label);
  if (pressed !== undefined) btn.setAttribute("aria-pressed", String(pressed));
  return btn;
}

describe("chat header More button", () => {
  let overflow: ChatHeaderOverflow | null = null;

  afterEach(() => {
    closeBottomSheet();
    overflow?.destroy();
    overflow = null;
    document.body.replaceChildren();
  });

  function mount(buttons: HTMLButtonElement[]): HTMLButtonElement {
    overflow = createChatHeaderOverflow(buttons);
    document.body.appendChild(overflow.button);
    return overflow.button;
  }

  it("lists only the buttons the header shows, in order", () => {
    const profile = toolButton("dm-profile-btn", "Show User Profile", false);
    const members = toolButton("dm-members-btn", "Show Member List", false);
    members.style.display = "none";
    const media = toolButton("media-btn", "Media and files");
    media.hidden = true;
    const pins = toolButton("pin-btn", "Pins");
    const more = mount([profile, members, pins, media]);

    more.click();

    expect(labels()).toEqual(["Show User Profile", "Pins"]);
    expect(more.getAttribute("aria-expanded")).toBe("true");
  });

  it("shows a toggle's pressed state as a checked row", () => {
    const profile = toolButton("dm-profile-btn", "Show User Profile", true);
    const pins = toolButton("pin-btn", "Pins");
    mount([profile, pins]).click();

    const profileRow = sheet()!.querySelector('[data-testid="chat-header-more-dm-profile-btn"]')!;
    const pinsRow = sheet()!.querySelector('[data-testid="chat-header-more-pin-btn"]')!;
    expect(profileRow.getAttribute("aria-checked")).toBe("true");
    expect(pinsRow.hasAttribute("aria-checked")).toBe(false);
  });

  it("a row clicks its button and closes the sheet", () => {
    const pins = toolButton("pin-btn", "Pins");
    const onPins = vi.fn();
    pins.addEventListener("click", onPins);
    const more = mount([pins]);
    more.click();

    sheet()!.querySelector<HTMLElement>('[data-testid="chat-header-more-pin-btn"]')!.click();

    expect(onPins).toHaveBeenCalledTimes(1);
    expect(sheet()).toBeNull();
    expect(more.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens nothing when no button is showing, and nothing after destroy", () => {
    const pins = toolButton("pin-btn", "Pins");
    pins.hidden = true;
    const more = mount([pins]);
    more.click();
    expect(sheet()).toBeNull();

    pins.hidden = false;
    overflow!.destroy();
    more.click();
    expect(sheet()).toBeNull();
  });
});
