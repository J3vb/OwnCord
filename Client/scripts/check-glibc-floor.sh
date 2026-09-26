#!/usr/bin/env bash
# Assert a Linux binary does not require a glibc newer than the release floor.
#
#   Client/scripts/check-glibc-floor.sh <binary> [max-version]
#
#   Client/scripts/check-glibc-floor.sh --selftest
#
# Why this exists: the Linux client links the prebuilt libwebrtc from webrtc-sys,
# whose symbols are baked against whatever host toolchain produced it. That
# artefact is rebuilt upstream, and a future revision could raise the glibc floor
# without anything here noticing — the binary would install and run fine on the
# CI runner and fail to start on an older distro, which is the exact failure the
# 22.04 build host exists to prevent. The shipped .deb declares no glibc floor,
# so nothing else catches it either.
#
# The floor defaults to 2.35, the glibc in Ubuntu 22.04 (the release build
# host). A binary built ON 22.04 cannot legitimately require more than 2.35.
#
# WEAK references are ignored, and that matters: Rust std emits weak
# `pidfd_spawnp`/`pidfd_getpid` references versioned GLIBC_2.39 when compiled
# against a newer host's headers. A weak undefined symbol resolves to NULL if
# absent — it is not a start-up requirement — so counting it would fail a binary
# that runs fine everywhere. Only strong (required) versioned references are the
# floor. On the 22.04 runner the weak refs are not emitted at all, so this
# rarely fires; it is here so a local run on a newer distro agrees with CI.
set -euo pipefail

FLOOR="${2:-2.35}"

# Highest GLIBC_x.y in a plain text stream (the --selftest input). Pure text in,
# text out.
max_glibc() {
  grep -oE 'GLIBC_[0-9]+\.[0-9]+' | sed 's/^GLIBC_//' | sort -V -u | tail -1
}

# Highest STRONG versioned glibc reference in `objdump -T` output. A line whose
# flag column contains a standalone `w` is weak and skipped; everything else
# with a `(GLIBC_x.y)` version field counts.
objdump_strong_max() {
  awk '
    {
      weak = 0; ver = ""
      for (i = 1; i <= NF; i++) {
        if ($i == "w") weak = 1
        if ($i ~ /^\(GLIBC_[0-9]+\.[0-9]+\)$/) ver = substr($i, 2, length($i) - 2)
      }
      if (ver != "" && !weak) print ver
    }
  ' | max_glibc
}

# Is $1 newer than $2? Only ever called with dotted numeric versions.
newer_than() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | tail -1)" = "$1" ] && [ "$1" != "$2" ]
}

if [ "${1:-}" = "--selftest" ]; then
  # max_glibc picks the highest, not the last seen.
  [ "$(printf 'GLIBC_2.35\nGLIBC_2.34\nGLIBC_2.17\n' | max_glibc)" = "2.35" ]
  [ "$(printf 'GLIBC_2.39\nGLIBC_2.35\n' | max_glibc)" = "2.39" ]
  # The weak filter: strong 2.34 wins over a weak 2.39 it must ignore.
  weak_input=$'0000000000000000  w   DF *UND*\t0000000000000000 (GLIBC_2.39) pidfd_getpid\n0000000000000000      DF *UND*\t0000000000000000 (GLIBC_2.34) __libc_start_main'
  [ "$(printf '%s\n' "$weak_input" | objdump_strong_max)" = "2.34" ]
  # Only weak refs at all: no strong floor, so an empty answer.
  [ -z "$(printf '%s\n' $'0000000000000000  w   DF *UND*\t0000000000000000 (GLIBC_2.39) pidfd_spawnp\n' | objdump_strong_max)" ]
  # The comparison itself.
  newer_than 2.39 2.35
  newer_than 2.36 2.35
  newer_than 2.35 2.35 && exit 1
  newer_than 2.34 2.35 && exit 1
  newer_than 2.17 2.35 && exit 1
  echo "check-glibc-floor: selftest ok"
  exit 0
fi

BIN="${1:-}"
if [ -z "$BIN" ] || [ ! -f "$BIN" ]; then
  echo "usage: check-glibc-floor.sh <binary> [max-version]" >&2
  exit 2
fi

highest="$(objdump -T "$BIN" | objdump_strong_max || true)"
if [ -z "$highest" ]; then
  echo "::error::no strong GLIBC symbol versions in $BIN — is it a dynamic ELF?" >&2
  exit 1
fi

echo "$BIN: highest strong glibc symbol GLIBC_$highest, floor $FLOOR"
if newer_than "$highest" "$FLOOR"; then
  echo "::error::$BIN requires GLIBC_$highest, newer than the $FLOOR release floor" >&2
  exit 1
fi
