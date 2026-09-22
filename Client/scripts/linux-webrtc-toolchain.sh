#!/usr/bin/env bash
# Install the Linux native-voice build prerequisites: clang >= 21 and the
# prebuilt libwebrtc that webrtc-sys links against.
#
#   Client/scripts/linux-webrtc-toolchain.sh
#   eval "$(Client/scripts/linux-webrtc-toolchain.sh)"   # local use
#
# The Linux client links LiveKit's Rust SDK, whose webrtc-sys crate compiles
# C++ against Chromium's hermetic libc++ baked into libwebrtc.a. GCC is
# refused outright (it ignores the trivial_abi annotations the archive's
# std::unique_ptr/shared_ptr calling convention depends on) and so is a clang
# older than the floor the archive states in its own headers (clang 21 for
# libwebrtc webrtc-89d790b). This script installs a suitable clang, fetches the
# archive, and writes the environment the build needs: CC/CXX and
# LK_CUSTOM_WEBRTC (so webrtc-sys uses our verified copy instead of
# downloading its own).
#
# Invoked by every Linux leg that builds the crate: ci.yml's rust-tests and
# tauri-build, and release.yml's x64 and arm64 client jobs. Idempotent — a
# second call in the same run re-uses what the first installed.
#
# Security posture, matching the download-and-verify convention the release
# workflow already uses (see the actionlint/osv-scanner/zizmor installs):
#   - every download is pinned by version AND sha256, checked before use;
#   - nothing is fetched from a moving ref.
#
# Tag-triggered release jobs restore NO actions/cache entry (cache poisoning,
# zizmor's finding in #1656): release.yml declares no actions/cache step, so
# this script starts from nothing and downloads+verifies. ci.yml does cache the
# libwebrtc archive directory, but it is keyed per-arch and written only by
# ordinary branch/PR runs. The same script runs on both paths, so the verify
# logic cannot drift between them.
#
# Toolchain choice differs by architecture, deliberately:
#   - x64 prefers the exact Chromium clang (llvmorg-23) libwebrtc was built
#     with. It ships as a relocatable tarball, so it is cached and re-used.
#   - arm64 has no Chromium host tarball for this revision, so it installs
#     apt.llvm.org's clang-21 (the archive's declared floor). That is a normal
#     apt package with no relocatable prefix, so it is installed fresh rather
#     than cached: ~1 minute, and it keeps the release path download-and-verify.
#
# The download URLs and digests are the ones the scout verified against the
# real OwnCord binary on Ubuntu (report §3).
set -euo pipefail

# libwebrtc tag: must match webrtc-sys-build's WEBRTC_TAG for the webrtc-sys
# version livekit 0.9.1 resolves to (0.3.45 -> webrtc-89d790b). A crate bump
# moves this and the digests below together.
WEBRTC_TAG="webrtc-89d790b"
CHROMIUM_CLANG_REV="llvmorg-23-init-10931-g20b6ec66-11"
CHROMIUM_CLANG_SHA256="de584381536aa5ba2403033c4f8b70f3c39c2e5d7fa87c953b7fd8bfbba0ee2a"
# apt.llvm.org's signing key, pinned by content digest (fingerprint
# 6084 F3CF 814B 57C1 CF12 EFD5 15CF 4D18 AF4F 7421).
LLVM_KEY_SHA256="8b2a587ffd672c4687e7581dad4b2f6c1bb2ad6b480cd9771ba2ff48e0b8c75d"

case "$(uname -m)" in
  x86_64)
    WEBRTC_TRIPLE="linux-x64-release"
    WEBRTC_SHA256="b167adad5291cea0e4d66a0454d9d52d2ad714e6b0ed70f4410317d3ebde70c5"
    ;;
  aarch64)
    WEBRTC_TRIPLE="linux-arm64-release"
    WEBRTC_SHA256="f716b10eade18dd11b03b9f93b50cee2ca2eec73b975a63f2ae9ea2a35706420"
    ;;
  *)
    echo "unsupported architecture: $(uname -m) (Linux x64 and arm64 only)" >&2
    exit 1
    ;;
esac

# Cache root. ci.yml restores/saves this directory with actions/cache; release
# jobs leave it empty and pay the download.
CACHE="${OWNCORD_LINUX_WEBRTC_CACHE:-$HOME/.cache/owncord-linux-webrtc}"
mkdir -p "$CACHE"

emit_env() {
  if [ -n "${GITHUB_ENV:-}" ]; then
    {
      echo "CC=$CLANG_CC"
      echo "CXX=$CLANG_CXX"
      echo "LK_CUSTOM_WEBRTC=$WEBRTC_DIR"
    } >> "$GITHUB_ENV"
  else
    echo "export CC=$CLANG_CC"
    echo "export CXX=$CLANG_CXX"
    echo "export LK_CUSTOM_WEBRTC=$WEBRTC_DIR"
  fi
}

# ---------------------------------------------------------------------------
# 1. clang
# ---------------------------------------------------------------------------
if [ "$(uname -m)" = "x86_64" ]; then
  CLANG_DIR="$CACHE/clang-$CHROMIUM_CLANG_REV"
  if [ ! -x "$CLANG_DIR/bin/clang++" ]; then
    url="https://commondatastorage.googleapis.com/chromium-browser-clang/Linux_x64/clang-${CHROMIUM_CLANG_REV}.tar.xz"
    tmp="$CACHE/chromium-clang.tar.xz"
    curl -sSfL --retry 3 -o "$tmp" "$url"
    echo "$CHROMIUM_CLANG_SHA256  $tmp" | sha256sum -c -
    rm -rf "$CLANG_DIR"
    mkdir -p "$CLANG_DIR"
    # The archive has bin/ at its root, so extract straight into the prefix.
    tar xf "$tmp" -C "$CLANG_DIR"
    rm -f "$tmp"
  fi
  CLANG_CC="$CLANG_DIR/bin/clang"
  CLANG_CXX="$CLANG_DIR/bin/clang++"
else
  CLANG_CC=/usr/bin/clang-21
  CLANG_CXX=/usr/bin/clang++-21
  if [ ! -x "$CLANG_CXX" ]; then
    key="$CACHE/llvm-snapshot.gpg.key"
    curl -sSfL --retry 3 -o "$key" https://apt.llvm.org/llvm-snapshot.gpg.key
    echo "$LLVM_KEY_SHA256  $key" | sha256sum -c -
    # shellcheck source=/dev/null
    codename="$(. /etc/os-release && echo "$VERSION_CODENAME")"
    # The key goes under /etc/apt/keyrings, not $HOME: apt drops to the _apt
    # user to fetch indexes and would fail to read a keyring behind a home
    # directory's permissions.
    sudo install -m 0644 -D "$key" /etc/apt/keyrings/llvm-snapshot.asc
    echo "deb [signed-by=/etc/apt/keyrings/llvm-snapshot.asc] https://apt.llvm.org/$codename/ llvm-toolchain-$codename-21 main" \
      | sudo tee /etc/apt/sources.list.d/llvm-21.list >/dev/null
    sudo apt-get update -qq
    sudo apt-get install -y -qq clang-21
  fi
fi

# ---------------------------------------------------------------------------
# 2. prebuilt libwebrtc
# ---------------------------------------------------------------------------
WEBRTC_DIR="$CACHE/$WEBRTC_TRIPLE"
if [ ! -f "$WEBRTC_DIR/lib/libwebrtc.a" ]; then
  url="https://github.com/livekit/rust-sdks/releases/download/${WEBRTC_TAG}/webrtc-${WEBRTC_TRIPLE}.zip"
  zip="$CACHE/${WEBRTC_TRIPLE}.zip"
  curl -sSfL --retry 3 -o "$zip" "$url"
  echo "$WEBRTC_SHA256  $zip" | sha256sum -c -
  rm -rf "$WEBRTC_DIR" "$CACHE/.extract"
  mkdir -p "$CACHE/.extract"
  unzip -q "$zip" -d "$CACHE/.extract"
  mv "$CACHE/.extract/$WEBRTC_TRIPLE" "$WEBRTC_DIR"
  rmdir "$CACHE/.extract"
  rm -f "$zip"
fi

# Put the toolchain on PATH for CI steps that call cargo without our env (the
# GITHUB_ENV exports already cover CC/CXX, but rustc's own linker lookup and
# any direct clang invocation want this too).
if [ -n "${GITHUB_PATH:-}" ]; then
  dirname "$CLANG_CC" >> "$GITHUB_PATH"
fi

# Exports to stdout (local `eval` use) or $GITHUB_ENV (CI); diagnostics to
# stderr so they never corrupt the eval'd output.
emit_env
echo "clang: $("$CLANG_CXX" --version | head -1)" >&2
echo "libwebrtc: $WEBRTC_DIR ($(du -sh "$WEBRTC_DIR" | cut -f1))" >&2
