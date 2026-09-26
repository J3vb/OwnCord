#!/usr/bin/env bash
# voice-load.sh — the 25-participant voice capacity harness (B6-9, workstream 14).
#
# BPR-030 promises 25 concurrent voice participants "backed by published
# measurements on stated hardware". k6 has no WebRTC stack, so the SFU half of
# that number comes from LiveKit's own `lk load-test` driven against the
# livekit-server OwnCord itself manages, while k6 drives the OwnCord
# join/leave/token path in the same run (scripts/k6/ws-load.js,
# voice_join_time). Neither half measures the other; docs/capacity.md says so.
#
# Usage:
#   LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... ./voice-load.sh
#   ./voice-load.sh --selftest    # parser assertions only; no SFU, no lk needed
#
# Environment:
#   LIVEKIT_URL      LiveKit HTTP/WS base            (default http://127.0.0.1:7880)
#   LIVEKIT_API_KEY  must match config.yaml voice.livekit_api_key
#   LIVEKIT_API_SECRET   ... and voice.livekit_api_secret
#   PUBLISHERS       audio publishers                (default 25)
#   SUBSCRIBERS      subscribers                     (default 25)
#   DURATION         steady-state duration           (default 60s)
#   LOSS_BUDGET      max packet loss percent, inclusive (default 1)
#   LIVEKIT_VERSION  SFU version recorded in the report (default 1.13.5)
#   REPORT           output path                     (default reports/voice-load.txt)
#
# WHY --layout 5x5 IS NOT OPTIONAL. `lk load-test` defaults to
# `--layout speaker`, and a simulated subscriber on that layout subscribes to
# roughly SIX tracks however many are published. A 25-publisher/25-subscriber
# room then reports "150/625" tracks at 0% packet loss, no errors and exit
# status 0 — a green run carrying under a quarter of the fan-out it claims to
# measure. Measured 2026-09-12 with lk 2.18.6 against livekit-server 1.13.5:
# `--layout speaker` gave 150/625 at 2.9mbps, `--layout 5x5` gave 625/625 at
# 12.0mbps. 5x5 is the smallest offered layout that covers 25 subscriptions.
#
# WHY THE OUTPUT IS PARSED AT ALL. `lk load-test` exits 0 whatever its tables
# say: a clean run, a fully lossy room and a room nobody subscribed to are all
# exit 0. An unparsed report is a green run that proves nothing — the
# bench-baseline.sh lesson, "a silently shorter baseline is worse than no
# baseline". So the Total row is read and asserted, and the tables are kept
# verbatim in the report because they are the published evidence.
set -euo pipefail

# The cell separator in lk's table output is U+2502 BOX DRAWINGS LIGHT
# VERTICAL. Built from its code point rather than pasted so this file stays
# ASCII and the byte is named instead of invisible.
SEP=$'│'

PUBLISHERS="${PUBLISHERS:-25}"
SUBSCRIBERS="${SUBSCRIBERS:-25}"
DURATION="${DURATION:-60s}"
LOSS_BUDGET="${LOSS_BUDGET:-1}"
LIVEKIT_VERSION="${LIVEKIT_VERSION:-1.13.5}" # ws.DefaultLiveKitVersion
LIVEKIT_URL="${LIVEKIT_URL:-http://127.0.0.1:7880}"
REPORT="${REPORT:-reports/voice-load.txt}"
ROOM="${ROOM:-capacity-$(date +%s)}"

fail() {
	echo "::error::voice-load: $*" >&2
	exit 1
}

# parse_total <file> — prints "<tracks_got> <tracks_want> <loss_pct> <errors>"
# from the Subscriber summaries table's Total row. Exit 3 when that row is
# absent, which is itself a failure: a run that produced no summary measured
# nothing.
#
# Column positions come from lk 2.18.6's table
# ("Tester | Tracks | Bitrate | Total Pkt. Loss | Error"); a leading separator
# makes field 1 empty, so Tester is field 2. Loss reads the parenthesised
# percent, because the absolute count ahead of it scales with run length.
parse_total() {
	sed -n '/^Subscriber summaries:/,$p' "$1" |
		sed "s/${SEP}/|/g" |
		awk -F'|' '
			$2 ~ /^[[:space:]]*Total[[:space:]]*$/ {
				tracks = $3; gsub(/[[:space:]]/, "", tracks)
				if (split(tracks, t, "/") != 2) { exit 4 }
				loss = $5; sub(/.*\(/, "", loss); sub(/%\).*/, "", loss)
				gsub(/[[:space:]]/, "", loss)
				errs = $6; gsub(/[[:space:]]/, "", errs)
				found = 1
				print t[1], t[2], loss, errs
				exit 0
			}
			END { if (!found) exit 3 }
		'
}

# assert_total <report> <expected_tracks> — the four assertions that give the
# run teeth. Every one of them passes on a broken room if left out.
assert_total() {
	local report=$1 want_tracks=$2 line got want loss errs
	if ! line=$(parse_total "$report"); then
		fail "no Total row in the subscriber summary — the run produced no measurement"
	fi
	read -r got want loss errs <<<"$line"

	# 1. The fan-out actually happened. This is the --layout trap above: a
	#    short subscription count is the difference between measuring 625
	#    streams and measuring 150 of them.
	[ "$want" = "$want_tracks" ] ||
		fail "expected $want_tracks subscribed tracks, table says $want — check --layout and the publisher count"
	[ "$got" = "$want" ] ||
		fail "only $got of $want tracks were received — the SFU did not carry the load it was asked to"

	# 2. No subscriber errored. The Total row's Error column is a count.
	[ "$errs" = "0" ] ||
		fail "$errs subscriber error(s) — see $report"

	# 3. Loss within budget. awk, not [ -gt ]: the percent is a float.
	awk -v l="$loss" -v b="$LOSS_BUDGET" 'BEGIN { exit !(l <= b) }' ||
		fail "packet loss ${loss}% exceeds the ${LOSS_BUDGET}% budget"

	echo "voice-load: ${got}/${want} tracks, ${loss}% loss, ${errs} errors — within budget"
}

# fixture <tracks> <loss> <errors> — a trimmed copy of real lk 2.18.6 output,
# rebuilt through $SEP so the separator normalisation is exercised too.
fixture() {
	printf 'Subscriber summaries:\n'
	printf '%s Tester %s Tracks %s Bitrate %s Total Pkt. Loss %s Error %s\n' \
		"$SEP" "$SEP" "$SEP" "$SEP" "$SEP" "$SEP"
	printf '%s Total  %s %s %s 12.0mbps %s %s %s %s %s\n' \
		"$SEP" "$SEP" "$1" "$SEP" "$SEP" "$2" "$SEP" "$3" "$SEP"
}

# rejects <report> <budget> — true when assert_total refuses the report.
#
# The subshell is load-bearing: assert_total reports through `fail`, which
# exits. Called directly, a negative case would terminate the selftest with
# the very exit it was checking for — and with its message swallowed by the
# redirect, so it would look like a silent failure. This cost one debugging
# round to notice.
rejects() {
	! (
		LOSS_BUDGET="$2" assert_total "$1" 625
	) >/dev/null 2>&1
}

# --selftest proves the assertions reject what they are meant to reject,
# without an SFU or the lk binary.
selftest() {
	local dir
	dir=$(mktemp -d)
	# shellcheck disable=SC2064 # expand dir now, not at trap time
	trap "rm -rf '$dir'" EXIT

	fixture "625/625" "0 (0%)" "0" >"$dir/clean.txt"
	fixture "150/625" "0 (0%)" "0" >"$dir/short.txt"
	fixture "625/625" "83 (1.9%)" "0" >"$dir/lossy.txt"
	fixture "625/625" "0 (0%)" "2" >"$dir/errored.txt"
	printf 'Track loading:\nnothing here\n' >"$dir/nosummary.txt"

	rejects "$dir/clean.txt" 1 &&
		fail "selftest: a clean 625/625 table was rejected"
	rejects "$dir/short.txt" 1 ||
		fail "selftest: 150/625 was accepted — the --layout trap would ship green"
	rejects "$dir/nosummary.txt" 1 ||
		fail "selftest: a report with no summary table was accepted"
	rejects "$dir/errored.txt" 1 ||
		fail "selftest: a run with 2 subscriber errors was accepted"
	rejects "$dir/lossy.txt" 0 ||
		fail "selftest: 1.9% loss was accepted against a 0% budget"
	rejects "$dir/lossy.txt" 2 &&
		fail "selftest: 1.9% loss was rejected against a 2% budget"

	echo "voice-load: selftest passed (6 assertions)"
}

if [ "${1:-}" = "--selftest" ]; then
	selftest
	exit 0
fi

command -v lk >/dev/null 2>&1 ||
	fail "lk (LiveKit CLI) not found. Install a release from
  https://github.com/livekit/livekit-cli/releases — 'go install' needs cgo and
  portaudio headers, which a clean Windows or CI image does not have."

if [ -z "${LIVEKIT_API_KEY:-}" ] || [ -z "${LIVEKIT_API_SECRET:-}" ]; then
	fail "LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set, and must match
  config.yaml's voice.livekit_api_key / voice.livekit_api_secret. OwnCord
  blanks the shipped dev credentials at load (config.go), which disables voice
  entirely — a run against those keys would measure nothing."
fi

# Fail fast on an SFU that is not there. Without this the run reports zero
# subscribers, which the assertions reject only after burning the whole
# duration.
probe="${LIVEKIT_URL/#ws:/http:}"
probe="${probe/#wss:/https:}"
curl -fsS -o /dev/null --max-time 10 "$probe" ||
	fail "no LiveKit at $probe — start the server (voice.auto_download_livekit
  or voice.livekit_binary) and confirm voice is enabled in its log."

mkdir -p "$(dirname "$REPORT")"

# Every subscriber subscribes to every publisher's track, so the room carries
# publishers x subscribers streams. That product is what BPR-030's "25
# concurrent voice" actually costs the SFU.
expected_tracks=$((PUBLISHERS * SUBSCRIBERS))

{
	echo "# OwnCord voice capacity run"
	echo "sfu_version: $LIVEKIT_VERSION"
	echo "lk_version: $(lk --version 2>&1 | head -1)"
	echo "url: $LIVEKIT_URL"
	echo "room: $ROOM"
	echo "audio_publishers: $PUBLISHERS"
	echo "subscribers: $SUBSCRIBERS"
	echo "layout: 5x5"
	echo "duration: $DURATION"
	echo "expected_tracks: $expected_tracks"
	echo "loss_budget_percent: $LOSS_BUDGET"
	echo
} >"$REPORT"

started=$SECONDS
lk load-test \
	--url "$LIVEKIT_URL" \
	--api-key "$LIVEKIT_API_KEY" \
	--api-secret "$LIVEKIT_API_SECRET" \
	--room "$ROOM" \
	--audio-publishers "$PUBLISHERS" \
	--subscribers "$SUBSCRIBERS" \
	--layout 5x5 \
	--num-per-second 10 \
	--duration "$DURATION" 2>&1 | tee -a "$REPORT"
elapsed=$((SECONDS - started))

# Wall clock minus the steady-state duration: the cohort's connect and
# teardown cost. NOT a percentile and NOT per-participant — --num-per-second 10
# means 50 participants take at least 5s to spawn before any join work starts,
# and lk publishes no per-participant join latency at all. docs/capacity.md
# reports the OwnCord half of the voice-join budget (voice_join -> voice_token,
# measured by k6) as the percentile, and this figure as context.
duration_seconds=$(awk -v d="$DURATION" 'BEGIN {
	if (d ~ /m$/)      { sub(/m$/, "", d); print d * 60 }
	else if (d ~ /s$/) { sub(/s$/, "", d); print d + 0 }
	else               { print d + 0 }
}')
connect_wall=$((elapsed - duration_seconds))
# Clamped rather than trusted: SECONDS has one-second granularity and lk's own
# teardown runs after the duration elapses, so a short run can measure fewer
# whole seconds than it asked for and produce a negative remainder.
if [ "$connect_wall" -lt 0 ]; then
	connect_wall=0
fi

{
	echo
	echo "wall_seconds: $elapsed"
	echo "connect_teardown_wall_seconds: $connect_wall  # ramp-inclusive, not a percentile"
} >>"$REPORT"

assert_total "$REPORT" "$expected_tracks"
echo "voice-load: report written to $REPORT"
