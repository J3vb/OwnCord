/** history.back() lands its popstate on a later task in jsdom. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

/** A user's Back press. */
export async function pressBack(): Promise<void> {
  history.back();
  await settle();
}

/** Whether the current history entry carries the app's back marker. */
export const guarded = (): boolean => {
  const state: unknown = history.state;
  return typeof state === "object" && state !== null && "owncordBack" in state;
};
