# Video fixtures

`clip.mp4` is a 1.2 s, 160×90 VP9 clip in an MP4 container, recorded from a
canvas by Playwright's Chromium (`MediaRecorder`, `video/mp4;codecs=vp9`), so
the browser the mocked e2e suite runs is known to decode it.
`message-video.spec.ts` derives its QuickTime twin by rewriting the `ftyp`
major brand to `qt  `.
