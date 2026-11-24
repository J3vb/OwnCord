/** The controller passes a renderer's focus fallback to the dialogs it opens. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRailController } from "../../../src/features/server-rail/railController";
import { openServerSwitchConfirm } from "../../../src/features/server-rail/switchConfirmDialog";
import { createPromptModal } from "@lib/ui/modalFactory";
import type { FolderItem } from "@lib/prefs/serverRailLayout";

vi.mock(import("../../../src/features/server-rail/switchConfirmDialog"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, openServerSwitchConfirm: vi.fn(actual.openServerSwitchConfirm) };
});
vi.mock(import("@lib/ui/modalFactory"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, createPromptModal: vi.fn(actual.createPromptModal) };
});

const folder: FolderItem = {
  kind: "folder",
  id: "f1",
  name: "Work",
  color: "#3ba55d",
  collapsed: false,
  hosts: ["a.example"],
};

function controller() {
  return createRailController({
    currentHost: "a.example",
    loadServers: () => Promise.resolve([]),
    switchServer: vi.fn(),
    addServer: vi.fn(),
    joinInvite: () => false,
  });
}

const cancel = (testId: string): void =>
  document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.click();

describe("createRailController", () => {
  let ctl: ReturnType<typeof createRailController> | null = null;

  beforeEach(() => {
    localStorage.clear();
    vi.mocked(openServerSwitchConfirm).mockClear();
    vi.mocked(createPromptModal).mockClear();
  });
  afterEach(() => {
    ctl?.destroy();
    ctl = null;
    document.body.innerHTML = "";
  });

  it("start's focus fallback reaches the switch question and the rename prompt", () => {
    const opener = document.createElement("button");
    const fallback = document.createElement("button");
    document.body.append(opener, fallback);
    ctl = controller();
    ctl.start(
      () => {},
      () => fallback,
    );

    opener.focus();
    ctl.activate("b.example");
    expect(vi.mocked(openServerSwitchConfirm).mock.calls[0]?.[0].fallbackFocus?.()).toBe(fallback);
    opener.remove();
    cancel("server-switch-cancel");
    expect(document.activeElement).toBe(fallback);

    document.body.prepend(opener);
    opener.focus();
    ctl.mutations.promptRename(folder);
    expect(vi.mocked(createPromptModal).mock.calls[0]?.[0].fallbackFocus?.()).toBe(fallback);
    opener.remove();
    cancel("prompt-cancel");
    expect(document.activeElement).toBe(fallback);
  });

  it("without a fallback neither dialog gets one", () => {
    ctl = controller();
    ctl.start(() => {});
    ctl.activate("b.example");
    ctl.mutations.promptRename(folder);
    expect(vi.mocked(openServerSwitchConfirm).mock.calls[0]?.[0]).not.toHaveProperty(
      "fallbackFocus",
    );
    expect(vi.mocked(createPromptModal).mock.calls[0]?.[0]).not.toHaveProperty("fallbackFocus");
  });
});
