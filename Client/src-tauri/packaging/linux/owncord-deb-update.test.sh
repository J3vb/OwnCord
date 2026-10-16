#!/usr/bin/env bash
# Shell tests for owncord-deb-update. Run with bash:
#   bash Client/src-tauri/packaging/linux/owncord-deb-update.test.sh
# (the Rust test `helper_script_suite` runs it). The helper is sourced, and the
# commands it calls (dpkg-query, dpkg-deb, dpkg, id, install, setpriv, apt-get)
# are replaced by functions, so nothing needs root and nothing is installed.
set -u

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=owncord-deb-update
. "$here/owncord-deb-update"

failures=0
passes=0
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT

GOOD_CONTENT="verified package bytes"
GOOD_HASH=$(printf %s "$GOOD_CONTENT" | sha256sum | cut -d' ' -f1)

# --- stubs -----------------------------------------------------------------
# State lives in files under $T (set per test), because the helper reads
# command output through $( ) subshells.

dpkg-query() { echo "owncord-client: /usr/lib/owncord-client/owncord-deb-update"; }
dpkg() { echo "${STUB_ARCH:-amd64}"; }
dpkg-deb() {
  # dpkg-deb -f <file> <field>
  case "$3" in
    Package) echo "${STUB_PACKAGE:-owncord-client}" ;;
    Architecture) echo "${STUB_PKG_ARCH:-amd64}" ;;
  esac
}
id() { echo 1000; }
install() {
  # install -d -m 0755 -o root -g root <dir>: no root needed here.
  local dir="${*: -1}"
  mkdir -p "$dir"
}
setpriv() {
  # Record the identity options, drop them, run the rest as the test user.
  local opts=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --reuid=* | --regid=* | --init-groups) opts+=("$1"); shift ;;
      *) break ;;
    esac
  done
  echo "${opts[*]} :: $*" >>"$T/setpriv.log"
  if [ -n "${STUB_SETPRIV_SWAP:-}" ] && [ "$1" = head ]; then
    # The file changed on disk after the client hashed it.
    printf %s "$STUB_SETPRIV_SWAP"
    return 0
  fi
  "$@"
}
apt-get() {
  echo "$*" >>"$T/apt.log"
  # Record where the file handed to apt lives and that it still exists.
  local last="${*: -1}"
  [ -f "$last" ] && echo "present" >>"$T/apt.present"
  return "${STUB_APT_RC:-0}"
}

# --- harness ---------------------------------------------------------------

# run_helper <args...>: runs main in a subshell with a clean cache and logs
# ($T comes from reset_stubs). Sets rc.
run_helper() {
  rm -rf "$T/cache" "$T/apt.log" "$T/apt.present" "$T/setpriv.log"
  (main "$@") >"$T/out" 2>&1
  rc=$?
}

check() { # check <name> <condition-result> [detail]
  if [ "$2" -eq 0 ]; then
    passes=$((passes + 1))
  else
    failures=$((failures + 1))
    echo "FAIL: $1 ${3:-}"
  fi
}

eq() { [ "$2" = "$3" ]; check "$1" $? "(got '$2', want '$3')"; }
work_dirs() { find "$T/cache" -mindepth 1 -maxdepth 1 -name 'update.*' 2>/dev/null | wc -l | tr -d ' '; }
apt_calls() { if [ -f "$T/apt.log" ]; then wc -l <"$T/apt.log" | tr -d ' '; else echo 0; fi; }

reset_stubs() {
  unset STUB_ARCH STUB_PACKAGE STUB_PKG_ARCH STUB_SETPRIV_SWAP STUB_APT_RC
  export PKEXEC_UID=1000
  T=$(mktemp -d "$root/t.XXXXXX")
  CACHE_ROOT="$T/cache"
  mkdir -p "$T/src"
  printf %s "$GOOD_CONTENT" >"$T/src/update.deb"
}

# --- tests -----------------------------------------------------------------

test_argument_checks_exit_10() {
  reset_stubs
  run_helper
  eq "no arguments" "$rc" 10
  run_helper update.deb "$GOOD_HASH"
  eq "relative path" "$rc" 10
  run_helper "$T/src/update.deb" "${GOOD_HASH%?}"
  eq "short hash" "$rc" 10
  run_helper "$T/src/update.deb" "${GOOD_HASH%?}G"
  eq "non-hex hash" "$rc" 10
  run_helper "$T/src/update.deb" "$(echo "$GOOD_HASH" | tr a-f A-F)"
  eq "uppercase hash" "$rc" 10
  run_helper "$T/src/update.txt" "$GOOD_HASH"
  eq "not a .deb path" "$rc" 10
  run_helper "$T/src/update.deb" "$GOOD_HASH" extra
  eq "three arguments" "$rc" 10
  unset PKEXEC_UID
  run_helper "$T/src/update.deb" "$GOOD_HASH"
  eq "missing PKEXEC_UID" "$rc" 10
  export PKEXEC_UID=abc
  run_helper "$T/src/update.deb" "$GOOD_HASH"
  eq "non-numeric PKEXEC_UID" "$rc" 10
  eq "refused arguments never call apt" "$(apt_calls)" 0
}

test_source_is_read_through_setpriv_as_the_invoking_user() {
  reset_stubs
  export PKEXEC_UID=4242
  id() { echo 4343; }
  run_helper "$T/src/update.deb" "$GOOD_HASH"
  eq "happy path with another uid" "$rc" 0
  grep -q -- '--reuid=4242 --regid=4343 --init-groups :: head -c 536870912' "$T/setpriv.log"
  check "head runs as the invoking uid and gid with their groups" $?
  # The unreadable-source case: the user's own rights decide.
  run_helper "$T/src/missing.deb" "$GOOD_HASH"
  eq "a source the user cannot read exits 11" "$rc" 11
  eq "unreadable source never calls apt" "$(apt_calls)" 0
  eq "unreadable source leaves no work directory" "$(work_dirs)" 0
  id() { echo 1000; }
}

test_executing_the_file_directly_runs_main() {
  reset_stubs
  # Not sourced: the file under its own path, no arguments, is a usage error.
  "$here/owncord-deb-update" >/dev/null 2>&1
  eq "direct execution reaches main (usage error)" "$?" 10
  sh "$here/owncord-deb-update" >/dev/null 2>&1
  eq "execution through sh reaches main" "$?" 10
}

test_stale_work_dirs_are_removed_and_fresh_ones_kept() {
  reset_stubs
  rm -rf "$T/cache"
  mkdir -p "$T/cache/update.stale" "$T/cache/update.fresh" "$T/cache/other.stale"
  touch -d '2 days ago' "$T/cache/update.stale" "$T/cache/other.stale"
  (main "$T/src/update.deb" "$GOOD_HASH") >/dev/null 2>&1
  eq "run succeeds" "$?" 0
  [ ! -e "$T/cache/update.stale" ]
  check "an old update.* directory is removed" $?
  [ -d "$T/cache/update.fresh" ]
  check "a recent update.* directory is kept" $?
  [ -d "$T/cache/other.stale" ]
  check "only update.* names are touched" $?
}

test_oversize_source_is_truncated_and_fails_the_hash() {
  reset_stubs
  MAX_COPY_BYTES=5
  run_helper "$T/src/update.deb" "$GOOD_HASH"
  eq "a source over the cap exits 12" "$rc" 12
  eq "oversize never calls apt" "$(apt_calls)" 0
  eq "oversize leaves no work directory" "$(work_dirs)" 0
  # shellcheck disable=SC2034 # read by the sourced helper
  MAX_COPY_BYTES=536870912
}

test_hash_mismatch_exits_12_and_never_calls_apt() {
  reset_stubs
  # The file changed on disk between the client's verification and the copy.
  export STUB_SETPRIV_SWAP="different bytes"
  run_helper "$T/src/update.deb" "$GOOD_HASH"
  eq "swapped bytes exit 12" "$rc" 12
  eq "swapped bytes never reach apt" "$(apt_calls)" 0
  eq "swapped bytes leave no work directory" "$(work_dirs)" 0
  unset STUB_SETPRIV_SWAP
}

test_wrong_package_or_arch_exits_13() {
  reset_stubs
  export STUB_PACKAGE=some-other-package
  run_helper "$T/src/update.deb" "$GOOD_HASH"
  eq "other package" "$rc" 13
  eq "other package never calls apt" "$(apt_calls)" 0
  eq "other package leaves no work directory" "$(work_dirs)" 0
  reset_stubs
  export STUB_PKG_ARCH=arm64 STUB_ARCH=amd64
  run_helper "$T/src/update.deb" "$GOOD_HASH"
  eq "other architecture" "$rc" 13
  eq "other architecture never calls apt" "$(apt_calls)" 0
}

test_happy_path_runs_apt_get_once_on_the_root_copy_with_exact_flags() {
  reset_stubs
  run_helper "$T/src/update.deb" "$GOOD_HASH"
  eq "exit code" "$rc" 0
  eq "apt-get runs once" "$(apt_calls)" 1
  local call copy
  call=$(cat "$T/apt.log")
  copy=${call##* }
  eq "exact apt-get arguments" "${call% *}" \
    "install -y --no-install-recommends --no-remove --allow-downgrades -o DPkg::Lock::Timeout=120"
  case "$copy" in
    "$CACHE_ROOT"/update.*/owncord.deb) check "apt installs the copy under the work directory" 0 ;;
    *) check "apt installs the copy under the work directory" 1 "(got $copy)" ;;
  esac
  if [ "$copy" = "$T/src/update.deb" ]; then not_source=1; else not_source=0; fi
  check "apt never installs the source path" "$not_source"
  eq "the copy existed when apt ran" "$(cat "$T/apt.present")" present
  eq "work directory removed after success" "$(work_dirs)" 0
}

test_apt_failure_exits_14() {
  reset_stubs
  export STUB_APT_RC=100
  run_helper "$T/src/update.deb" "$GOOD_HASH"
  eq "apt failure" "$rc" 14
  eq "work directory removed after an apt failure" "$(work_dirs)" 0
}

test_work_dir_removed_on_every_exit() {
  reset_stubs
  local mode
  for mode in ok apt swap pkg arch; do
    reset_stubs
    case "$mode" in
      apt) export STUB_APT_RC=1 ;;
      swap) export STUB_SETPRIV_SWAP=x ;;
      pkg) export STUB_PACKAGE=other ;;
      arch) export STUB_PKG_ARCH=arm64 ;;
    esac
    run_helper "$T/src/update.deb" "$GOOD_HASH"
    eq "no work directory left after $mode" "$(work_dirs)" 0
  done
  # A signal mid-install still removes it.
  reset_stubs
  apt-get() { kill -TERM "$BASHPID"; sleep 1; }
  run_helper "$T/src/update.deb" "$GOOD_HASH"
  eq "no work directory left after a signal" "$(work_dirs)" 0
  [ "$rc" -ne 126 ] && [ "$rc" -ne 127 ]
  check "a signal is not 126 or 127 (got $rc)" $?
  apt-get() {
    echo "$*" >>"$T/apt.log"
    local last="${*: -1}"
    [ -f "$last" ] && echo "present" >>"$T/apt.present"
    return "${STUB_APT_RC:-0}"
  }
}

test_never_exits_126_or_127() {
  reset_stubs
  local code
  for code in 126 127; do
    reset_stubs
    export STUB_APT_RC=$code
    run_helper "$T/src/update.deb" "$GOOD_HASH"
    [ "$rc" -ne 126 ] && [ "$rc" -ne 127 ]
    check "apt-get returning $code does not leak (got $rc)" $?
  done
  # An unusable work area is reported as 15, never as the failing command's code.
  reset_stubs
  install() { return 127; }
  run_helper "$T/src/update.deb" "$GOOD_HASH"
  eq "install failure maps to 15" "$rc" 15
  install() { local dir="${*: -1}"; mkdir -p "$dir"; }
  # A missing command inside update() must not escape as 127 either.
  reset_stubs
  sha256sum() { return 127; }
  run_helper "$T/src/update.deb" "$GOOD_HASH"
  [ "$rc" -ne 126 ] && [ "$rc" -ne 127 ]
  check "sha256sum returning 127 does not leak (got $rc)" $?
  unset -f sha256sum
}

test_helper_reads_no_environment_other_than_pkexec_uid() {
  reset_stubs
  # CACHE_ROOT and HELPER_PATH are assigned unconditionally at the top of the
  # file, so an inherited variable of the same name cannot redirect it.
  grep -qE '^CACHE_ROOT=/var/cache/owncord-client$' "$here/owncord-deb-update"
  check "cache root is a constant" $?
  grep -qE '^HELPER_PATH=/usr/lib/owncord-client/owncord-deb-update$' "$here/owncord-deb-update"
  check "helper path is a constant" $?
  grep -q 'PKEXEC_UID' "$here/owncord-deb-update"
  check "PKEXEC_UID is read" $?
}

for t in $(declare -F | awk '{print $3}' | grep '^test_'); do
  "$t"
done

echo "owncord-deb-update tests: $passes passed, $failures failed"
[ "$failures" -eq 0 ]
