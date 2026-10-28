# Video fixtures

The video file used by the message-video tests, and where it came from.

`clip.mp4` is a 1.2 s, 160×90 VP9 clip in an MP4 container. It was recorded
from a canvas by Playwright's Chromium (`MediaRecorder`,
`video/mp4;codecs=vp9`). So the browser the mocked E2E suite runs is known to
decode it.

`tests/e2e/message-video.spec.ts` makes a QuickTime copy of it by rewriting the
`ftyp` major brand to `qt  `.

## Screen-share motion clips (generated, not committed)

The screen-share baseline (`docs/plans/screen-sharing-pipeline-2026-10-25.md`,
Phase 0) needs a 1080p60 clip that is hard to encode, with a frame counter on
every frame. `clip.mp4` is far too small for that. These clips are generated on
the test machine with ffmpeg (a build with `drawtext`, such as the gyan.dev
"full" build on Windows) and played locally, looped, full screen. They are not
committed: 4 minutes of 1080p60 is hundreds of MB.

Motion (every pixel changes every frame; frame number top left):

```
ffmpeg -f lavfi -i "testsrc2=size=1920x1080:rate=60" -f lavfi -i "mandelbrot=size=1920x1080:rate=60" -filter_complex "[0][1]blend=all_mode=difference,drawtext=text='%{n}':fontsize=96:fontcolor=white:box=1:boxcolor=black:x=40:y=40" -t 240 -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p motion-1080p60.mp4
```

Scrolling text (small text moving 6 px per frame, the case where `detail`
should matter; frame number top right). Make the text file first:

```
# bash
seq 1 400 | awk '{print "Line " $1 " The quick brown fox jumps over the lazy dog 0123456789"}' > scroll.txt
# PowerShell
1..400 | ForEach-Object { "Line $_ The quick brown fox jumps over the lazy dog 0123456789" } | Set-Content scroll.txt
```

```
ffmpeg -f lavfi -i "color=c=white:size=1920x1080:rate=60" -vf "drawtext=textfile=scroll.txt:fontsize=32:fontcolor=black:line_spacing=8:x=60:y=h-mod(n*6\,h+th),drawtext=text='%{n}':fontsize=96:fontcolor=white:box=1:boxcolor=black:x=w-tw-40:y=40" -t 240 -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p scroll-1080p60.mp4
```

Check a clip before a run: it must report `1920,1080,60/1,14400`.

```
ffprobe -v error -select_streams v:0 -count_frames -show_entries stream=width,height,r_frame_rate,nb_read_frames -of csv=p=0 motion-1080p60.mp4
```

Different ffmpeg versions can encode different bytes, so record the clip's
SHA-256 with each run (`Get-FileHash` on Windows, `sha256sum` elsewhere) and
compare runs only on the same file.
