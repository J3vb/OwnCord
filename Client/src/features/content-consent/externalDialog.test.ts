// The external-content consent dialog's structure: what each part is called,
// how it is labelled for assistive tech and which button chooses what.
import { afterEach, describe, expect, it } from "vitest";
import { askExternalConsent } from "./externalDialog";

afterEach(() => {
  // Cancel closes the dialog, which releases its document listeners.
  document.querySelector<HTMLButtonElement>(".btn-modal-cancel")?.click();
  document.body.replaceChildren();
});

const overlay = (): HTMLElement =>
  document.querySelector<HTMLElement>('[data-testid="external-consent-dialog"]')!;
const buttons = (): HTMLButtonElement[] => [...overlay().querySelectorAll("button")];
const byLabel = (label: string): HTMLButtonElement =>
  buttons().find((b) => b.textContent === label)!;

describe("external consent dialog", () => {
  it("lays out a header, a warning body and a footer with the three choices", () => {
    void askExternalConsent();
    const modal = overlay().querySelector<HTMLElement>(".modal")!;
    const header = modal.querySelector(".modal-header")!;
    const title = header.querySelector("h3")!;
    expect(title.id).toBe("external-consent-title");
    expect(title.textContent).toBe("Load external content on this server?");
    const body = modal.querySelector(".modal-body")!;
    const text = body.querySelector("p")!;
    expect(text.className).toBe("modal-danger-text");
    expect(text.id).toBe("external-consent-body");
    expect(text.textContent).toContain("can see your IP address");
    const footer = modal.querySelector(".modal-footer")!;
    expect([...footer.children].map((b) => [b.className, b.textContent])).toEqual([
      ["btn-modal-cancel", "Cancel"],
      ["btn-ghost", "Ask each time"],
      ["btn-modal-save", "Load automatically on this server"],
    ]);
    for (const b of buttons()) expect(b.type).toBe("button");
  });

  it("is named by its title and described by its body", () => {
    void askExternalConsent();
    const modal = overlay().querySelector<HTMLElement>(".modal")!;
    expect(modal.getAttribute("aria-labelledby")).toBe("external-consent-title");
    expect(modal.getAttribute("aria-describedby")).toBe("external-consent-body");
    expect(document.getElementById("external-consent-title")?.textContent).toBe(
      "Load external content on this server?",
    );
    expect(document.getElementById("external-consent-body")).not.toBeNull();
  });

  it("resolves with the button that was pressed", async () => {
    const ask = askExternalConsent();
    byLabel("Ask each time").click();
    await expect(ask).resolves.toBe("ask");
    const auto = askExternalConsent();
    byLabel("Load automatically on this server").click();
    await expect(auto).resolves.toBe("auto");
    const cancel = askExternalConsent();
    byLabel("Cancel").click();
    await expect(cancel).resolves.toBeNull();
  });
});
