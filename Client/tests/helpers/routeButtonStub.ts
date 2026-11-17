/** A stand-in for the sound route button (features/voice/routeButton.ts), which
 *  has its own test: it records how a bar asked for one. */
export const routeButtonsMade: { variant: string; signal: AbortSignal }[] = [];

/** The module factory body for `vi.mock(".../features/voice/routeButton", ...)`. */
export function routeButtonMock() {
  return {
    createRouteButton: (variant: string, signal: AbortSignal): HTMLButtonElement => {
      routeButtonsMade.push({ variant, signal });
      const btn = document.createElement("button");
      btn.dataset["callControl"] = "route";
      btn.dataset["testid"] = `route-button-${variant}`;
      return btn;
    },
  };
}
