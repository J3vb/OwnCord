//go:build !windows

package app

import (
	"log/slog"

	"golang.org/x/sys/unix"
)

// fileLimit is the soft/hard open-file limit pair rlimit(RLIMIT_NOFILE)
// carries. It is a plain struct so the platform get/set functions below — and
// the tests — need no syscall types.
type fileLimit struct {
	soft uint64
	hard uint64
}

// uncappedConnBudget is the connection count an uncapped server
// (server.max_ws_connections = 0) is budgeted for: the 2,000-online target.
const uncappedConnBudget = 2000

// getFileLimit and setFileLimit are the platform pair raiseFileLimit drives.
// They are package vars so a test can swap in a fake and exercise the raise
// without touching the test process's own descriptors.
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

// raiseFileLimit is the start-up step that lifts the process's soft open-file
// limit to the hard one and reports the result. A chat server holds one
// descriptor per WebSocket, so a host whose soft limit is the traditional
// 1,024 needs it raised to carry 2,000 connections; the hard limit is the
// ceiling the host already permits, and systemd's LimitNOFILE, a Docker
// ulimit, or the operator's own `ulimit -n` sets it.
//
// A raise the host refuses is only logged: the limit it already has may still
// be enough, and a server that refuses to serve because it could not grab more
// descriptors would be worse than one that serves until it runs out. maxConns
// is server.max_ws_connections (0 = unlimited, budgeted as the 2,000-online
// target); a resulting limit below the descriptors that many connections need
// is called out, since no amount of raising can fix a hard limit that is
// simply too low.
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
	// headroom and adds a fixed allowance for the database, LiveKit, TLS and
	// the rest of the process.
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
