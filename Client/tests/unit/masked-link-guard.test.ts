import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guardMaskedLink } from "@components/MaskedLinkGuard";
import { isDomainTrusted, trustDomain } from "@lib/net/trustedDomains";

const q = <T extends HTMLElement>(testId: string): T | null =>
  document.querySelector<T>(`[data-testid="${testId}"]`);

describe("guardMaskedLink", () => {
  let open: ReturnType<typeof vi.fn<(url: string) => void>>;

  beforeEach(() => {
    localStorage.clear();
    open = vi.fn<(url: string) => void>();
  });

  afterEach(() => {
    // Close through the modal's own Escape path so its document listener goes too.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    q("masked-link-dialog")?.remove();
    localStorage.clear();
  });

  it("shows the full URL and the domain in the trust checkbox, opening nothing yet", () => {
    guardMaskedLink("https://evil.example/login?x=1", open);

    expect(q("masked-link-url")?.textContent).toBe("https://evil.example/login?x=1");
    expect(document.querySelector(".modal h3")?.textContent).toBe("Leaving OwnCord");
    expect(q("masked-link-trust")?.parentElement?.textContent).toBe(
      "Trust evil.example links from now on",
    );
    expect(q("masked-link-go")?.textContent).toBe("Go to site");
    expect(open).not.toHaveBeenCalled();
  });

  it("starts focus on Cancel", () => {
    guardMaskedLink("https://evil.example/", open);
    expect(document.activeElement).toBe(q("masked-link-cancel"));
  });

  it("Go to site opens the link and does not trust the domain unless ticked", () => {
    guardMaskedLink("https://evil.example/", open);
    q<HTMLButtonElement>("masked-link-go")!.click();

    expect(open).toHaveBeenCalledExactlyOnceWith("https://evil.example/");
    expect(isDomainTrusted("evil.example")).toBe(false);
    expect(q("masked-link-dialog")).toBeNull();
  });

  it("Go to site with the checkbox ticked trusts the domain", () => {
    guardMaskedLink("https://Good.Example/x", open);
    q<HTMLInputElement>("masked-link-trust")!.click();
    q<HTMLButtonElement>("masked-link-go")!.click();

    expect(open).toHaveBeenCalledExactlyOnceWith("https://Good.Example/x");
    expect(isDomainTrusted("good.example")).toBe(true);
  });

  it("Cancel opens nothing and trusts nothing, even with the box ticked", () => {
    guardMaskedLink("https://evil.example/", open);
    q<HTMLInputElement>("masked-link-trust")!.click();
    q<HTMLButtonElement>("masked-link-cancel")!.click();

    expect(open).not.toHaveBeenCalled();
    expect(isDomainTrusted("evil.example")).toBe(false);
    expect(q("masked-link-dialog")).toBeNull();
  });

  it("Escape cancels", () => {
    guardMaskedLink("https://evil.example/", open);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(open).not.toHaveBeenCalled();
    expect(q("masked-link-dialog")).toBeNull();
  });

  it("Enter on the initial Cancel opens nothing (native activation of Cancel)", () => {
    guardMaskedLink("https://evil.example/", open);
    const cancel = q<HTMLButtonElement>("masked-link-cancel")!;
    const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    cancel.dispatchEvent(ev);

    // No custom handling: the browser's own Enter-click does the cancelling.
    expect(ev.defaultPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("ignores auto-repeated key events", () => {
    guardMaskedLink("https://evil.example/", open);
    const ev = new KeyboardEvent("keydown", {
      key: "Enter",
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    q("masked-link-cancel")!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it("a second call while a dialog is open does not stack another", () => {
    guardMaskedLink("https://evil.example/", open);
    guardMaskedLink("https://evil.example/", open);
    expect(document.querySelectorAll('[data-testid="masked-link-dialog"]')).toHaveLength(1);

    q<HTMLButtonElement>("masked-link-cancel")!.click();
    guardMaskedLink("https://evil.example/", open);
    expect(document.querySelectorAll('[data-testid="masked-link-dialog"]')).toHaveLength(1);
  });

  it("Enter on a button leaves it to that button", () => {
    guardMaskedLink("https://evil.example/", open);
    const go = q<HTMLButtonElement>("masked-link-go")!;
    go.focus();
    const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    go.dispatchEvent(ev);

    expect(ev.defaultPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("opens a trusted domain directly with no dialog", () => {
    trustDomain("trusted.example");
    guardMaskedLink("https://trusted.example/p", open);

    expect(open).toHaveBeenCalledExactlyOnceWith("https://trusted.example/p");
    expect(q("masked-link-dialog")).toBeNull();
  });

  it("never opens a URL without an http(s) host", () => {
    guardMaskedLink("javascript:alert(1)", open);
    expect(open).not.toHaveBeenCalled();
    expect(q("masked-link-dialog")).toBeNull();
  });
});
