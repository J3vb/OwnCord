import { vi } from "vitest";

// Mock credentials module
export const mockLoadCredential = vi.fn().mockResolvedValue(null);

export function netCredentialsMock() {
  return {
    loadCredential: (...args: unknown[]) => mockLoadCredential(...args),
  };
}

// Mock SettingsOverlay so we don't pull in all its dependencies
export function settingsOverlayMock() {
  return {
    createSettingsOverlay: () => ({
      mount: vi.fn(),
      destroy: vi.fn(),
    }),
  };
}

// Mock ui.store actions
export async function uiStoreMock() {
  const actual = await vi.importActual<typeof import("../../src/stores/ui.store")>(
    "../../src/stores/ui.store",
  );
  return {
    ...actual,
    openSettings: vi.fn(),
    closeSettings: vi.fn(),
  };
}
