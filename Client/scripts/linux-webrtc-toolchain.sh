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
# libwebrtc webrtc-a545de4). This script finds or installs a suitable clang,
# fetches the archive, and writes the environment the build needs: CC/CXX and
# LK_CUSTOM_WEBRTC (so webrtc-sys uses our verified copy instead of
# downloading its own).
#
# It also fetches cuda.h so webrtc-sys compiles NVENC/NVDEC, and exports
# CUDA_HOME.
#
# Invoked by every Linux leg that builds the crate: ci.yml's rust-tests and
# tauri-build, and release.yml's x64 and arm64 client jobs. Idempotent — a
# second call in the same run re-uses what the first installed.
#
# Security posture, matching the download-and-verify convention the release
# workflow already uses (see the actionlint/osv-scanner/zizmor installs):
#   - the libwebrtc archive is pinned by version AND sha256, checked before use;
#   - the CUDA headers come from NVIDIA's nvidia-cuda-runtime-cu12 wheel on PyPI,
#     pinned by content-addressed URL plus sha256 per architecture; only
#     include/ is extracted, and it is compiled against and never shipped;
#   - clang: CC/CXX from the environment if both are set (and both are
#     clang >= 21, else the script fails); otherwise an
#     installed clang++-21 or clang++ (in that order) reporting major >= 21;
#     otherwise, on a Debian/Ubuntu release apt.llvm.org publishes, clang-21
#     from its llvm-toolchain-<codename>-21 channel (what CI and release jobs
#     get on both architectures: their runners have no clang >= 21). That
#     channel is a moving ref (whatever 21.x point release it currently
#     publishes), trusted through the repository's GPG
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

# CUDA_WHEEL_VERSION names the nvidia-cuda-runtime-cu12 wheel the per-arch URLs
# and digests below come from (cuda.h only, ~1 MB; Ubuntu's nvidia-cuda-dev is
# 668 MB). Bumping it moves all three together.
CUDA_WHEEL_VERSION="12.8.90"

# libwebrtc tag: must match webrtc-sys-build's WEBRTC_TAG for the webrtc-sys
# version livekit 0.10.0 resolves to (0.3.52, whose webrtc-sys-build 0.3.21 pins
# webrtc-a545de4; libwebrtc crate 0.3.55). A crate bump that moves the tag
# moves this and the digests below together.
WEBRTC_TAG="webrtc-a545de4"
# apt.llvm.org's repository signing key, pinned by full fingerprint.
LLVM_KEY_FPR="6084F3CF814B57C1CF12EFD515CF4D18AF4F7421"

case "$(uname -m)" in
  x86_64)
    WEBRTC_TRIPLE="linux-x64-release"
    WEBRTC_SHA256="2ece73b9a72a2cacd73d0c62ac3a414e202f37885c3c8f49dddb43c1443ac0bd"
    CUDA_WHEEL_URL="https://files.pythonhosted.org/packages/0d/9b/a997b638fcd068ad6e4d53b8551a7d30fe8b404d6f1804abf1df69838932/nvidia_cuda_runtime_cu12-12.8.90-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl"
    CUDA_WHEEL_SHA256="adade8dcbd0edf427b7204d480d6066d33902cab2a4707dcfc48a2d0fd44ab90"
    ;;
  aarch64)
    WEBRTC_TRIPLE="linux-arm64-release"
    WEBRTC_SHA256="e87dff71422c5cb1470f6cf00ecc4ad6964e746c5039831b7206b946b5d13c5f"
    CUDA_WHEEL_URL="https://files.pythonhosted.org/packages/7c/75/f865a3b236e4647605ea34cc450900854ba123834a5f1598e160b9530c3a/nvidia_cuda_runtime_cu12-12.8.90-py3-none-manylinux2014_aarch64.manylinux_2_17_aarch64.whl"
    CUDA_WHEEL_SHA256="52bf7bbee900262ffefe5e9d5a2a69a30d97e2bc5bb6cc866688caa976966e3d"
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
      echo "CUDA_HOME=$CUDA_DIR"
    } >> "$GITHUB_ENV"
  else
    {
      echo "export CC=$CLANG_CC"
      echo "export CXX=$CLANG_CXX"
      echo "export LK_CUSTOM_WEBRTC=$WEBRTC_DIR"
      echo "export CUDA_HOME=$CUDA_DIR"
    } >&3
  fi
}

# ---------------------------------------------------------------------------
# 1. clang
# ---------------------------------------------------------------------------
clang_major() {
  local v
  v="$("$1" -dumpversion 2>/dev/null)" || return 0
  echo "${v%%.*}"
}

CLANG_CC=""
CLANG_CXX=""
if [ -n "${CC:-}" ] && [ -n "${CXX:-}" ]; then
  # An explicit override is the developer's intent, so a wrong compiler is an
  # error here, not a reason to fall back to PATH discovery.
  for bin in "$CC" "$CXX"; do
    if ! "$bin" --version 2>/dev/null | grep -qi clang \
      || ! [ "$(clang_major "$bin")" -ge 21 ] 2>/dev/null; then
      echo "CC/CXX must be clang >= 21 (got '$bin'): unset them to auto-detect, or point them at clang 21." >&2
      exit 1
    fi
  done
  CLANG_CC="$CC"
  CLANG_CXX="$CXX"
else
  for suffix in -21 ""; do
    cc="$(command -v "clang$suffix" || true)"
    cxx="$(command -v "clang++$suffix" || true)"
    if [ -n "$cc" ] && [ -n "$cxx" ] && [ "$(clang_major "$cxx")" -ge 21 ] 2>/dev/null; then
      CLANG_CC="$cc"
      CLANG_CXX="$cxx"
      break
    fi
  done
fi

if [ -z "$CLANG_CXX" ]; then
  # shellcheck source=/dev/null
  codename="$(. /etc/os-release && echo "${VERSION_CODENAME:-}")" || codename=""
  case "$codename" in
    focal | jammy | noble | bullseye | bookworm | trixie) ;;
    *)
      echo "clang >= 21 is required: install it and put it on PATH (as clang-21/clang++-21 or clang/clang++), or set CC and CXX to it. Automatic install from apt.llvm.org is only done on Debian/Ubuntu releases it publishes (focal, jammy, noble, bullseye, bookworm, trixie); this host is '${codename:-unknown}'." >&2
      exit 1
      ;;
  esac
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
  # The key goes under /etc/apt/keyrings, not $HOME: apt drops to the _apt
  # user to fetch indexes and would fail to read a keyring behind a home
  # directory's permissions.
  sudo install -m 0644 -D "$key" /etc/apt/keyrings/llvm-snapshot.asc
  echo "deb [signed-by=/etc/apt/keyrings/llvm-snapshot.asc] https://apt.llvm.org/$codename/ llvm-toolchain-$codename-21 main" \
    | sudo tee /etc/apt/sources.list.d/llvm-21.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq clang-21
  CLANG_CC=/usr/bin/clang-21
  CLANG_CXX=/usr/bin/clang++-21
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

# ---------------------------------------------------------------------------
# 3. hardware video encoder headers
# ---------------------------------------------------------------------------
# webrtc-sys compiles its NVENC/NVDEC encoders and decoders when
# $CUDA_HOME/include/cuda.h exists. The NVIDIA libraries are dlopened at run
# time, so the build needs headers only, and a machine without them still runs.
# Without cuda.h the crate builds silently with no hardware codec
# (check-nvenc-linked.sh guards the release binary).
#
# VA-API (libva-dev) is deliberately NOT installed: webrtc-sys would then also
# compile its VA-API H.264 encoder, and hardware H.264 under voice E2EE is
# unproven there (Intel's 3-byte start codes broke E2EE on Windows; some Mesa
# drivers write their own slice NAL). It waits on a real Intel/AMD E2EE check.
CUDA_DIR="$CACHE/cuda-headers-$CUDA_WHEEL_VERSION"
if [ ! -f "$CUDA_DIR/include/cuda.h" ]; then
  whl="$CACHE/cuda-runtime-$(uname -m).whl"
  curl -sSfL --retry 3 -o "$whl" "$CUDA_WHEEL_URL"
  echo "$CUDA_WHEEL_SHA256  $whl" | sha256sum -c -
  rm -rf "$CUDA_DIR" "$CACHE/.extract-cuda"
  mkdir -p "$CACHE/.extract-cuda"
  unzip -q "$whl" 'nvidia/cuda_runtime/include/*' -d "$CACHE/.extract-cuda"
  mkdir -p "$CUDA_DIR"
  mv "$CACHE/.extract-cuda/nvidia/cuda_runtime/include" "$CUDA_DIR/include"
  rm -rf "$CACHE/.extract-cuda" "$whl"
fi
[ -f "$CUDA_DIR/include/cuda.h" ] || { echo "cuda.h missing after extract" >&2; exit 1; }

# Exports to stdout (local `eval` use) or $GITHUB_ENV (CI).
emit_env
echo "clang: $CLANG_CXX: $("$CLANG_CXX" --version | head -1)"
if [ "$CLANG_CXX" = /usr/bin/clang++-21 ]; then
  echo "clang package: clang-21 $(dpkg-query -W -f='${Version}' clang-21 2>/dev/null || echo unknown)"
fi
echo "cuda headers: $CUDA_DIR (CUDA_VERSION $(awk '/#define CUDA_VERSION /{print $3}' "$CUDA_DIR/include/cuda.h"))"
echo "libwebrtc: $WEBRTC_DIR ($(du -sh "$WEBRTC_DIR" | cut -f1))"
