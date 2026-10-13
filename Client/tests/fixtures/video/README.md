# Video fixtures

The video file used by the message-video tests, and where it came from.

`clip.mp4` is a 1.2 s, 160×90 VP9 clip in an MP4 container. It was recorded
from a canvas by Playwright's Chromium (`MediaRecorder`,
`video/mp4;codecs=vp9`). So the browser the mocked E2E suite runs is known to
decode it.

`tests/e2e/message-video.spec.ts` makes a QuickTime copy of it by rewriting the
`ftyp` major brand to `qt  `.
