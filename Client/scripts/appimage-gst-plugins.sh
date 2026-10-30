#!/usr/bin/env bash
# Choose the GStreamer plugins the AppImage bundles.
#
# Tauri's AppImage step (bundleMediaFramework) copies every plugin in
# GSTREAMER_PLUGINS_DIR into the image, and the AppImage only ever loads
# those. The runner's own directory holds base and good, so H.264/AAC
# video in chat and PipeWire cameras did not work in the AppImage. This
# builds a directory with what was there before plus three additions, and
# exports it for the build step:
#   - gstreamer1.0-libav: avdec_h264, avdec_aac (ffmpeg's decoders)
#   - libgstvideoparsersbad from plugins-bad: h264parse/h265parse, which
#     playback needs in front of the decoder. Nothing else from plugins-bad,
#     whose other plugins pull in dozens of libraries.
#   - gstreamer1.0-pipewire: pipewiresrc for PipeWire-only cameras
# strip-appimage-bundled-libs.sh then removes the libraries these pull in
# that must match the host (libpipewire, libva, libvdpau).
#
# Usage (Linux CI, after the system dependencies):
#   bash Client/scripts/appimage-gst-plugins.sh
set -euo pipefail

src="/usr/lib/$(uname -m)-linux-gnu/gstreamer-1.0"
dest="${RUNNER_TEMP:-/tmp}/appimage-gst-plugins"
rm -rf "$dest"
mkdir -p "$dest"

# What the AppImage bundled before, taken before anything below adds to $src.
find "$src" -maxdepth 1 -name '*.so' -exec cp -t "$dest" {} +
before=$(find "$dest" -name '*.so' | wc -l)

sudo apt-get install -y --no-install-recommends \
  gstreamer1.0-libav \
  gstreamer1.0-plugins-bad \
  gstreamer1.0-pipewire

for pkg in gstreamer1.0-libav gstreamer1.0-pipewire; do
  dpkg -L "$pkg" | grep -E "^$src/[^/]+\.so$" | xargs -r cp -t "$dest"
done
cp "$src/libgstvideoparsersbad.so" "$dest"

for plugin in libgstlibav.so libgstpipewire.so libgstvideoparsersbad.so; do
  if [ ! -f "$dest/$plugin" ]; then
    echo "::error::$plugin is missing from $dest"
    exit 1
  fi
done
echo "AppImage GStreamer plugins: $before before, $(find "$dest" -name '*.so' | wc -l) now"

if [ -n "${GITHUB_ENV:-}" ]; then
  echo "GSTREAMER_PLUGINS_DIR=$dest" >> "$GITHUB_ENV"
else
  echo "export GSTREAMER_PLUGINS_DIR=$dest"
fi
