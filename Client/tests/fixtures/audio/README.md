# Audio fixtures

Recordings fed through the voice input path by the click-suppression tests
(`tests/unit/rnnoise-click-suppression.test.ts`,
`tests/unit/vad-worklet-click.test.ts`,
`tests/e2e/fullstack/voice-click.spec.ts`). Both are CC0 files from Wikimedia
Commons, converted to 48 kHz mono 16-bit PCM with a canonical 44-byte header.

| File              | Source                                                                                                                           | Licence | What was kept                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------ |
| `mouse-click.wav` | [Computer Mouse Click.wav](https://commons.wikimedia.org/wiki/File:Computer_Mouse_Click.wav) by FlowgerWikiCommons               | CC0     | the first 60 ms (the click and its tail), left channel |
| `speech.wav`      | [Larynx-HiFi-GAN speech sample.wav](https://commons.wikimedia.org/wiki/File:Larynx-HiFi-GAN_speech_sample.wav) (synthetic voice) | CC0     | the first second, scaled by 0.3 to a microphone level  |
