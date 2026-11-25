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

# The packer and the runtime it puts at the head of the image are fixed
# releases, checked against the digests below before either is used. To move
# to a newer release, change the tag and both digests for each arch together.
APPIMAGETOOL_TAG="1.9.1"
RUNTIME_TAG="20251108"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)
    APPIMAGETOOL_SHA256="ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0"
    RUNTIME_SHA256="2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d"
    ;;
  aarch64)
    APPIMAGETOOL_SHA256="f0837e7448a0c1e4e650a93bb3e85802546e60654ef287576f46c71c126a9158"
    RUNTIME_SHA256="00cbdfcf917cc6c0ff6d3347d59e0ca1f7f45a6df1a428a0d6d8a78664d87444"
    ;;
  *)
    echo "unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac
APPIMAGETOOL="$WORKDIR/appimagetool"
RUNTIME="$WORKDIR/runtime"
curl -fsSL -o "$APPIMAGETOOL" \
  "https://github.com/AppImage/appimagetool/releases/download/${APPIMAGETOOL_TAG}/appimagetool-${ARCH}.AppImage"
echo "$APPIMAGETOOL_SHA256  $APPIMAGETOOL" | sha256sum -c -
curl -fsSL -o "$RUNTIME" \
  "https://github.com/AppImage/type2-runtime/releases/download/${RUNTIME_TAG}/runtime-${ARCH}"
echo "$RUNTIME_SHA256  $RUNTIME" | sha256sum -c -
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
wayland=$removed
# The same holds for libraries the media plugins (appimage-gst-plugins.sh)
# pull in that talk to host parts of their own version: libpipewire loads
# the host's SPA modules and talks to its daemon, libva and libvdpau load
# the host's GPU drivers. A host without them only loses those plugins.
for lib in squashfs-root/usr/lib/libpipewire-*.so* squashfs-root/usr/lib/libva*.so* \
  squashfs-root/usr/lib/libvdpau*.so*; do
  [ -e "$lib" ] || continue
  echo "removing bundled $(basename "$lib")"
  rm -f "$lib"
  removed=$((removed + 1))
done
if [ "$wayland" -eq 0 ]; then
  echo "::warning::no bundled libwayland-* found in $APPIMAGE_PATH — linuxdeploy may have stopped bundling it"
fi
if [ "$removed" -eq 0 ]; then
  echo "nothing to strip; $APPIMAGE_PATH is unchanged"
  exit 0
fi

# The extracted tree keeps the image's modes, which can be owner-only;
# appimagetool refuses to pack a tree other users cannot read.
chmod -R a+rX squashfs-root

# --appimage-extract-and-run: run without FUSE (CI containers/runners).
# ARCH is required when repacking on a host arch that differs from the
# payload naming; here it always matches the runner.
# --runtime-file: pack with the checked runtime above; without it the packer
# fetches one itself at pack time.
ARCH="$ARCH" "$APPIMAGETOOL" --appimage-extract-and-run --no-appstream \
  --runtime-file "$RUNTIME" squashfs-root "$WORKDIR/repacked.AppImage"
mv "$WORKDIR/repacked.AppImage" "$APPIMAGE_PATH"
echo "stripped $removed bundled host-matched libs from $(basename "$APPIMAGE_PATH")"
