// "Joined the server" welcome row: the new member's avatar and one
// greeting line, plus a Wave button. Drawn from `kind` and the author alone,
// never from `content` (the server's English fallback for older clients). The
// greeting is picked by message id, so every client shows the same line.
import { createElement, setText } from "@lib/dom";
import { registerSessionReset } from "@lib/sessionRegistry";
import { channelsStore } from "@stores/channels.store";
import { messagingText } from "../../i18n/messaging";

/** What the Wave button sends: an ordinary message, as a reply to the row. */
export const WAVE_CONTENT = "\u{1F44B}";

const GREETINGS = 5;

/** Join rows this session already waved at; one wave per row. */
const waved = new Set<number>();
// App-lifetime: the module-level set lives as long as the page; the reset clears it per session.
void registerSessionReset("welcomeRows:waved", () => waved.clear());

/** Whether the viewer has waved at this row since signing in. */
export function hasWaved(messageId: number): boolean {
  return waved.has(messageId);
}

/** Remember a wave so the row's button stays disabled across repaints. */
export function markWaved(messageId: number): void {
  waved.add(messageId);
}

/** The greeting for a row: the same line for everyone, fixed by the row id. */
export function welcomeGreeting(messageId: number, name: string): string {
  const key = `welcomeRow.line${Math.abs(messageId) % GREETINGS}` as
    | "welcomeRow.line0"
    | "welcomeRow.line1"
    | "welcomeRow.line2"
    | "welcomeRow.line3"
    | "welcomeRow.line4";
  return messagingText(key, { name });
}

/** Whether the viewer may post in the row's channel (the Wave button needs it). */
export function canWaveIn(channelId: number): boolean {
  return channelsStore.getState().channels.get(channelId)?.canSend === true;
}

function setWaveLabel(button: HTMLButtonElement, done: boolean): void {
  setText(
    button,
    `${WAVE_CONTENT} ${messagingText(done ? "welcomeRow.waved" : "welcomeRow.wave")}`,
  );
}

/**
 * The Wave button. Click sends the wave through `onWave` once, then disables.
 * `signal` ends with the row's render.
 */
export function renderWaveButton(
  messageId: number,
  onWave: (messageId: number) => boolean,
  signal: AbortSignal,
): HTMLButtonElement {
  const button = createElement("button", {
    class: "wr-wave",
    type: "button",
    "data-testid": `welcome-row-wave-${messageId}`,
  });
  const done = hasWaved(messageId);
  setWaveLabel(button, done);
  button.disabled = done;
  button.addEventListener(
    "click",
    () => {
      if (hasWaved(messageId) || !onWave(messageId)) return;
      markWaved(messageId);
      button.disabled = true;
      setWaveLabel(button, true);
    },
    { signal },
  );
  return button;
}
