import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createNsfwConsentBar, createNsfwGate } from "@components/NsfwGate";

describe("NsfwGate component", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function mountGate(overrides?: { onAccept?: () => Promise<void>; onCancel?: () => void }) {
    const onAccept = overrides?.onAccept ?? vi.fn(() => Promise.resolve());
    const onCancel = overrides?.onCancel ?? vi.fn();
    const gate = createNsfwGate({ channelName: "spicy", onAccept, onCancel });
    gate.mount(container);
    const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid='${id}']`)!;
    return { gate, onAccept, onCancel, q };
  }

  it("names the channel in a labelled region and states scope and privacy", () => {
    const { gate, q } = mountGate();
    const region = q("nsfw-gate");
    expect(region.tagName).toBe("SECTION");
    const title = document.getElementById(region.getAttribute("aria-labelledby")!);
    expect(title?.textContent).toBe("#spicy is age-restricted");
    const described = region
      .getAttribute("aria-describedby")!
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent)
      .join(" ");
    expect(described).toContain("not loaded until you agree");
    expect(described).toContain("every device you sign in with");
    expect(described).toContain("withdraw it at any time");
    gate.destroy?.();
  });

  // A stray Enter right after navigating in must never be read as consent.
  it("moves focus to the heading, not to the accept button", () => {
    const { gate } = mountGate();
    expect(document.activeElement?.tagName).toBe("H2");
    gate.destroy?.();
  });

  it("leaves focus where it is when mounted without focusOnMount", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    const gate = createNsfwGate({
      channelName: "spicy",
      onAccept: () => Promise.resolve(),
      onCancel: vi.fn(),
      focusOnMount: false,
    });
    gate.mount(container);
    expect(document.activeElement).toBe(outside);
    gate.destroy?.();
    outside.remove();
  });

  it("keeps the gate busy until the server confirms, without dropping focus", async () => {
    let confirm!: () => void;
    const onAccept = vi.fn(() => new Promise<void>((r) => (confirm = r)));
    const { gate, q } = mountGate({ onAccept });
    const accept = q("nsfw-gate-continue") as HTMLButtonElement;
    accept.focus();

    accept.click();
    accept.click();

    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(accept.getAttribute("aria-disabled")).toBe("true");
    expect(accept.disabled).toBe(false);
    expect(document.activeElement).toBe(accept);
    expect(q("nsfw-gate").getAttribute("aria-busy")).toBe("true");
    confirm();
    await Promise.resolve();
    gate.destroy?.();
  });

  it("stays up with an announced error when the acknowledgement fails", async () => {
    const onAccept = vi.fn(() => Promise.reject(new Error("offline")));
    const { gate, q } = mountGate({ onAccept });
    const accept = q("nsfw-gate-continue");

    accept.click();
    await vi.waitFor(() =>
      expect(q("nsfw-gate-error").textContent).toContain("could not be saved"),
    );

    expect(q("nsfw-gate-error").getAttribute("role")).toBe("alert");
    expect(accept.hasAttribute("aria-disabled")).toBe(false);
    expect(q("nsfw-gate").hasAttribute("aria-busy")).toBe(false);
    accept.click();
    expect(onAccept).toHaveBeenCalledTimes(2);
    gate.destroy?.();
  });

  it("declines from Go back and from Escape without accepting", () => {
    const { gate, onAccept, onCancel, q } = mountGate();
    q("nsfw-gate-back").click();
    q("nsfw-gate").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onAccept).not.toHaveBeenCalled();
    gate.destroy?.();
  });

  it("orders decline before accept for keyboard users", () => {
    const { gate } = mountGate();
    const buttons = [...container.querySelectorAll("button")].map((b) => b.dataset["testid"]);
    expect(buttons).toEqual(["nsfw-gate-back", "nsfw-gate-continue"]);
    gate.destroy?.();
  });

  it("removes itself on destroy and ignores a failure that lands afterwards", async () => {
    let fail!: () => void;
    const { gate, q } = mountGate({
      onAccept: () => new Promise<void>((_, reject) => (fail = () => reject(new Error("x")))),
    });
    const error = q("nsfw-gate-error");
    q("nsfw-gate-continue").click();
    gate.destroy?.();
    fail();
    await Promise.resolve();
    expect(container.querySelector("[data-testid='nsfw-gate']")).toBeNull();
    expect(error.textContent).toBe("");
  });
});

describe("NsfwConsentBar component", () => {
  it("mounts first in its container and withdraws consent once at a time", async () => {
    const container = document.createElement("div");
    container.appendChild(document.createElement("div"));
    let settle!: () => void;
    const onRevoke = vi.fn(() => new Promise<void>((r) => (settle = r)));
    const bar = createNsfwConsentBar({ onRevoke });
    bar.mount(container);

    expect(container.firstElementChild?.getAttribute("data-testid")).toBe("nsfw-consent-bar");
    const revoke = container.querySelector<HTMLButtonElement>(
      "[data-testid='nsfw-consent-revoke']",
    )!;
    expect(revoke.textContent).toBe("Withdraw consent");
    revoke.click();
    revoke.click();
    expect(onRevoke).toHaveBeenCalledTimes(1);
    expect(revoke.getAttribute("aria-disabled")).toBe("true");
    settle();
    await vi.waitFor(() => expect(revoke.hasAttribute("aria-disabled")).toBe(false));

    bar.destroy?.();
    expect(container.querySelector("[data-testid='nsfw-consent-bar']")).toBeNull();
  });
});
