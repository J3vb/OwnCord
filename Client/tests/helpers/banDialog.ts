import { vi } from "vitest";

export interface BanDialogControls {
  reason: HTMLInputElement;
  confirm: HTMLButtonElement;
  status: HTMLElement;
}

/** Open the Ban dialog the member menu asks for and return its controls. */
export async function openBanDialogFor(callbacks: {
  onBan: (userId: number, username: string, displayName: string) => void;
}): Promise<BanDialogControls> {
  callbacks.onBan(3, "Bob", "Bob");
  const dialog = await vi.waitFor(() => {
    const el = document.querySelector('[data-testid="ban-dialog"]');
    if (el === null) throw new Error("ban dialog not open yet");
    return el;
  });
  return {
    reason: dialog.querySelector('[data-testid="ban-reason-input"]') as HTMLInputElement,
    confirm: dialog.querySelector('[data-testid="ban-confirm"]') as HTMLButtonElement,
    status: dialog.querySelector('[data-testid="ban-status"]') as HTMLElement,
  };
}
