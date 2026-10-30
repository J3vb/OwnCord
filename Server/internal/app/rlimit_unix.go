//go:build !windows

package app

import (
	"log/slog"

	"golang.org/x/sys/unix"
)

// fileLimit is the soft/hard open-file limit pair rlimit(RLIMIT_NOFILE)
// carries, a plain struct so the platform functions and tests need no syscall
// types.
type fileLimit struct {
	soft uint64
	hard uint64
}

// uncappedConnBudget is the connection count an uncapped server
// (server.max_ws_connections = 0) is budgeted for: the 2,000-online target.
const uncappedConnBudget = 2000

// getFileLimit and setFileLimit are the platform pair raiseFileLimit drives;
// package vars so a test can swap in a fake.
var (
	getFileLimit = realGetFileLimit
	setFileLimit = realSetFileLimit
)

func realGetFileLimit() (fileLimit, error) {
	var rl unix.Rlimit
	if err := unix.Getrlimit(unix.RLIMIT_NOFILE, &rl); err != nil {
		return fileLimit{}, err
	}
	return fileLimit{soft: rl.Cur, hard: rl.Max}, nil
}

func realSetFileLimit(l fileLimit) error {
	return unix.Setrlimit(unix.RLIMIT_NOFILE, &unix.Rlimit{Cur: l.soft, Max: l.hard})
}

// raiseFileLimit lifts the process's soft open-file limit to the hard one and
// reports the result; a chat server holds one descriptor per WebSocket. The Go
// runtime already lifts the soft limit to hard-1, so this is the last step; the
// hard limit (systemd LimitNOFILE, a Docker ulimit, the operator's `ulimit -n`)
// is the real ceiling.
//
// A raise the host refuses is only logged: the existing limit may suffice, and
// refusing to serve would be worse than serving until it runs out. maxConns is
// server.max_ws_connections (0 = budgeted as the 2,000-online target); a
// resulting limit below what that many connections need is called out, since
// raising cannot fix a hard limit that is too low.
func raiseFileLimit(log *slog.Logger, maxConns int) {
	before, err := getFileLimit()
	if err != nil {
		log.Warn("could not read the open-file limit", "error", err)
		return
	}

	after := before
	raised := false
	if target := maxSoftFileLimit(before.hard); before.soft < target {
		after.soft = target
		if err := setFileLimit(after); err != nil {
			log.Warn("could not raise the open-file limit", "error", err,
				"soft", before.soft, "hard", before.hard,
				"hint", "raise the hard limit with LimitNOFILE (systemd) or a ulimit for the container")
			after = before
		} else {
			raised = true
		}
	}
	log.Info("open-file limit", "soft", after.soft, "hard", after.hard, "raised_to_hard", raised)

	// Each connection holds one descriptor; the budget doubles that for
	// headroom and adds a fixed allowance for the database, LiveKit, TLS and the
	// rest of the process.
	budgetConns := maxConns
	if budgetConns <= 0 {
		budgetConns = uncappedConnBudget
	}
	needed := uint64(2*budgetConns + 256)
	if after.soft < needed {
		log.Warn("open-file limit is below the connection budget",
			"soft", after.soft, "needed", needed, "max_ws_connections", maxConns,
			"hint", "raise the hard limit with LimitNOFILE (systemd) or a ulimit for the container, or set server.max_ws_connections to what the limit carries")
	}
}
