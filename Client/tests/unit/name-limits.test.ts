// WP 3C-9, client half: the name and status limits in the inputs. The server
// (Server/auth/visible_text.go) is the authority; these tests pin the cheap
// client mirror and the two behaviours the inputs promise: an over-limit value
// is never sent, and a server refusal shows inline with the typed value kept.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClientError } from "../../src/lib/api";
import {
  attachLimitHint,
  MAX_USERNAME_LEN,
  checkNewUsername,
  collapseSpaces,
  runeCount,
  visibleLength,
} from "../../src/lib/nameLimits";
import { createPromptModal } from "../../src/lib/modalFactory";
import { createStatusPicker, type StatusPickerComponent } from "@components/StatusPicker";
import { createConnectPage } from "../../src/pages/ConnectPage";
import type { ConnectPageCallbacks, SimpleProfile } from "../../src/pages/ConnectPage";
import { createMemberPickerModal } from "../../src/pages/main-page/MemberPickerModal";
import { membersStore } from "@stores/members.store";
import { authStore } from "@stores/auth.store";

const mockToast = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/toast", () => ({ showToast: mockToast }));
vi.mock("../../src/lib/credentials", () => ({
  loadCredential: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../src/components/SettingsOverlay", () => ({
  createSettingsOverlay: () => ({ mount: vi.fn(), destroy: vi.fn() }),
}));

describe("checkNewUsername mirrors auth.ValidateNewUsername", () => {
  const ok = [
    "ab",
    "ada",
    "a-b.c_d",
    "9lives",
    "Jérôme", // precomposed
    "Jérôme", // e + combining acute, o + combining circumflex
    "名前テスト",
    "x".repeat(32),
  ];
  for (const name of ok) {
    it(`accepts ${JSON.stringify(name)}`, () => {
      expect(checkNewUsername(name)).toBeNull();
    });
  }

  const bad: [string, string][] = [
    ["", "tooShort"],
    ["a", "tooShort"],
    ["x".repeat(33), "tooLong"],
    ["everyone", "reserved"],
    ["Here", "reserved"],
    ["has space", "chars"],
    ["emoji😀", "chars"],
    ["𒐫𒐫", "chars"], // cuneiform is Nl: fine in a display name, not in a username
    ["at@sign", "chars"],
    ["_start", "start"],
    [".start", "start"],
    ["-start", "start"],
    ["á̂̃b", "markStack"],
    ["_́ab", "start"],
    ["a_́b", "markPlacement"],
    ["1́b", "markPlacement"],
    ["a​b", "chars"],
    ["a͏b", "invisible"],
    ["a️b", "invisible"],
  ];
  for (const [name, problem] of bad) {
    it(`refuses ${JSON.stringify(name)} as ${problem}`, () => {
      expect(checkNewUsername(name)).toBe(problem);
    });
  }

  it("trims like the server before counting", () => {
    expect(checkNewUsername("  ada  ")).toBeNull();
    expect(checkNewUsername("  a  ")).toBe("tooShort");
  });

  it("counts characters, not UTF-16 units", () => {
    const astral = "𝐀"; // U+1D400, a letter outside the BMP
    expect(runeCount(astral.repeat(32))).toBe(32);
    expect(astral.repeat(32).length).toBe(64);
    expect(checkNewUsername(astral.repeat(32))).toBeNull();
    expect(checkNewUsername(astral.repeat(33))).toBe("tooLong");
  });
});

describe("visibleLength", () => {
  it("collapses runs of spaces and trims, as the server does before counting", () => {
    expect(visibleLength("  a   b  c  ")).toBe(5);
    expect(visibleLength("é")).toBe(1);
    expect(visibleLength("é")).toBe(2);
  });
});

describe("collapseSpaces", () => {
  it("turns tabs and pasted line breaks into spaces, which the server would refuse", () => {
    expect(collapseSpaces(" a\t\tb\nc ")).toBe("a b c");
  });
});

describe("attachLimitHint", () => {
  let input: HTMLInputElement;
  beforeEach(() => {
    input = document.createElement("input");
    document.body.appendChild(input);
  });
  afterEach(() => input.remove());

  it("sets maxlength, describes the input and shows the rule", () => {
    const hint = attachLimitHint(input, { max: 8, hint: "Up to 8", id: "t" });
    expect(input.maxLength).toBe(8);
    expect(input.getAttribute("aria-describedby")).toBe(hint.el.id);
    expect(hint.el.textContent).toBe("Up to 8");
  });

  it("says the limit is reached when a paste would overflow it, before the browser truncates", () => {
    const hint = attachLimitHint(input, { max: 8, hint: "Up to 8", id: "t" });
    const paste = new Event("paste", { bubbles: true }) as ClipboardEvent;
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: () => "0123456789" },
    });
    input.dispatchEvent(paste);
    expect(hint.el.textContent).toBe("Limit of 8 characters reached.");
    // Typing something shorter puts the rule back.
    input.value = "abc";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(hint.el.textContent).toBe("Up to 8");
  });

  it("says so when typing fills the field to the limit", () => {
    const hint = attachLimitHint(input, { max: 4, hint: "Up to 4", id: "t" });
    input.value = "abcd";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(hint.el.textContent).toBe("Limit of 4 characters reached.");
  });

  it("showError replaces the hint and marks the input; the value stays; an edit restores the rule", () => {
    const hint = attachLimitHint(input, { max: 8, hint: "Up to 8", id: "t" });
    input.value = "typed";
    hint.showError("Username is reserved");
    expect(hint.el.textContent).toBe("Username is reserved");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.value).toBe("typed");
    input.value = "typed2";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(hint.el.textContent).toBe("Up to 8");
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Register form
// ---------------------------------------------------------------------------

function makeCallbacks(overrides: Partial<ConnectPageCallbacks> = {}): ConnectPageCallbacks {
  return {
    onLogin: vi.fn().mockResolvedValue(undefined),
    onLoginWithSavedPassword: vi.fn().mockResolvedValue(undefined),
    onRegister: vi.fn().mockResolvedValue(undefined),
    onTotpSubmit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}
const profiles: SimpleProfile[] = [{ name: "Test Server", host: "localhost:8443" }];

describe("register form username", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => container.remove());

  function openRegister(callbacks: ConnectPageCallbacks) {
    const page = createConnectPage(callbacks, profiles);
    page.mount(container);
    (container.querySelector(".server-item") as HTMLElement).click();
    (container.querySelector(".form-switch button") as HTMLElement).click();
    const username = container.querySelector("#username") as HTMLInputElement;
    const hint = container.querySelector(".limit-hint") as HTMLElement;
    const submit = (name: string): void => {
      username.value = name;
      (container.querySelector("#password") as HTMLInputElement).value = "correct-horse-battery";
      (container.querySelector("#invite") as HTMLInputElement).value = "invite-code";
      container
        .querySelector(".connect-form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    };
    return { page, username, hint, submit };
  }

  it("bounds the field and shows the rule in Register only", () => {
    const page = createConnectPage(makeCallbacks(), profiles);
    page.mount(container);
    const username = container.querySelector("#username") as HTMLInputElement;
    const hint = container.querySelector(".limit-hint") as HTMLElement;
    // Login: an account that predates the strict rules must be able to type its name.
    expect(username.hasAttribute("maxlength")).toBe(false);
    expect(hint.hidden).toBe(true);

    (container.querySelector(".form-switch button") as HTMLElement).click();
    expect(username.getAttribute("maxlength")).toBe("64"); // 2 units per character; the 32-character cap is by count
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain("2–32 characters");

    (container.querySelector(".form-switch button") as HTMLElement).click();
    expect(username.hasAttribute("maxlength")).toBe(false);
    expect(hint.hidden).toBe(true);
    page.destroy?.();
  });

  it("does not send a pasted over-limit name; the hint says why and the value stays", async () => {
    const onRegister = vi.fn().mockResolvedValue(undefined);
    const { page, username, hint, submit } = openRegister(makeCallbacks({ onRegister }));
    const long = "a".repeat(40); // a script/IME value maxlength did not truncate
    submit(long);
    await vi.waitFor(() => expect(hint.classList.contains("limit-hint--error")).toBe(true));
    expect(hint.textContent).toBe("Username must be 2–32 characters.");
    expect(username.value).toBe(long);
    expect(onRegister).not.toHaveBeenCalled();
    page.destroy?.();
  });

  it("fits a 32-letter name outside the BMP and sends it; a 33rd letter reaches the limit", async () => {
    const onRegister = vi.fn().mockResolvedValue(undefined);
    const { page, username, hint, submit } = openRegister(makeCallbacks({ onRegister }));
    const bold = "\u{1D400}".repeat(MAX_USERNAME_LEN); // 2 UTF-16 units per letter
    expect(bold.length).toBeLessThanOrEqual(username.maxLength);
    username.value = bold;
    username.setSelectionRange(bold.length, bold.length);
    username.dispatchEvent(
      new InputEvent("beforeinput", { inputType: "insertText", data: "\u{1D400}" }),
    );
    expect(hint.textContent).toBe("Limit of 32 characters reached.");
    submit(bold);
    await vi.waitFor(() =>
      expect(onRegister).toHaveBeenCalledWith(
        "localhost:8443",
        bold,
        expect.anything(),
        "invite-code",
      ),
    );
    page.destroy?.();
  });

  it("refuses a reserved name before sending", async () => {
    const onRegister = vi.fn().mockResolvedValue(undefined);
    const { page, hint, submit } = openRegister(makeCallbacks({ onRegister }));
    submit("everyone");
    await vi.waitFor(() => expect(hint.textContent).toBe("Username is reserved."));
    expect(onRegister).not.toHaveBeenCalled();
    page.destroy?.();
  });

  it("shows the server's refusal under the field and keeps the typed name", async () => {
    // A name the client check passes but the server refuses.
    const onRegister = vi
      .fn()
      .mockRejectedValue(new ApiClientError(400, "INVALID_INPUT", "username is reserved"));
    const { page, username, hint, submit } = openRegister(makeCallbacks({ onRegister }));
    submit("serveronly"); // passes the client check; the server decides otherwise
    await vi.waitFor(() => expect(onRegister).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(hint.textContent).toBe("Username is reserved"));
    expect(hint.classList.contains("limit-hint--error")).toBe(true);
    expect(username.value).toBe("serveronly");
    // Said once, under the field; the banner points at it.
    expect(container.querySelector(".error-banner")!.textContent).toBe(
      "Check the highlighted field.",
    );
    expect(username.getAttribute("aria-describedby")).toContain(hint.id);
    page.destroy?.();
  });
});

// ---------------------------------------------------------------------------
// Custom status
// ---------------------------------------------------------------------------

describe("status picker custom status", () => {
  let container: HTMLDivElement;
  let picker: StatusPickerComponent | null = null;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    picker?.destroy?.();
    picker = null;
    container.remove();
  });

  it("shows a hint, and an over-limit value is not sent", () => {
    const onCustomStatusChange = vi.fn();
    picker = createStatusPicker({
      currentStatus: "online",
      onStatusChange: vi.fn(),
      onCustomStatusChange,
    });
    picker.mount(container);
    const input = container.querySelector<HTMLInputElement>("[data-testid='custom-status-input']")!;
    const hint = container.querySelector<HTMLElement>("[data-testid='custom-status-hint']")!;
    // 2 UTF-16 units per character, so astral text is not cut short; the real
    // limit is enforced by character count.
    expect(input.maxLength).toBe(256);
    expect(hint.textContent).toBe("Up to 128 characters, on one line.");

    const over = "x".repeat(200);
    input.value = over;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onCustomStatusChange).not.toHaveBeenCalled();
    expect(hint.textContent).toBe("Custom status must be at most 128 characters.");
    expect(input.value).toBe(over);

    input.value = "fine";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onCustomStatusChange).toHaveBeenCalledExactlyOnceWith("fine");
  });
});

// ---------------------------------------------------------------------------
// Group DM name
// ---------------------------------------------------------------------------

describe("prompt modal (group DM rename)", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    container.remove();
    document.querySelectorAll(".modal-overlay").forEach((el) => el.remove());
  });

  const input = (): HTMLInputElement =>
    document.querySelector<HTMLInputElement>("[data-testid='prompt-input']")!;
  const confirm = (): HTMLButtonElement =>
    document.querySelector<HTMLButtonElement>("[data-testid='prompt-confirm']")!;
  const hintEl = (): HTMLElement => document.querySelector<HTMLElement>(".limit-hint")!;

  it("blocks an over-limit value with validate and keeps the modal and value", () => {
    const onSubmit = vi.fn();
    createPromptModal(
      {
        title: "Rename",
        hint: "Up to 5 characters, on one line.",
        maxLength: 5,
        validate: (v) => (visibleLength(v) > 5 ? "Too long" : null),
        onSubmit,
      },
      container,
    );
    input().value = "123456789";
    confirm().click();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(hintEl().textContent).toBe("Too long");
    expect(input().value).toBe("123456789");
    expect(document.querySelector(".modal-overlay")).not.toBeNull();
  });

  it("an async refusal shows inline, keeps the typed name and the modal open", async () => {
    const onSubmit = vi.fn().mockResolvedValue("Name must not contain control characters");
    createPromptModal({ title: "Rename", hint: "Up to 100 characters.", onSubmit }, container);
    input().value = "bad name";
    confirm().click();
    await vi.waitFor(() =>
      expect(hintEl().textContent).toBe("Name must not contain control characters"),
    );
    expect(input().value).toBe("bad name");
    expect(document.querySelector(".modal-overlay")).not.toBeNull();
    expect(confirm().disabled).toBe(false);
  });

  it("an async success closes the modal", async () => {
    const onSubmit = vi.fn().mockResolvedValue(null);
    createPromptModal({ title: "Rename", onSubmit }, container);
    input().value = "ok";
    confirm().click();
    await vi.waitFor(() => expect(document.querySelector(".modal-overlay")).toBeNull());
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("ok");
  });
});

describe("new group DM name field", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 1, username: "me", avatar: null, role: "member" } as never,
    }));
    const members = new Map(
      [1, 2, 3].map((id) => [
        id,
        {
          id,
          username: `user${id}`,
          avatar: null,
          role: "member",
          status: "online" as const,
          displayName: null,
        },
      ]),
    );
    membersStore.setState((prev) => ({ ...prev, members }));
  });
  afterEach(() => {
    container.remove();
    document.querySelectorAll(".modal-overlay").forEach((el) => el.remove());
  });

  it("does not create a group with an over-limit name and keeps the picker open", () => {
    const onSelectGroup = vi.fn();
    const picker = createMemberPickerModal({
      onSelect: vi.fn(),
      onSelectGroup,
      onClose: vi.fn(),
    });
    picker.mount(container);
    document.querySelectorAll<HTMLElement>(".dm-member-picker-item").forEach((r) => r.click());
    const name = document.querySelector<HTMLInputElement>("[data-testid='dm-group-name']")!;
    expect(name.maxLength).toBe(200);
    name.value = "g".repeat(150);
    document.querySelector<HTMLElement>("[data-testid='dm-picker-create']")!.click();
    expect(onSelectGroup).not.toHaveBeenCalled();
    expect(document.querySelector(".limit-hint")!.textContent).toBe(
      "Group name must be at most 100 characters.",
    );
    expect(name.value).toBe("g".repeat(150));
    picker.destroy?.();
  });
});

// ---------------------------------------------------------------------------
// Review follow-ups
// ---------------------------------------------------------------------------

describe("Login mode leaves the username unbounded and undescribed", () => {
  it("typing keeps the hint at its rule text and aria-describedby does not point at it", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const page = createConnectPage(makeCallbacks(), profiles);
    page.mount(container);
    const username = container.querySelector("#username") as HTMLInputElement;
    const hint = container.querySelector(".limit-hint") as HTMLElement;
    const rule = hint.textContent;
    expect(username.maxLength).toBe(-1);
    expect(username.getAttribute("aria-describedby") ?? "").not.toContain(hint.id);

    username.value = "a-long-legacy-name";
    username.dispatchEvent(new Event("input", { bubbles: true }));
    expect(hint.textContent).toBe(rule);
    expect(hint.classList.contains("limit-hint--limit")).toBe(false);

    // Register describes it; back to Login drops it again, and an error banner's
    // id is added and removed without disturbing the other tokens.
    (container.querySelector(".form-switch button") as HTMLElement).click();
    expect(username.getAttribute("aria-describedby")).toContain(hint.id);
    (container.querySelector(".form-switch button") as HTMLElement).click();
    expect(username.getAttribute("aria-describedby") ?? "").not.toContain(hint.id);
    page.destroy?.();
    container.remove();
  });
});

describe("one-line fields do not cap below the server's limit", () => {
  it("32 astral characters fit in a 32-character field; a 33rd is cut by character", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    const hint = attachLimitHint(input, {
      max: 32,
      hint: "Up to 32",
      id: "astral",
      countCharacters: true,
    });
    const cuneiform = "𒐫";
    input.value = cuneiform.repeat(32); // 64 UTF-16 units
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.maxLength).toBe(64);
    expect(runeCount(input.value)).toBe(32);
    expect(hint.el.textContent).toBe("Limit of 32 characters reached.");

    input.value = cuneiform.repeat(33).slice(0, 66);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(runeCount(input.value)).toBe(32);
    input.remove();
  });
});

describe("text is sent as the server stores it", () => {
  it("a custom status goes out with runs of spaces collapsed", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const onCustomStatusChange = vi.fn();
    const picker = createStatusPicker({
      currentStatus: "online",
      onStatusChange: vi.fn(),
      onCustomStatusChange,
    });
    picker.mount(container);
    const input = container.querySelector<HTMLInputElement>("[data-testid='custom-status-input']")!;
    input.value = "  heads   down\u00a0\u00a0now ";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onCustomStatusChange).toHaveBeenCalledExactlyOnceWith("heads down now");
    picker.destroy?.();
    container.remove();
  });
});

describe("prompt modal refusals are never silent", () => {
  afterEach(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    document.querySelectorAll(".modal-overlay").forEach((el) => el.remove());
    mockToast.mockClear();
  });

  it("a refusal that arrives after the prompt was closed is toasted", async () => {
    let settle: (v: string | null) => void = () => {};
    const onSubmit = vi.fn().mockReturnValue(new Promise<string | null>((r) => (settle = r)));
    createPromptModal({ title: "Rename", hint: "Up to 100", onSubmit });
    document.querySelector<HTMLInputElement>("[data-testid='prompt-input']")!.value = "x";
    document.querySelector<HTMLButtonElement>("[data-testid='prompt-confirm']")!.click();
    document.querySelector<HTMLButtonElement>("[data-testid='prompt-cancel']")!.click();
    settle("Name is not allowed");
    await vi.waitFor(() => expect(mockToast).toHaveBeenCalledWith("Name is not allowed", "error"));
  });

  it("a refusal from a prompt with no hint is toasted", () => {
    createPromptModal({ title: "Rename", validate: () => "Too long", onSubmit: vi.fn() });
    document.querySelector<HTMLButtonElement>("[data-testid='prompt-confirm']")!.click();
    expect(mockToast).toHaveBeenCalledWith("Too long", "error");
  });
});
