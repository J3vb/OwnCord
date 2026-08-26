#!/usr/bin/env bash
# Strip host-incompatible libraries from a Tauri-built AppImage.
#
# linuxdeploy bundles the build host's (Ubuntu 22.04) libwayland-* into the
# AppImage and AppRun forces them onto LD_LIBRARY_PATH. Newer hosts' Mesa
# dlopens libwayland-client during EGL init — picking up the stale bundled
# copy makes eglGetDisplay fail (EGL_BAD_PARAMETER) and WebKit aborts,
# leaving a white window. Every supported distro ships libwayland >= the
# 1.20 the client links against, so the host copy is always the right one.
# Verified 2026-07-31: stock alpha.5 AppImage white-screens on Arch; the
# same image with these libs removed renders normally on Arch and Ubuntu.
#
# Usage: strip-appimage-bundled-libs.sh <path-to.AppImage>
# Rewrites the AppImage in place (same filename). Signatures and updater
# tar.gz artifacts must be regenerated afterwards by the caller.
set -euo pipefail

APPIMAGE_PATH="${1:?usage: $0 <path-to.AppImage>}"
APPIMAGE_PATH="$(readlink -f "$APPIMAGE_PATH")"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

ARCH="$(uname -m)"
APPIMAGETOOL="$WORKDIR/appimagetool"
curl -fsSL -o "$APPIMAGETOOL" \
  "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-${ARCH}.AppImage"
chmod +x "$APPIMAGETOOL"

cd "$WORKDIR"
"$APPIMAGE_PATH" --appimage-extract > /dev/null

removed=0
for lib in squashfs-root/usr/lib/libwayland-*.so*; do
  [ -e "$lib" ] || continue
  echo "removing bundled $(basename "$lib")"
  rm -f "$lib"
  removed=$((removed + 1))
done
if [ "$removed" -eq 0 ]; then
  echo "::warning::no bundled libwayland-* found in $APPIMAGE_PATH — linuxdeploy may have stopped bundling it; strip step is now a no-op"
  exit 0
fi

# --appimage-extract-and-run: run without FUSE (CI containers/runners).
# ARCH is required when repacking on a host arch that differs from the
# payload naming; here it always matches the runner.
ARCH="$ARCH" "$APPIMAGETOOL" --appimage-extract-and-run --no-appstream \
  squashfs-root "$WORKDIR/repacked.AppImage"
mv "$WORKDIR/repacked.AppImage" "$APPIMAGE_PATH"
echo "stripped $removed bundled wayland libs from $(basename "$APPIMAGE_PATH")"
