package admin

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

type fakeDiagStore struct {
	snapshot func(context.Context) (*db.DiagnosticSnapshot, error)
	names    func(context.Context) ([]string, error)
}

func (f fakeDiagStore) Diagnostics(ctx context.Context) (*db.DiagnosticSnapshot, error) {
	return f.snapshot(ctx)
}
func (f fakeDiagStore) DiagnosticNames(ctx context.Context) ([]string, error) { return f.names(ctx) }
func (f fakeDiagStore) LogAudit(context.Context, int64, string, string, int64, string) error {
	return nil
}

func degradedBundle(t *testing.T, store fakeDiagStore) map[string][]byte {
	t.Helper()
	logs := NewRingBuffer(50)
	logs.Write(LogEntry{Timestamp: time.Now().Format(time.RFC3339Nano), Level: "WARN", Message: "backup maintenance failed", Attrs: `{"err":"alicesmith could not be reached"}`})
	s := newSupportBundles(service.NewDiagnosticsService(store), "test", nil, logs, nil)
	s.snapshotBudget, s.namesBudget = 100*time.Millisecond, 100*time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	snap, err := s.collect(ctx)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	zr, err := zip.NewReader(bytes.NewReader(snap.bytes), int64(len(snap.bytes)))
	if err != nil {
		t.Fatal(err)
	}
	files := map[string][]byte{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, _ := io.ReadAll(rc)
		_ = rc.Close()
		files[f.Name] = data
	}
	return files
}

func okSnapshot(context.Context) (*db.DiagnosticSnapshot, error) {
	return &db.DiagnosticSnapshot{Migrations: []string{}}, nil
}
func okNames(context.Context) ([]string, error) { return []string{"alicesmith"}, nil }

func TestSupportBundle_SnapshotErrorDegradesDatabaseItem(t *testing.T) {
	files := degradedBundle(t, fakeDiagStore{
		snapshot: func(context.Context) (*db.DiagnosticSnapshot, error) { return nil, errors.New("disk I/O error") },
		names:    okNames,
	})
	if !strings.Contains(string(files["database.json"]), `"unavailable"`) {
		t.Fatalf("database.json = %s", files["database.json"])
	}
	for _, name := range []string{"build.json", "configuration.json", "health.json", "events.json", "manifest.json"} {
		if len(files[name]) == 0 {
			t.Fatalf("%s missing", name)
		}
	}
	if strings.Contains(string(files["events.json"]), "alicesmith") {
		t.Fatal("name leaked")
	}
}

func TestSupportBundle_NamesErrorDropsEventFreeText(t *testing.T) {
	files := degradedBundle(t, fakeDiagStore{
		snapshot: okSnapshot,
		names:    func(context.Context) ([]string, error) { return nil, errors.New("locked") },
	})
	events := string(files["events.json"])
	if strings.Contains(events, "alicesmith") || strings.Contains(events, `"detail"`) {
		t.Fatalf("events carry free text without names: %s", events)
	}
	if !strings.Contains(events, "backup_maintenance_failed") {
		t.Fatalf("event code lost: %s", events)
	}
	if strings.Contains(string(files["database.json"]), "unavailable") {
		t.Fatal("database should be available")
	}
}

func TestSupportBundle_BlockedSnapshotStillAnswersWithinBudget(t *testing.T) {
	start := time.Now()
	files := degradedBundle(t, fakeDiagStore{
		snapshot: func(ctx context.Context) (*db.DiagnosticSnapshot, error) {
			<-ctx.Done()
			return nil, ctx.Err()
		},
		names: okNames,
	})
	if time.Since(start) > 2*time.Second {
		t.Fatalf("took %v", time.Since(start))
	}
	if !strings.Contains(string(files["database.json"]), `"unavailable"`) || len(files["events.json"]) == 0 {
		t.Fatal("bundle not degraded as expected")
	}
}
