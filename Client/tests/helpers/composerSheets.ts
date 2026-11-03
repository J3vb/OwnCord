import { applyReadyCapabilities, resetServerCapabilities } from "@lib/net/serverCapabilities";
import { authStore } from "@stores/auth.store";

/** history.back() lands its popstate on a later task in jsdom. */
export async function settleHistory(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

/** The composer's open "+" sheet, or null. */
export const attachSheetEl = (): HTMLElement | null =>
  document.querySelector('[data-testid="attach-sheet"]');

/** A server with stickers, polls and voice messages, and a 10 MB upload limit. */
export function useFullComposerServer(): void {
  localStorage.clear();
  applyReadyCapabilities({ stickers: true, polls: true, voice_messages: true });
  authStore.setState((s) => ({ ...s, uploadPolicy: { max_upload_bytes: 10 * 1024 * 1024 } }));
}

/** Undoes useFullComposerServer. */
export function resetComposerServer(): void {
  resetServerCapabilities();
  authStore.setState((s) => ({ ...s, uploadPolicy: null }));
  localStorage.clear();
}
