package discordimport

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// live is every job running in this process, across Runners. A running job in
// the database that is not in it was left behind by a clean-up that never
// landed, and a new start may take it over. startMu makes "insert the job" and
// "register it" one step so a second start never sees a fresh job as left over.
var live = struct {
	startMu syncutil.Mutex
	mu      syncutil.Mutex
	ids     map[int64]struct{}
}{ids: map[int64]struct{}{}}

func liveJobIDs() []int64 {
	live.mu.Lock()
	defer live.mu.Unlock()
	ids := make([]int64, 0, len(live.ids))
	for id := range live.ids {
		ids = append(ids, id)
	}
	return ids
}

func setLive(id int64, on bool) {
	live.mu.Lock()
	defer live.mu.Unlock()
	if on {
		live.ids[id] = struct{}{}
	} else {
		delete(live.ids, id)
	}
}

// ErrServerStopped is the reason recorded on a job a shutdown cut short.
var ErrServerStopped = errors.New("the server stopped before the import finished")

// abandon ends an unfinished job and deletes its channel. A busy database is
// retried with a doubling wait; if every attempt fails the job stays running
// and the next start takes it over.
func (r *Runner) abandon(ctx context.Context, jobID, channelID int64, status, reason string, pr db.ImportProgress) {
	delay := r.retryDelay
	var err error
	for attempt := 1; attempt <= abandonAttempts; attempt++ {
		endCtx, cancel := context.WithTimeout(ctx, finishTimeout)
		err = r.cfg.Store.AbandonImport(endCtx, jobID, channelID, status, reason, pr)
		cancel()
		if err == nil || errors.Is(err, db.ErrNotFound) {
			return
		}
		if attempt < abandonAttempts {
			time.Sleep(delay)
			delay *= 2
		}
	}
	slog.Error("discord import clean-up failed", "job_id", jobID, "error", err)
}

// chunkOverdue reports whether the files copied for the open chunk have passed
// the byte budget or have waited too long for the chunk to commit.
func (r *Runner) chunkOverdue(st *runState) bool {
	if st.chunkBytes == 0 {
		return false
	}
	return r.cfg.ChunkBytes > 0 && st.chunkBytes >= r.cfg.ChunkBytes ||
		r.cfg.ChunkAge > 0 && time.Since(st.chunkSince) >= r.cfg.ChunkAge
}
