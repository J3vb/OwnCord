import { afterEach, describe, expect, it, vi } from "vitest";
import { showWhatsNewDialog } from "../../src/features/whats-new/WhatsNewDialog";
import { REPO_URL } from "../../src/features/whats-new/changelog";

const opened: Array<{ destroy(): void }> = [];

function open(onOpenHistory = vi.fn(), onClosed = vi.fn(), opener?: HTMLElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  if (opener !== undefined) {
    document.body.appendChild(opener);
    opener.focus();
  }
  const dialog = showWhatsNewDialog(
    container,
    { version: "1.2.3", body: "- First\n- Second" },
    onOpenHistory,
    onClosed,
  );
  opened.push(dialog);
  const overlay = container.querySelector<HTMLElement>("[data-testid=whats-new-dialog]")!;
  return { container, dialog, overlay, onOpenHistory, onClosed };
}

afterEach(() => {
  for (const dialog of opened.splice(0)) dialog.destroy();
  document.body.replaceChildren();
});

describe("What's new dialog structure", () => {
  it("is a labelled modal dialog with a header, a scrollable body and a footer", () => {
    const { overlay } = open();
    expect(overlay.className).toBe("modal-overlay visible whats-new-overlay");
    const modal = overlay.querySelector<HTMLElement>(".modal.whats-new-modal")!;
    expect(modal.getAttribute("role")).toBe("dialog");
    expect(modal.getAttribute("aria-modal")).toBe("true");
    expect(modal.getAttribute("aria-labelledby")).toBe("whats-new-title");

    const header = modal.querySelector<HTMLElement>(":scope > .modal-header")!;
    expect(header.querySelector(".whats-new-eyebrow")?.textContent).toBe("Updated to 1.2.3");
    const title = header.querySelector("h3")!;
    expect(title.id).toBe("whats-new-title");
    expect(title.textContent).toBe("What's new in OwnCord");

    const body = modal.querySelector<HTMLElement>(":scope > .modal-body.whats-new-body")!;
    expect(body.getAttribute("tabindex")).toBe("0");
    expect(body.getAttribute("role")).toBe("region");
    expect(body.textContent).toContain("First");
    expect(body.textContent).toContain("Second");

    expect(modal.querySelector(":scope > .modal-footer.whats-new-footer")).not.toBeNull();
  });

  it("labels its controls and links the repository safely", () => {
    const { overlay } = open();
    const close = overlay.querySelector<HTMLButtonElement>(".modal-header button")!;
    expect(close.className).toBe("modal-close");
    expect(close.type).toBe("button");
    expect(close.getAttribute("aria-label")).toBe("Close");

    const repo = overlay.querySelector<HTMLAnchorElement>("a")!;
    expect(repo.className).toBe("whats-new-repo");
    expect(repo.getAttribute("href")).toBe(REPO_URL);
    expect(repo.target).toBe("_blank");
    expect(repo.rel).toBe("noopener noreferrer");
    expect(repo.textContent).toBe("OwnCord on GitHub ");

    const buttons = overlay.querySelectorAll<HTMLButtonElement>(".whats-new-actions button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.className).toBe("ac-btn secondary");
    expect(buttons[0]!.type).toBe("button");
    expect(buttons[0]!.textContent).toBe("Version history");
    expect(buttons[1]!.className).toBe("ac-btn");
    expect(buttons[1]!.type).toBe("button");
    expect(buttons[1]!.textContent).toBe("Got it");
  });
});

describe("What's new dialog behaviour", () => {
  it("takes focus when it opens and gives it back when it closes", () => {
    const opener = document.createElement("button");
    const { overlay, dialog } = open(undefined, undefined, opener);
    expect(document.activeElement).toBe(overlay.querySelector(".modal-close"));
    dialog.destroy();
    expect(document.activeElement).toBe(opener);
  });

  it("keeps Tab inside the dialog, wrapping from the last control to the first", () => {
    const { overlay } = open();
    const modal = overlay.querySelector<HTMLElement>(".modal")!;
    const done = overlay.querySelector<HTMLButtonElement>(
      ".whats-new-actions .ac-btn:not(.secondary)",
    )!;
    done.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    done.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(overlay.querySelector(".modal-close"));

    const back = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    modal.querySelector(".modal-close")!.dispatchEvent(back);
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(done);
  });

  it("closes from the close button and the Got it button, once", () => {
    const first = open();
    first.overlay.querySelector<HTMLElement>(".modal-close")!.click();
    expect(first.onClosed).toHaveBeenCalledTimes(1);
    expect(first.overlay.isConnected).toBe(false);
    first.dialog.destroy();
    expect(first.onClosed).toHaveBeenCalledTimes(1);

    const second = open();
    second.overlay
      .querySelector<HTMLElement>(".whats-new-actions .ac-btn:not(.secondary)")!
      .click();
    expect(second.onClosed).toHaveBeenCalledTimes(1);
    second.dialog.destroy();
    second.dialog.destroy();
    expect(second.onClosed).toHaveBeenCalledTimes(1);
  });

  it("opens the history once, and not again from a click after it has closed", () => {
    const { overlay, onOpenHistory, onClosed } = open();
    const history = overlay.querySelector<HTMLElement>(".whats-new-actions .secondary")!;
    history.click();
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(onOpenHistory).toHaveBeenCalledTimes(1);
    history.click();
    expect(onOpenHistory).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape only, and not while an IME composition is committing", () => {
    const { overlay, onClosed } = open();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(onClosed).not.toHaveBeenCalled();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true }));
    expect(onClosed).not.toHaveBeenCalled();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 229 }));
    expect(onClosed).not.toHaveBeenCalled();
    expect(overlay.isConnected).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(overlay.isConnected).toBe(false);
  });
});
