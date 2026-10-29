package discordimport

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// threeFileExport has three messages, each with a 10 byte local file.
func threeFileExport(t *testing.T) Export {
	t.Helper()
	var b strings.Builder
	b.WriteString(`{"channel":{"id":"7","name":"files"},"messages":[`)
	entries := make([]zipEntry, 0, 3)
	for i := range 3 {
		if i > 0 {
			b.WriteString(",")
		}
		fmt.Fprintf(&b, `{"id":"%d","type":"Default","timestamp":"2020-01-01T10:%02d:00+00:00","content":"m","author":{"id":"1","name":"a"},"attachments":[{"url":"f/%d.png","fileName":"%d.png"}]}`, i, i, i, i)
		entries = append(entries, zipEntry{name: fmt.Sprintf("f/%d.png", i), body: pngMagic + "xy"})
	}
	b.WriteString("]}")
	z, err := openZipBytes(t, buildZip(t, append([]zipEntry{{name: "e.json", body: b.String()}}, entries...)...), ZipLimits{})
	if err != nil {
		t.Fatal(err)
	}
	return z
}

// A chunk that sits open while files pile up as unlinked rows risks the orphan
// sweep taking them. The chunk is written early on bytes or on age.
func TestRun_ChunkFlushesEarlyOnAttachmentBytesOrAge(t *testing.T) {
	for name, tc := range map[string]struct {
		bytes  int64
		age    time.Duration
		chunks int
	}{
		"neither budget":     {chunks: 1},
		"byte budget passed": {bytes: 5, chunks: 3},
		"age passed":         {age: time.Nanosecond, chunks: 3},
	} {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t, 100)
			h.runner.cfg.ChunkBytes, h.runner.cfg.ChunkAge = tc.bytes, tc.age
			var chunks int
			h.runner.afterChunk = func(context.Context, int) { chunks++ }
			if _, res := h.run(threeFileExport(t)); res.Err != nil {
				t.Fatal(res.Err)
			}
			if chunks != tc.chunks {
				t.Errorf("chunks = %d, want %d", chunks, tc.chunks)
			}
		})
	}
}

// A server stopping is not an administrator cancelling.
func TestRun_ShutdownEndsTheJobFailedNotCancelled(t *testing.T) {
	h := newHarness(t, 2)
	group := syncutil.NewGroup(context.Background())
	h.runner.cfg.Group = group
	h.runner.afterChunk = func(c context.Context, _ int) {
		ctx, cancel := context.WithTimeout(c, 100*time.Millisecond)
		defer cancel()
		group.Stop(ctx, time.Millisecond)
	}
	job, res := h.run(h.fixtureZip())
	if res.Status != db.ImportFailed {
		t.Fatalf("status = %q, want failed", res.Status)
	}
	jr, _ := h.database.GetImportJob(context.Background(), job.ID)
	if jr.Status != db.ImportFailed || jr.Error == nil || *jr.Error != "the server stopped before the import finished" {
		t.Errorf("job row = %+v", jr)
	}
	if n := h.count(`SELECT COUNT(*) FROM channels`); n != 0 {
		t.Errorf("channels left: %d", n)
	}
}

// flakyAbandon fails the first n clean-up attempts.
type flakyAbandon struct {
	Store
	fail     int32
	attempts atomic.Int32
}

var errBusy = errors.New("database is busy")

func (f *flakyAbandon) AbandonImport(ctx context.Context, jobID, channelID int64, status, reason string, pr db.ImportProgress) error {
	if f.attempts.Add(1) <= f.fail {
		return errBusy
	}
	return f.Store.AbandonImport(ctx, jobID, channelID, status, reason, pr)
}

func TestRun_CleanUpIsRetriedWhenTheDatabaseIsBusy(t *testing.T) {
	h := newHarness(t, 2)
	h.runner.retryDelay = time.Millisecond
	flaky := &flakyAbandon{Store: h.database, fail: 2}
	h.runner.cfg.Store = flaky
	body := `{"channel":{"id":"7","name":"x"},"messages":[{"id":"1","type":"GuildMemberJoin","timestamp":"2020-01-01T10:00:00+00:00","author":{"id":"1","name":"a"}}]}`
	z, _ := openZipBytes(t, buildZip(t, zipEntry{name: "e.json", body: body}), ZipLimits{})
	job, res := h.run(z)
	if res.Status != db.ImportFailed {
		t.Fatalf("result = %+v", res)
	}
	if flaky.attempts.Load() != 3 {
		t.Errorf("clean-up attempts = %d, want 3", flaky.attempts.Load())
	}
	jr, _ := h.database.GetImportJob(context.Background(), job.ID)
	if jr.Status != db.ImportFailed {
		t.Errorf("job still %q after a retried clean-up", jr.Status)
	}
}

// If the clean-up never succeeds the job stays running, but the next import
// does not wait for a reboot: it takes the orphan over.
func TestStart_TakesOverAJobWhoseCleanUpNeverLanded(t *testing.T) {
	h := newHarness(t, 2)
	h.runner.retryDelay = time.Millisecond
	h.runner.cfg.Store = &flakyAbandon{Store: h.database, fail: 1000}
	body := `{"channel":{"id":"7","name":"x"},"messages":[{"id":"1","type":"GuildMemberJoin","timestamp":"2020-01-01T10:00:00+00:00","author":{"id":"1","name":"a"}}]}`
	z, _ := openZipBytes(t, buildZip(t, zipEntry{name: "e.json", body: body}), ZipLimits{})
	stuck, _ := h.run(z)
	jr, _ := h.database.GetImportJob(context.Background(), stuck.ID)
	if jr.Status != db.ImportRunning {
		t.Fatalf("setup: job is %q, want running", jr.Status)
	}

	h.runner.cfg.Store = h.database
	next, res := h.run(h.fixtureZip())
	if res.Err != nil {
		t.Fatalf("import after the orphan: %v", res.Err)
	}
	jr, _ = h.database.GetImportJob(context.Background(), stuck.ID)
	if jr.Status != db.ImportFailed {
		t.Errorf("orphan is %q, want failed", jr.Status)
	}
	if next.ID == stuck.ID {
		t.Error("same job")
	}
}
