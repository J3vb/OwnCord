import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installOverlayBack } from "../../src/pages/main-page/overlayBack";
import { closeSettings, openSettings, setActiveView, uiStore } from "@stores/ui.store";
import { createModal } from "@lib/ui/modalFactory";
import { closeBottomSheet, openBottomSheet } from "@lib/ui/bottomSheet";
import { dismissTopDialog, displayedDialogs } from "@lib/ui/dialogOpen";

let phone = true;
let ac: AbortController;
let root: HTMLDivElement;
let closeView: ReturnType<typeof vi.fn>;

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}
async function pressBack(): Promise<void> {
  history.back();
  await settle();
}
const guarded = (): boolean => {
  const state: unknown = history.state;
  return typeof state === "object" && state !== null && "owncordBack" in state;
};

function install(): void {
  installOverlayBack({ signal: ac.signal, root, closeView: closeView as () => void });
}

beforeEach(() => {
  phone = true;
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: phone })),
  );
  closeSettings();
  setActiveView(null);
  uiStore.flush();
  ac = new AbortController();
  root = document.createElement("div");
  document.body.appendChild(root);
  closeView = vi.fn(() => setActiveView(null));
});

afterEach(async () => {
  closeBottomSheet();
  ac.abort();
  closeSettings();
  setActiveView(null);
  await settle();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("Back closes Settings", () => {
  it("claims Back while Settings is open and closes it", async () => {
    install();
    expect(guarded()).toBe(false);
    openSettings();
    uiStore.flush();
    expect(guarded()).toBe(true);
    await pressBack();
    expect(uiStore.getState().settingsOpen).toBe(false);
    expect(guarded()).toBe(false);
  });

  it("gives Back up when Settings closes another way, with one pop", async () => {
    install();
    openSettings();
    uiStore.flush();
    const back = vi.spyOn(history, "back");
    closeSettings();
    uiStore.flush();
    await settle();
    expect(back).toHaveBeenCalledTimes(1);
    expect(guarded()).toBe(false);
  });

  it("is already claiming when installed with Settings open", () => {
    openSettings();
    uiStore.flush();
    install();
    expect(guarded()).toBe(true);
  });
});

describe("Back closes a content view", () => {
  it("runs the view's own close, which takes its back path", async () => {
    install();
    setActiveView("requests");
    uiStore.flush();
    expect(guarded()).toBe(true);
    await pressBack();
    expect(closeView).toHaveBeenCalledTimes(1);
    expect(uiStore.getState().activeView).toBeNull();
    expect(guarded()).toBe(false);
  });
});

describe("Back closes a dialog", () => {
  it("claims Back while a dialog is on screen and presses Escape on it", async () => {
    install();
    const onClose = vi.fn();
    const modal = createModal({ content: document.createElement("div"), onClose });
    await settle();
    expect(guarded()).toBe(true);
    await pressBack();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(displayedDialogs()).toHaveLength(0);
    expect(guarded()).toBe(false);
    modal.destroy();
  });

  it("keeps Back for a dialog that stays open when it gets Escape", async () => {
    install();
    const onEscape = vi.fn();
    const modal = createModal({ content: document.createElement("div"), onEscape });
    await settle();
    await pressBack();
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(displayedDialogs().length).toBeGreaterThan(0);
    // Still ours: the next Back reaches it again.
    expect(guarded()).toBe(true);
    await pressBack();
    expect(onEscape).toHaveBeenCalledTimes(2);
    modal.destroy();
  });

  it("gives Back up when the dialog closes another way, with one pop", async () => {
    install();
    const modal = createModal({ content: document.createElement("div") });
    await settle();
    const back = vi.spyOn(history, "back");
    modal.destroy();
    await settle();
    expect(back).toHaveBeenCalledTimes(1);
    expect(guarded()).toBe(false);
  });

  it("claims for a dialog added to the page root too", async () => {
    install();
    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    root.appendChild(dialog);
    await settle();
    expect(guarded()).toBe(true);
  });

  it("leaves a sheet to its own claim, and does not push a second entry", async () => {
    install();
    const push = vi.spyOn(history, "pushState");
    const content = document.createElement("div");
    content.innerHTML = "<button>One</button>";
    const sheet = openBottomSheet({ label: "Sheet", content });
    await settle();
    expect(push).toHaveBeenCalledTimes(1);
    await pressBack();
    expect(sheet.signal.aborted).toBe(true);
    expect(guarded()).toBe(false);
  });

  it("the settings panel's own dialog semantics do not count as a dialog", async () => {
    install();
    const overlay = document.createElement("div");
    overlay.className = "settings-overlay";
    overlay.innerHTML = '<div aria-modal="true"></div>';
    document.body.appendChild(overlay);
    await settle();
    expect(guarded()).toBe(false);
  });
});

describe("the order Back closes things in", () => {
  it("closes the dialog opened over Settings, then Settings", async () => {
    install();
    openSettings();
    uiStore.flush();
    const onClose = vi.fn();
    const modal = createModal({ content: document.createElement("div"), onClose });
    await settle();
    await pressBack();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(uiStore.getState().settingsOpen).toBe(true);
    expect(guarded()).toBe(true);
    await pressBack();
    expect(uiStore.getState().settingsOpen).toBe(false);
    expect(guarded()).toBe(false);
    modal.destroy();
  });
});

describe("outside the phone layout", () => {
  it("claims nothing", async () => {
    phone = false;
    install();
    openSettings();
    uiStore.flush();
    setActiveView("moderation");
    uiStore.flush();
    const modal = createModal({ content: document.createElement("div") });
    await settle();
    expect(guarded()).toBe(false);
    modal.destroy();
  });

  it("picks up the phone layout on resize", async () => {
    phone = false;
    install();
    openSettings();
    uiStore.flush();
    expect(guarded()).toBe(false);
    phone = true;
    window.dispatchEvent(new Event("resize"));
    expect(guarded()).toBe(true);
    phone = false;
    window.dispatchEvent(new Event("resize"));
    await settle();
    expect(guarded()).toBe(false);
  });

  it("lets everything go when its owner aborts", async () => {
    install();
    openSettings();
    uiStore.flush();
    expect(guarded()).toBe(true);
    ac.abort();
    await settle();
    expect(guarded()).toBe(false);
    // And it no longer watches: a new dialog claims nothing.
    const modal = createModal({ content: document.createElement("div") });
    await settle();
    expect(guarded()).toBe(false);
    modal.destroy();
  });
});

describe("dismissTopDialog", () => {
  it("presses Escape from the focused control inside the top dialog", () => {
    const first = document.createElement("div");
    first.setAttribute("aria-modal", "true");
    const second = document.createElement("div");
    second.setAttribute("aria-modal", "true");
    const field = document.createElement("input");
    second.appendChild(field);
    document.body.append(first, second);
    field.focus();
    const keys: Array<{ target: EventTarget | null; key: string }> = [];
    document.addEventListener("keydown", (e) => keys.push({ target: e.target, key: e.key }), {
      once: true,
    });
    dismissTopDialog();
    expect(keys).toEqual([{ target: field, key: "Escape" }]);
  });

  it("falls back to the dialog itself when focus is elsewhere, and skips excluded surfaces", () => {
    const skipped = document.createElement("div");
    skipped.className = "skip";
    skipped.innerHTML = '<div aria-modal="true" id="skipped"></div>';
    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    dialog.id = "dialog";
    document.body.append(dialog, skipped);
    const targets: Array<EventTarget | null> = [];
    document.addEventListener("keydown", (e) => targets.push(e.target), { once: true });
    dismissTopDialog(".skip");
    expect((targets[0] as HTMLElement).id).toBe("dialog");
    expect(displayedDialogs(".skip")).toHaveLength(1);
  });

  it("does nothing with no dialog", () => {
    const seen = vi.fn();
    document.addEventListener("keydown", seen, { once: true });
    dismissTopDialog();
    expect(seen).not.toHaveBeenCalled();
    document.dispatchEvent(new KeyboardEvent("keydown"));
  });
});
