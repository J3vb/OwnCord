import { createVoiceAudioTab } from "../../src/features/settings/VoiceAudioTab";

/** Builds the tab, attaches it to the document and hands back its root and abort controller. */
export function mountTab(): {
  ac: AbortController;
  el: ReturnType<ReturnType<typeof createVoiceAudioTab>["build"]>;
  tab: ReturnType<typeof createVoiceAudioTab>;
} {
  const ac = new AbortController();
  const tab = createVoiceAudioTab(ac.signal);
  const el = tab.build();
  document.body.appendChild(el);
  return { ac, el, tab };
}
