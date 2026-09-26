#!/usr/bin/env bash
# Collect one platform's desktop bundles into a flat release directory.
#
# Shared by release.yml (the assets that ship) and client-artifact-smoke.yml's
# nightly build, so the staging the release depends on runs every night rather
# than first executing at tag time, and the smoke installs exactly the files a
# release would publish.
#
# Usage: stage-release-assets.sh <windows|linux> <x64|arm64> <out-dir>
# Run from the repository root after `tauri build`. Signatures and updater
# archives are copied when present; the nightly build is unsigned and has none.
set -euo pipefail

os="${1:?usage: $0 <windows|linux> <x64|arm64> <out-dir>}"
arch="${2:?usage: $0 <windows|linux> <x64|arm64> <out-dir>}"
out="${3:?usage: $0 <windows|linux> <x64|arm64> <out-dir>}"
bundle="Client/src-tauri/target/release/bundle"
mkdir -p "$out"
shopt -s nullglob

case "$os" in
  windows)
    # Tauri names the NSIS pair by arch (_x64-setup / _arm64-setup), and
    # Server/updater/assets.go matches each target on exactly that suffix.
    installers=("$bundle"/nsis/*_"$arch"-setup.exe)
    if [ "${#installers[@]}" -ne 1 ]; then
      echo "::error::expected one *_${arch}-setup.exe in $bundle/nsis, found ${#installers[@]}"
      exit 1
    fi
    for f in "${installers[0]}" "$bundle"/nsis/*_"$arch"-setup.nsis.zip "$bundle"/nsis/*_"$arch"-setup.nsis.zip.sig; do
      cp "$f" "$out/"
    done
    ;;
  linux)
    appimages=("$bundle"/appimage/*.AppImage)
    if [ "${#appimages[@]}" -ne 1 ]; then
      echo "::error::expected one .AppImage in $bundle/appimage, found ${#appimages[@]}"
      exit 1
    fi
    # AppImage + updater artifact (.tar.gz) + signatures. Every arm64 filename
    # must carry the arch: FindClientAssets matches on the
    # _aarch64.AppImage.tar.gz suffix, and arch-less names would collide with
    # the x86_64 assets when both artifact sets are downloaded into the same
    # linux/ directory at publish time. Inserting _aarch64 before ".AppImage"
    # renames installer, tar.gz, and .sig consistently, so signatures keep
    # pairing with their artifacts.
    for f in "$bundle"/appimage/*.AppImage "$bundle"/appimage/*.AppImage.tar.gz "$bundle"/appimage/*.sig; do
      base="$(basename "$f")"
      if [ "$arch" = arm64 ] && [[ "$base" != *aarch64* ]]; then
        base="${base/.AppImage/_aarch64.AppImage}"
      fi
      cp "$f" "$out/$base"
    done
    for f in "$bundle"/deb/*.deb; do
      cp "$f" "$out/"
    done
    ;;
  *)
    echo "::error::unknown os '$os'"
    exit 1
    ;;
esac
ls -l "$out"
