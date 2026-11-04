import { authStore } from "@stores/auth.store";
import { setNotesContextSource } from "../../src/features/profiles/userNotes";

/** Makes the signed-in user id 1. */
export function signInUserOne(): void {
  authStore.setState((p) => ({ ...p, user: { ...(p.user as object), id: 1 } as never }));
}

/** A notes context with no api, host "h" and a live session. */
export function useOfflineNotesContext(): void {
  setNotesContextSource(() => ({
    api: null,
    host: "h",
    sessionSignal: new AbortController().signal,
  }));
}
