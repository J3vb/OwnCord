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

// startFileLimit is the start step that raises the process's soft open-file
// limit to its hard limit and reports the result. Every WebSocket holds a
// descriptor, so a host whose soft limit is the traditional 1,024 cannot hold
// a large community until this lifts it toward the hard limit the operator
// already permitted via systemd's LimitNOFILE or a container ulimit. It lives
// here rather than in lifecycle.go so the platform split owns the whole step.
func (a *App) startFileLimit() error {
	raiseFileLimit(a.log, a.cfg.Server.MaxWSConnections)
	return nil
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
// is server.max_ws_connections (0 = unlimited); when it is set, a resulting
// limit below the descriptors that many connections need is called out, since
// no amount of raising can fix a hard limit that is simply too low.
func raiseFileLimit(log *slog.Logger, maxConns int) {
	before, err := getFileLimit()
	if err != nil {
		log.Warn("could not read the open-file limit", "error", err)
		return
	}

	after := before
	raised := false
	if before.soft < before.hard {
		after.soft = before.hard
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

	// A server with a connection cap needs 2 descriptors per connection
	// (the socket and its accept/reuse bookkeeping) plus a fixed allowance for
	// the database, LiveKit, TLS and the rest of the process.
	if maxConns > 0 {
		needed := uint64(2*maxConns + 256)
		if after.soft < needed {
			log.Warn("open-file limit is below what server.max_ws_connections needs",
				"soft", after.soft, "needed", needed, "max_ws_connections", maxConns,
				"hint", "raise the hard limit with LimitNOFILE (systemd) or a ulimit for the container")
		}
	}
}
