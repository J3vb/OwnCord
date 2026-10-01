//go:build linux || darwin

package app

import (
	"bytes"
	"errors"
	"log/slog"
	"strings"
	"testing"
)

// stubFileLimit replaces the platform get/set pair with fakes backed by cur,
// restoring the real pair when the test ends. setErr, when non-nil, is what
// the fake set returns (so a failed raise can be exercised).
func stubFileLimit(t *testing.T, cur *fileLimit, setErr error) {
	t.Helper()
	prevGet, prevSet := getFileLimit, setFileLimit
	t.Cleanup(func() { getFileLimit, setFileLimit = prevGet, prevSet })
	getFileLimit = func() (fileLimit, error) { return *cur, nil }
	setFileLimit = func(l fileLimit) error {
		if setErr != nil {
			return setErr
		}
		*cur = l
		return nil
	}
}

func testLogger() (*slog.Logger, *bytes.Buffer) {
	var buf bytes.Buffer
	return slog.New(slog.NewTextHandler(&buf, nil)), &buf
}

// TestRaiseFileLimit_RaisesSoftToHard: the start-up step lifts the soft limit
// to the hard one, so a host with `ulimit -n 1024` and a high hard limit does
// not run out of descriptors at 2,000 connections. The hard limit stays under
// macOS's kern.maxfilesperproc so the raise reaches it on both platforms.
func TestRaiseFileLimit_RaisesSoftToHard(t *testing.T) {
	cur := fileLimit{soft: 1024, hard: 8192}
	stubFileLimit(t, &cur, nil)
	log, logs := testLogger()

	raiseFileLimit(log, 0)

	if cur.soft != 8192 {
		t.Fatalf("soft limit = %d, want it raised to the hard limit %d", cur.soft, cur.hard)
	}
	if !strings.Contains(logs.String(), "open-file limit") {
		t.Errorf("the resulting limit was not logged: %s", logs.String())
	}
}

// TestRaiseFileLimit_FailedSetOnlyLogs: a raise that the host refuses is an
// operational condition, never a reason to refuse to serve. The soft limit
// stays where it was and a warning names the failure.
func TestRaiseFileLimit_FailedSetOnlyLogs(t *testing.T) {
	cur := fileLimit{soft: 1024, hard: 1_048_576}
	stubFileLimit(t, &cur, errors.New("operation not permitted"))
	log, logs := testLogger()

	raiseFileLimit(log, 0)

	if cur.soft != 1024 {
		t.Fatalf("soft limit = %d, want it left at 1024 after a failed raise", cur.soft)
	}
	if !strings.Contains(logs.String(), "could not raise the open-file limit") {
		t.Errorf("a failed raise was not warned about: %s", logs.String())
	}
}

// TestRaiseFileLimit_AlreadyAtHardIsQuiet: the common container/systemd case
// (soft already equals hard) logs the limit and warns about nothing.
func TestRaiseFileLimit_AlreadyAtHardIsQuiet(t *testing.T) {
	cur := fileLimit{soft: 65_536, hard: 65_536}
	stubFileLimit(t, &cur, nil)
	log, logs := testLogger()

	raiseFileLimit(log, 0)

	if strings.Contains(logs.String(), "could not raise") || strings.Contains(logs.String(), "below the connection budget") {
		t.Errorf("an already-hard limit must not warn: %s", logs.String())
	}
	if !strings.Contains(logs.String(), "open-file limit") {
		t.Errorf("the resulting limit was not logged: %s", logs.String())
	}
}

// TestRaiseFileLimit_WarnsBelowTheConnectionBudget: with a cap set, a limit
// under 2×cap+256 is called out, because that server will hit EMFILE under
// load even after the soft limit is maximised.
func TestRaiseFileLimit_WarnsBelowTheConnectionBudget(t *testing.T) {
	cur := fileLimit{soft: 4096, hard: 4096}
	stubFileLimit(t, &cur, nil)
	log, logs := testLogger()

	raiseFileLimit(log, 2000) // needs 2*2000+256 = 4256

	if !strings.Contains(logs.String(), "below the connection budget") {
		t.Errorf("a limit under the connection budget was not warned about: %s", logs.String())
	}
}

// TestRaiseFileLimit_UncappedWarnsBelowTheTargetBudget: a plain
// `ulimit -n 1024` sets soft and hard alike, so nothing can be raised. With
// server.max_ws_connections unset (0 = unlimited) the server is budgeted for
// the 2,000-online target (2*2000+256 = 4256) and must warn rather than fall
// over silently at about 1,000 connections.
func TestRaiseFileLimit_UncappedWarnsBelowTheTargetBudget(t *testing.T) {
	cur := fileLimit{soft: 1024, hard: 1024}
	stubFileLimit(t, &cur, nil)
	log, logs := testLogger()

	raiseFileLimit(log, 0)

	out := logs.String()
	if !strings.Contains(out, "below the connection budget") || !strings.Contains(out, "needed=4256") {
		t.Errorf("an uncapped server at 1024 was not warned about the 2,000-online budget: %s", out)
	}
	if !strings.Contains(out, "server.max_ws_connections") || !strings.Contains(out, "LimitNOFILE") {
		t.Errorf("the warning does not name the setting and the fix: %s", out)
	}
}

// TestRaiseFileLimit_RealLimitRaisesCleanly: against the test process's own
// limits, the raise is one the host accepts. On macOS the default hard limit
// is unlimited, and a soft limit above kern.maxfilesperproc is refused, so an
// unclamped raise would warn on every boot.
func TestRaiseFileLimit_RealLimitRaisesCleanly(t *testing.T) {
	log, logs := testLogger()

	raiseFileLimit(log, 0)

	if strings.Contains(logs.String(), "could not") {
		t.Errorf("raising the real open-file limit failed: %s", logs.String())
	}
}
