# Audio fixtures

Recordings that the click-suppression tests feed through the voice input path:

- `tests/unit/rnnoise-click-suppression.test.ts`
- `tests/unit/vad-worklet-click.test.ts`
- `tests/e2e/fullstack/voice-click.spec.ts`
- `tests/browser/voice-gate.test.ts`

Both are CC0 (public domain) files from Wikimedia Commons. They were converted
to 48 kHz mono 16-bit PCM with a standard 44-byte WAV header.

| File              | Source                                                                                                                           | Licence | What was kept                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------ |
| `mouse-click.wav` | [Computer Mouse Click.wav](https://commons.wikimedia.org/wiki/File:Computer_Mouse_Click.wav) by FlowgerWikiCommons               | CC0     | The first 60 ms (the click and its tail), left channel |
| `speech.wav`      | [Larynx-HiFi-GAN speech sample.wav](https://commons.wikimedia.org/wiki/File:Larynx-HiFi-GAN_speech_sample.wav) (synthetic voice) | CC0     | The first second, scaled by 0.3 to a microphone level  |
