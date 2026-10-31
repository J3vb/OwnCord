import { expect, vi, type Mock } from "vitest";

/** The spies a dialog probe hands to a suite's own `makeModal`. */
export interface DialogSpies {
  readonly action: Mock;
  readonly onClose: Mock;
}

export interface DialogHandle {
  destroy?(): void;
}

/** Builds and mounts the modal under test with the given confirm/close spies. */
export type MakeDialog = (spies: DialogSpies) => DialogHandle;

function spies(): DialogSpies {
  return { action: vi.fn(async () => {}), onClose: vi.fn() };
}

function pressEscape(init: KeyboardEventInit = {}): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", ...init }));
}

export function checkEscapeCancels(make: MakeDialog): void {
  const s = spies();
  const modal = make(s);

  pressEscape();

  expect(s.onClose).toHaveBeenCalledTimes(1);
  expect(s.action).not.toHaveBeenCalled();
  modal.destroy?.();
}

export function checkEscapeKeepsImeCandidate(make: MakeDialog): void {
  const s = spies();
  const modal = make(s);

  pressEscape({ isComposing: true, bubbles: true });
  expect(s.onClose).not.toHaveBeenCalled();
  pressEscape();
  expect(s.onClose).toHaveBeenCalledTimes(1);
  modal.destroy?.();
}

export function checkEscapeIgnoredAfterDestroy(make: MakeDialog): void {
  const s = spies();
  const modal = make(s);
  modal.destroy?.();

  pressEscape();

  expect(s.onClose).not.toHaveBeenCalled();
}

export function checkClickCloses(make: MakeDialog, container: ParentNode, selector: string): void {
  const s = spies();
  const modal = make(s);
  (container.querySelector(selector) as HTMLElement).click();
  expect(s.onClose).toHaveBeenCalled();
  modal.destroy?.();
}

export function checkBackdropClickCloses(
  make: MakeDialog,
  container: ParentNode,
  overlaySelector: string,
): void {
  const s = spies();
  const modal = make(s);

  const overlay = container.querySelector(overlaySelector) as HTMLDivElement;
  overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));

  expect(s.onClose).toHaveBeenCalled();
  modal.destroy?.();
}

export function checkDragSelectKeepsOpen(
  make: MakeDialog,
  container: ParentNode,
  overlaySelector: string,
): void {
  const s = spies();
  const modal = make(s);
  const overlayEl = container.querySelector(overlaySelector) as HTMLElement;
  overlayEl.firstElementChild!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  overlayEl.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(s.onClose).not.toHaveBeenCalled();
  modal.destroy?.();
}

export function checkModalSemantics(
  make: MakeDialog,
  container: ParentNode,
  titleId: string,
  title: string,
): void {
  const modal = make(spies());
  const dialog = container.querySelector(".modal") as HTMLElement;
  expect(dialog.getAttribute("role")).toBe("dialog");
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(dialog.getAttribute("aria-labelledby")).toBe(titleId);
  expect(container.querySelector(`#${titleId}`)?.textContent).toBe(title);
  modal.destroy?.();
}

export function checkCloseButtonLabelled(make: MakeDialog, container: ParentNode): void {
  const modal = make(spies());
  const closeBtn = container.querySelector(".modal-close") as HTMLButtonElement;
  expect(closeBtn.getAttribute("aria-label")).toBe("Close");
  modal.destroy?.();
}

export function checkFocusMovesInAndRestores(
  make: MakeDialog,
  container: HTMLElement,
  focusedSelector: string,
): void {
  const trigger = document.createElement("button");
  container.appendChild(trigger);
  trigger.focus();

  const modal = make(spies());
  const focused = container.querySelector(focusedSelector) as HTMLElement;
  expect(document.activeElement).toBe(focused);

  modal.destroy?.();
  expect(document.activeElement).toBe(trigger);
}

export function checkOverlayRemovedOnDestroy(
  make: MakeDialog,
  container: ParentNode,
  overlaySelector: string,
): void {
  const modal = make(spies());
  expect(container.querySelector(overlaySelector)).not.toBeNull();
  modal.destroy?.();
  expect(container.querySelector(overlaySelector)).toBeNull();
}
