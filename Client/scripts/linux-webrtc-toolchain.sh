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
#   - the libwebrtc archive is pinned by version AND sha256, checked before use;
#   - clang-21 comes from apt.llvm.org's llvm-toolchain-<codename>-21 channel on
#     both architectures. That channel is a moving ref (whatever 21.x point
#     release it currently publishes), trusted through the repository's GPG
#     signature: its signing key is pinned by full fingerprint and the script
#     fails if the downloaded key differs. The exact installed version is
#     printed so every build log records which compiler produced it.
#
# Tag-triggered release jobs restore NO actions/cache entry (cache poisoning,
# zizmor's finding in #1656): release.yml declares no actions/cache step, so
# this script starts from nothing and downloads+verifies. ci.yml does cache the
# libwebrtc archive directory, but it is keyed per-arch and written only by
# ordinary branch/PR runs. The same script runs on both paths, so the verify
# logic cannot drift between them. clang is an apt package outside that
# directory, so it is never cached: it is installed fresh on every runner.
#
# The libwebrtc URLs and digests are the ones the scout verified against the
# real OwnCord binary on Ubuntu (report §3).
set -euo pipefail

# Everything below writes to stderr; only emit_env writes to the original
# stdout (fd 3), so tool chatter can never corrupt the eval'd exports.
exec 3>&1 1>&2

# libwebrtc tag: must match webrtc-sys-build's WEBRTC_TAG for the webrtc-sys
# version livekit 0.9.1 resolves to (0.3.45 -> webrtc-89d790b). A crate bump
# moves this and the digests below together.
WEBRTC_TAG="webrtc-89d790b"
# apt.llvm.org's repository signing key, pinned by full fingerprint.
LLVM_KEY_FPR="6084F3CF814B57C1CF12EFD515CF4D18AF4F7421"

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
    {
      echo "export CC=$CLANG_CC"
      echo "export CXX=$CLANG_CXX"
      echo "export LK_CUSTOM_WEBRTC=$WEBRTC_DIR"
    } >&3
  fi
}

# ---------------------------------------------------------------------------
# 1. clang
# ---------------------------------------------------------------------------
CLANG_CC=/usr/bin/clang-21
CLANG_CXX=/usr/bin/clang++-21
if [ ! -x "$CLANG_CXX" ]; then
  key="$CACHE/llvm-snapshot.gpg.key"
  curl -sSfL --retry 3 -o "$key" https://apt.llvm.org/llvm-snapshot.gpg.key
  gnupghome="$(mktemp -d)"
  fpr="$(GNUPGHOME="$gnupghome" gpg --batch --show-keys --with-colons "$key" \
    | awk -F: '$1 == "pub" { p = 1; next } $1 == "fpr" && p { print $10; p = 0 }')"
  rm -rf "$gnupghome"
  if [ "$fpr" != "$LLVM_KEY_FPR" ]; then
    echo "apt.llvm.org key fingerprint mismatch: got '${fpr}', want $LLVM_KEY_FPR" >&2
    exit 1
  fi
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

# Exports to stdout (local `eval` use) or $GITHUB_ENV (CI).
emit_env
echo "clang: $("$CLANG_CXX" --version | head -1) (package clang-21 $(dpkg-query -W -f='${Version}' clang-21))"
echo "libwebrtc: $WEBRTC_DIR ($(du -sh "$WEBRTC_DIR" | cut -f1))"
