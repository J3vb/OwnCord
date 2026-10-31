import { expect, vi } from "vitest";
import { createVoiceAudioTab } from "../../src/features/settings/VoiceAudioTab";

const SELECT = 'select[aria-label="Video Codec"]';

/** Builds the tab without attaching it; `select()` reads the Video Codec dropdown. */
export function buildTab() {
  const ac = new AbortController();
  const el = createVoiceAudioTab(ac.signal).build();
  const select = (): HTMLSelectElement | null => el.querySelector<HTMLSelectElement>(SELECT);
  return { ac, el, select };
}

const optionValues = (select: HTMLSelectElement | null): string[] =>
  select === null ? [] : [...select.options].map((o) => o.value);

/** The codec values offered right after the tab is built. */
export function codecOptions(): string[] {
  const { ac, select } = buildTab();
  const values = optionValues(select());
  ac.abort();
  return values;
}

/** Waits for the tab's codec probe to settle on exactly `expected`. */
export async function expectCodecsEventually(expected: string[]): Promise<void> {
  const { ac, select } = buildTab();
  await vi.waitFor(() => {
    expect(optionValues(select())).toEqual(expected);
  });
  ac.abort();
}

/** Builds a tab holding a saved `stored` codec and returns the value the dropdown shows. */
export function shownCodecFor(stored: string): string {
  localStorage.setItem("owncord:settings:videoCodec", JSON.stringify(stored));
  const { ac, select } = buildTab();
  const value = select()!.value;
  ac.abort();
  return value;
}
