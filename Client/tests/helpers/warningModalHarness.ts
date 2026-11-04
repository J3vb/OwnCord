import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";

/** The accept/reject warning modals (certificate and identity mismatch). */
export interface WarningModalRig {
  readonly modal: { destroy?(): void };
  readonly onAccept: Mock;
  readonly onReject: Mock;
}

/** The options a suite supplies; the harness adds the accept/reject spies. */
export type WarningOpts<F extends (opts: never) => unknown> = Omit<
  Parameters<F>[0],
  "onAccept" | "onReject"
>;

export type MountWarningModal = () => WarningModalRig;

interface WarningModalCallbacks {
  readonly onAccept: Mock;
  readonly onReject: Mock;
}

interface MountableDialog {
  mount(container: HTMLElement): void;
  destroy?(): void;
}

function pressEscape(): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
}

/**
 * Registers the container and teardown for a warning-modal suite and returns
 * its `mountModal`. `create` receives the suite's defaults merged with the
 * test's overrides plus fresh accept/reject spies.
 */
export function useWarningModal<Opts extends object>(
  create: (opts: Opts & WarningModalCallbacks) => MountableDialog,
  defaults: Opts,
): {
  container: () => HTMLDivElement;
  mountModal: (overrides?: Partial<Opts>) => WarningModalRig;
} {
  let container!: HTMLDivElement;
  // Every modal a test mounts, destroyed in afterEach so its document keydown
  // listener does not outlive the test.
  const mounted: { destroy?(): void }[] = [];

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    for (const modal of mounted.splice(0)) modal.destroy?.();
    container.remove();
  });

  function mountModal(overrides?: Partial<Opts>): WarningModalRig {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    const modal = create({ ...defaults, ...overrides, onAccept, onReject } as Opts &
      WarningModalCallbacks);
    modal.mount(container);
    mounted.push(modal);
    return { modal, onAccept, onReject };
  }

  return { container: () => container, mountModal };
}

export function checkVisibleOverlay(mount: MountWarningModal, container: ParentNode): void {
  mount();
  const overlay = container.querySelector(".modal-overlay");
  expect(overlay).not.toBeNull();
  expect(overlay!.classList.contains("visible")).toBe(true);
}

export function checkAcceptClick(mount: MountWarningModal, container: ParentNode): void {
  const { onAccept } = mount();
  const btn = container.querySelector(".btn-danger") as HTMLButtonElement;
  expect(btn).not.toBeNull();
  btn.click();
  expect(onAccept).toHaveBeenCalledOnce();
}

export function checkRejectClick(
  mount: MountWarningModal,
  container: ParentNode,
  selector: ".btn-ghost" | ".modal-close",
): void {
  const { onReject } = mount();
  const btn = container.querySelector(selector) as HTMLButtonElement;
  expect(btn).not.toBeNull();
  btn.click();
  expect(onReject).toHaveBeenCalledOnce();
}

export function checkBackdropRejects(mount: MountWarningModal, container: ParentNode): void {
  const { onReject } = mount();
  const overlay = container.querySelector(".modal-overlay") as HTMLDivElement;
  overlay.click();
  expect(onReject).toHaveBeenCalledOnce();
}

export function checkDragSelectDoesNotReject(
  mount: MountWarningModal,
  container: ParentNode,
): void {
  const { onReject } = mount();
  const overlayEl = container.querySelector(".modal-overlay") as HTMLElement;
  overlayEl.firstElementChild!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  overlayEl.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(onReject).not.toHaveBeenCalled();
}

export function checkBodyClickDoesNotReject(mount: MountWarningModal, container: ParentNode): void {
  const { onReject } = mount();
  const modal = container.querySelector(".modal") as HTMLDivElement;
  modal.click();
  expect(onReject).not.toHaveBeenCalled();
}

export function checkDestroyRemovesModal(mount: MountWarningModal, container: ParentNode): void {
  const { modal } = mount();
  expect(container.querySelector(".modal-overlay")).not.toBeNull();
  modal.destroy?.();
  expect(container.querySelector(".modal-overlay")).toBeNull();
}

export function checkDialogSemantics(
  mount: MountWarningModal,
  container: ParentNode,
  titleId: string,
  title: string,
): void {
  mount();
  const modal = container.querySelector(".modal");
  expect(modal?.getAttribute("role")).toBe("dialog");
  expect(modal?.getAttribute("aria-modal")).toBe("true");
  expect(modal?.getAttribute("aria-labelledby")).toBe(titleId);
  expect(container.querySelector(`#${titleId}`)?.textContent).toBe(title);
}

export function checkCloseButtonLabel(mount: MountWarningModal, container: ParentNode): void {
  mount();
  const btn = container.querySelector(".modal-close");
  expect(btn?.getAttribute("aria-label")).toBe("Close");
}

export function checkEscapeRejects(mount: MountWarningModal): void {
  const { onReject } = mount();
  pressEscape();
  expect(onReject).toHaveBeenCalledOnce();
}

export function checkEscapeIgnoredAfterDestroyRejecting(mount: MountWarningModal): void {
  const { modal, onReject } = mount();
  modal.destroy?.();
  pressEscape();
  expect(onReject).not.toHaveBeenCalled();
}

export function checkFocusRestored(mount: MountWarningModal, container: Element): void {
  const outside = document.createElement("button");
  document.body.appendChild(outside);
  outside.focus();
  const { modal } = mount();
  expect(container.contains(document.activeElement)).toBe(true);
  modal.destroy?.();
  expect(document.activeElement).toBe(outside);
  outside.remove();
}

/** The test names a warning modal suite gives the checks its two modals word differently. */
export interface WarningModalSpec {
  readonly accept: string;
  readonly reject: string;
  readonly close: string;
  readonly backdrop: string;
  readonly body: string;
  readonly title: string;
  readonly certTitle: string;
  readonly titleId: string;
}

/** Registers the accept/reject, dismissal, title and accessibility tests every warning modal shares. */
export function registerWarningModalTests(
  rig: { readonly container: () => Element; readonly mountModal: MountWarningModal },
  spec: WarningModalSpec,
): void {
  const { container, mountModal } = rig;
  it(spec.accept, () => checkAcceptClick(mountModal, container()));
  it(spec.reject, () => checkRejectClick(mountModal, container(), ".btn-ghost"));
  it(spec.close, () => checkRejectClick(mountModal, container(), ".modal-close"));
  it(spec.backdrop, () => checkBackdropRejects(mountModal, container()));
  it("stays open when a drag-select ends on the backdrop", () =>
    checkDragSelectDoesNotReject(mountModal, container()));
  it(spec.body, () => checkBodyClickDoesNotReject(mountModal, container()));
  it("destroy removes the modal from the DOM", () =>
    checkDestroyRemovesModal(mountModal, container()));
  it(`displays the title '${spec.title}'`, () => {
    mountModal();
    const title = container().querySelector(".modal-header h3");
    expect(title?.textContent).toBe(spec.title);
  });
  it(`displays the cert title '${spec.certTitle}'`, () => {
    mountModal();
    const title = container().querySelector(".cert-title");
    expect(title?.textContent).toBe(spec.certTitle);
  });
  it("carries dialog semantics labelled by the h3 title", () =>
    checkDialogSemantics(mountModal, container(), spec.titleId, spec.title));
  it("gives the icon-only close button an accessible name", () =>
    checkCloseButtonLabel(mountModal, container()));
  it("calls onReject when Escape is pressed", () => checkEscapeRejects(mountModal));
  it("does not call onReject on Escape after destroy", () =>
    checkEscapeIgnoredAfterDestroyRejecting(mountModal));
  it("moves focus inside the modal on mount and restores it on destroy", () =>
    checkFocusRestored(mountModal, container()));
}
