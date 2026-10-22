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
    # The .deb is signed by release.yml ("Sign the .deb updater artifact");
    # the nightly build is unsigned, so *.deb.sig is copied only when present.
    # Server/updater/assets.go matches the package on _amd64.deb / _arm64.deb
    # (Tauri's own Debian-architecture names) and its signature on .sig.
    debs=("$bundle"/deb/*.deb)
    if [ "${#debs[@]}" -ne 1 ]; then
      echo "::error::expected one .deb in $bundle/deb, found ${#debs[@]}"
      exit 1
    fi
    for f in "${debs[0]}" "$bundle"/deb/*.deb.sig; do
      cp "$f" "$out/"
    done
    # The in-app update installs through a root helper and a polkit action
    # that ship inside this package (Client/src-tauri/packaging/linux). Prove
    # the bundler kept them, and the helper's mode and owner, before they ship:
    # a helper that is not root-owned and non-writable would make the client
    # decline to use it, and an update that silently never works is invisible.
    # Tauri's bundler writes data.tar entries as uid/gid 0 with no owner names
    # and no leading ./, so dpkg-deb lists them as "0/0 ... usr/lib/...".
    # Both spellings of root and of the path are accepted.
    listing="$(dpkg-deb -c "${debs[0]}")"
    helper_line="$(grep -E ' (\./)?usr/lib/owncord-client/owncord-deb-update$' <<<"$listing" || true)"
    if ! grep -qE '^-rwxr-xr-x (root/root|0/0) ' <<<"$helper_line"; then
      echo "::error::${debs[0]} must carry usr/lib/owncord-client/owncord-deb-update as -rwxr-xr-x root/root, found: ${helper_line:-nothing}"
      exit 1
    fi
    if ! grep -qE '^-rw-r--r-- (root/root|0/0) .* (\./)?usr/share/polkit-1/actions/com\.owncord\.client\.update\.policy$' <<<"$listing"; then
      echo "::error::${debs[0]} must carry usr/share/polkit-1/actions/com.owncord.client.update.policy as -rw-r--r-- root/root"
      exit 1
    fi
    # Logged so the Version, Depends and Recommends of every build are on record
    # (the helper installs with --no-install-recommends and --allow-downgrades).
    dpkg-deb -f "${debs[0]}" Package Version Depends Recommends
    ;;
  *)
    echo "::error::unknown os '$os'"
    exit 1
    ;;
esac
ls -l "$out"
